import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { loadConfig } from "./config";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { httpError } from "./errors";
import { extOf, mimeOfFile, newAssetRow } from "./media";
import type { Storage } from "./storage";

/**
 * Folders linked to a directory of the disk the server runs on (a mounted volume, in a container).
 * A linked folder shows what is in its directory, sub-directories included, and its files are used
 * where they are: nothing is copied into Afflatus's own storage. Its directory is read when it is
 * linked, when the server starts and when "Look again" is pressed; it is not watched.
 *
 * A linked file is an asset whose `file_key` is "linked:" and its path. Taking it to the bin moves the
 * file out of the directory into Afflatus's storage (so that it can be put back for a week); filing an
 * item of the library into a linked folder writes it there as a file with a readable name.
 */

const LINKED = "linked:";
export const isLinked = (key: string) => key.startsWith(LINKED);
const diskPath = (key: string) => key.slice(LINKED.length);
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Whether a directory may be linked at all, and why not when it may not. Linking serves everything under
 * the directory and writes into it, so the system's own directories are never linked: Windows, the program
 * folders, everything under a user's AppData, the root of a drive, the home directory itself (what is
 * in it is fine, folder by folder); on Linux and macOS the root, /etc, /usr, /bin, /sbin, /var and its
 * first level, /System and /Library. Nor Afflatus's own data folder (DATA_DIR) or ComfyUI's custom_nodes
 * (when ComfyUI's folder is known), or a folder around them. LINK_ROOTS, when set (directories separated
 * as PATH is), narrows linking to those directories and what is under them; a server that listens on more
 * than loopback (HOST) links nothing until it is set.
 */
export function whyNotLinkable(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir(), comfyDir = ""): string | null {
  const windows = platform === "win32";
  const norm = (p: string) => (windows ? p.toLowerCase() : p);
  const d = norm(resolve(dir));
  const root = norm(parse(resolve(dir)).root);
  if (d === root || d === root.replace(/[\\/]$/, "")) return "The root of a drive cannot be linked: pick a folder on it.";
  if (d === norm(resolve(home))) return "Your home folder itself cannot be linked: pick a folder inside it.";
  const inside = (p: string, top: string) => p === top || p.startsWith(top + sep);
  if (windows) {
    const rest = d.slice(root.length).replace(/^[\\/]+/, "");
    if (/^(windows|program files|program files \(x86\)|programdata)(\\|$)/.test(rest)) return "Windows's own folders and the program folders cannot be linked.";
    // a folder inside the temporary folder is scratch space, the one part of AppData no program runs or reads its settings from
    if (/^users\\[^\\]+\\appdata(\\|$)/.test(rest) && !/^users\\[^\\]+\\appdata\\local\\temp\\./.test(rest)) return "AppData holds your programs' settings and code: nothing in it can be linked.";
  } else {
    if (["/etc", "/usr", "/bin", "/sbin", "/System", "/Library"].some((top) => inside(d, top))) return "The system's own directories cannot be linked.";
    if (/^\/var(\/[^/]+)?$/.test(d)) return "/var holds the system's own files: link a folder further inside it, not /var itself.";
  }
  // linking either would let a file be written among Afflatus's own files or ComfyUI's code, or bin one of them
  const data = norm(loadConfig(env).dataDir);
  if (inside(d, data) || inside(data, d)) return "Afflatus's own data folder cannot be linked, nor a folder around it.";
  const nodes = comfyDir.trim() ? norm(resolve(comfyDir.trim(), "custom_nodes")) : "";
  if (nodes && (inside(d, nodes) || inside(nodes, d))) return "ComfyUI's custom_nodes folder holds code: it cannot be linked, nor a folder around it.";
  const roots = (env.LINK_ROOTS ?? "").split(delimiter).map((r) => r.trim()).filter(Boolean).map((r) => norm(resolve(r)));
  const host = loadConfig(env).host.toLowerCase();
  if (!roots.length && !LOOPBACK.has(host) && !host.startsWith("127.")) return "Afflatus listens on the network (HOST): set LINK_ROOTS to the folders that may be linked before linking one.";
  if (roots.length && !roots.some((r) => inside(d, r))) return `Linking is limited to the folders named in LINK_ROOTS (${roots.join(", ")}) and what is inside them.`;
  return null;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The files of Afflatus's own storage, and the files of linked folders, behind one door. */
export class RoutedStorage implements Storage {
  /** The directories that are linked: a "linked:" key is only ever read or written inside one of them. */
  roots: string[] = [];

  constructor(private readonly own: Storage) {}

  private file(key: string): string {
    const p = resolve(diskPath(key));
    if (!this.roots.some((r) => under(p, r))) throw httpError("This file is in a folder that is not linked any more.");
    return p;
  }
  // nothing is ever stored under a "linked:" key: a file goes into a linked directory by name, through Linked.into
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (isLinked(key)) throw httpError("A file is put into a linked folder by name, not by key.");
    return this.own.put(key, bytes);
  }
  async putFile(key: string, path: string): Promise<void> {
    if (isLinked(key)) throw httpError("A file is put into a linked folder by name, not by key.");
    return this.own.putFile(key, path);
  }
  async get(key: string): Promise<Uint8Array> {
    return isLinked(key) ? new Uint8Array(await readFile(this.file(key))) : this.own.get(key);
  }
  /** Where the file lies on disk, for ffmpeg to read it there rather than from memory. */
  localPath(key: string): string | null {
    return isLinked(key) ? this.file(key) : (this.own.localPath?.(key) ?? null);
  }
  async size(key: string): Promise<number> {
    return isLinked(key) ? (await stat(this.file(key))).size : this.own.size(key);
  }
  async open(key: string, range?: { start: number; end: number }): Promise<{ size: number; stream: Readable }> {
    if (!isLinked(key)) return this.own.open(key, range);
    const p = this.file(key);
    return { size: (await stat(p)).size, stream: createReadStream(p, range) as Readable };
  }
  async delete(key: string): Promise<void> {
    if (!isLinked(key)) return this.own.delete(key);
    await rm(this.file(key), { force: true });
  }
}

type Folder = Tables["folders"];
type Asset = Tables["assets"];

/** A name for a file on the disk: nothing a file system refuses, and no white space. */
const diskSafe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 120);
/** The start of a text as a part of a file name: lower case, words joined by dashes. */
const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export class Linked {
  private scanning = new Map<string, Promise<{ files: number; folders: number }>>();

  constructor(
    private readonly db: Db, private readonly storage: RoutedStorage, private readonly events: EventEmitter,
    /** Who holds what was derived from a file (film strips, motion, scenes): told when the file changed on the disk. */
    private readonly derived: { forgetDerived(assetId: string): Promise<void> } = { forgetDerived: async () => {} },
  ) {}

  /** The linked directories, as the storage needs them. Called at start and after every change. */
  async load(): Promise<void> {
    const rows = await this.db.selectFrom("folders").select("path").where("path", "is not", null).execute();
    this.storage.roots = rows.map((r) => resolve(r.path!));
  }

  /** Every linked folder that is not inside another linked folder. */
  async roots(): Promise<Folder[]> {
    const rows = await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute();
    return rows.filter((f) => !rows.some((p) => p.id === f.parent_id));
  }
  async rootOf(folder: Folder): Promise<Folder> {
    let at = folder;
    for (;;) {
      const parent: Folder | undefined = at.parent_id ? await this.db.selectFrom("folders").selectAll().where("id", "=", at.parent_id).executeTakeFirst() : undefined;
      if (!parent?.path) return at;
      at = parent;
    }
  }

  /** Link a directory: it becomes a folder at the top of the tree (of a project, or of the Inbox), and is read at once. */
  async link(path: string, name?: string, comfyDir = "", project: string | null = null): Promise<Folder> {
    if (project && !(await this.db.selectFrom("projects").select("id").where("id", "=", project).executeTakeFirst())) throw httpError("this project was not found", 404);
    const dir = resolve(path.trim());
    const there = await stat(dir).catch(() => null);
    if (!there?.isDirectory()) throw httpError(`"${path}" is not a folder the computer Afflatus runs on can read.`);
    const refused = whyNotLinkable(dir, process.env, process.platform, homedir(), comfyDir);
    if (refused) throw httpError(refused);
    for (const f of await this.roots()) {
      const other = resolve(f.path!);
      if (under(dir, other) || under(other, dir)) throw httpError(`This folder is already linked, or is inside or around "${f.name}", which is.`);
    }
    const row: Folder = { id: newId(), owner_id: OWNER, parent_id: null, name: (name?.trim() || basename(dir) || dir).slice(0, 120), path: dir, project_id: project, created_at: now() };
    await this.db.insertInto("folders").values(row).execute();
    await this.load();
    await this.scan(row.id);
    return row;
  }

  /**
   * Point a linked folder at where its directory is now (moved, or on a disk that came back under another letter): its
   * sub-folders and files keep their places in Afflatus (their timelines, their names, what they were filed with), only
   * their paths change; then the directory is read again, and what is not there any more goes as in any reading.
   */
  async relink(rootId: string, path: string, comfyDir = ""): Promise<Folder> {
    const root = await this.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst();
    if (!root?.path || (await this.rootOf(root)).id !== root.id) throw httpError("Only a folder that was linked itself can be linked again.");
    const old = resolve(root.path);
    const dir = resolve(path.trim());
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw httpError(`"${path}" is not a folder the computer Afflatus runs on can read.`);
    const refused = whyNotLinkable(dir, process.env, process.platform, homedir(), comfyDir);
    if (refused) throw httpError(refused);
    for (const f of await this.roots()) {
      if (f.id === root.id) continue;
      const other = resolve(f.path!);
      if (under(dir, other) || under(other, dir)) throw httpError(`This folder is already linked, or is inside or around "${f.name}", which is.`);
    }
    const moved = (p: string) => join(dir, relative(old, resolve(p)));
    await this.db.transaction().execute(async (tx) => {
      const folders = (await tx.selectFrom("folders").select(["id", "path"]).where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), old));
      for (const f of folders) await tx.updateTable("folders").set({ path: moved(f.path!) }).where("id", "=", f.id).execute();
      const files = (await tx.selectFrom("assets").select(["id", "file_key"]).where("file_key", "like", `${LINKED}%`).execute()).filter((a) => under(resolve(diskPath(a.file_key)), old));
      for (const a of files) await tx.updateTable("assets").set({ file_key: LINKED + moved(diskPath(a.file_key)) }).where("id", "=", a.id).execute();
      // a file taken to the bin goes back to the new place
      const binned = (await tx.selectFrom("assets").select(["id", "linked_path"]).where("linked_path", "is not", null).execute()).filter((a) => under(resolve(a.linked_path!), old));
      for (const a of binned) await tx.updateTable("assets").set({ linked_path: moved(a.linked_path!) }).where("id", "=", a.id).execute();
    });
    await this.load();
    await this.scan(root.id);
    return (await this.db.selectFrom("folders").selectAll().where("id", "=", root.id).executeTakeFirstOrThrow());
  }

  /** Stop showing a linked folder. Nothing on the disk is touched: only what Afflatus knew about it goes. */
  async unlink(rootId: string): Promise<void> {
    const root = await this.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst();
    if (!root?.path) throw httpError("This folder is not linked to the disk.");
    const dir = resolve(root.path);
    const folders = (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), dir));
    const ids = folders.map((f) => f.id);
    const files = await this.db.selectFrom("assets").select(["id", "file_key", "thumb_key"]).where("folder_id", "in", ids).execute();
    // all of it or none: a stop halfway would leave folders without their files, or files in folders that are gone
    await this.db.transaction().execute(async (tx) => {
      for (const a of files) {
        if (isLinked(a.file_key)) await this.forgetRow(a.id, tx);
        // a result that was waiting there to be kept stays in the library, in no folder
        else await tx.updateTable("assets").set({ folder_id: null }).where("id", "=", a.id).execute();
      }
      await tx.deleteFrom("folders").where("id", "in", ids).execute();
    });
    // the small pictures are Afflatus's own files: dropped once the rows are gone
    for (const a of files) if (isLinked(a.file_key) && a.thumb_key) await this.storage.delete(a.thumb_key).catch(() => {});
    await this.load();
    this.events.emit("library");
  }

  private async forget(a: Pick<Asset, "id" | "thumb_key">): Promise<void> {
    if (a.thumb_key) await this.storage.delete(a.thumb_key).catch(() => {});
    await this.forgetRow(a.id, this.db);
  }
  private async forgetRow(id: string, db: Db): Promise<void> {
    await db.deleteFrom("generation_inputs").where("asset_id", "=", id).execute();
    await db.deleteFrom("assets").where("id", "=", id).execute();
  }

  /** Read a linked folder's directory again: what is new appears, what is gone disappears. One reading at a time per folder. */
  scan(folderId: string): Promise<{ files: number; folders: number }> {
    const running = this.scanning.get(folderId);
    if (running) return running;
    const run = this.read(folderId).finally(() => this.scanning.delete(folderId));
    this.scanning.set(folderId, run);
    return run;
  }

  private async read(folderId: string): Promise<{ files: number; folders: number }> {
    const start = await this.db.selectFrom("folders").selectAll().where("id", "=", folderId).executeTakeFirst();
    if (!start?.path) throw httpError("This folder is not linked to the disk.");
    const root = await this.rootOf(start);
    const dir = resolve(root.path!);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw httpError(`"${dir}" cannot be read: it was moved or deleted, or its disk is not there.`);

    const knownFolders = (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), dir));
    const byPath = new Map(knownFolders.map((f) => [resolve(f.path!), f]));
    const knownFiles = await this.db.selectFrom("assets").select(["id", "file_key", "thumb_key", "bytes", "created_at"]).where("file_key", "like", `${LINKED}%`).execute();
    const byKey = new Map(knownFiles.filter((a) => under(resolve(diskPath(a.file_key)), dir)).map((a) => [a.file_key, a]));
    const seenFolders = new Set<string>([root.id]);
    const seenFiles = new Set<string>();
    let files = 0;

    const walk = async (at: string, folder: Folder): Promise<void> => {
      const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // hidden files and folders are not part of what is shown
        if (e.name.startsWith(".")) continue;
        const full = join(at, e.name);
        if (e.isDirectory()) {
          let sub = byPath.get(full);
          if (!sub) {
            // a sub-directory is in the project of the folder it is under
            sub = { id: newId(), owner_id: OWNER, parent_id: folder.id, name: e.name.slice(0, 120), path: full, project_id: folder.project_id, created_at: now() };
            await this.db.insertInto("folders").values(sub).execute();
            byPath.set(full, sub);
          }
          seenFolders.add(sub.id);
          await walk(full, sub);
          continue;
        }
        if (!e.isFile()) continue;
        const mime = mimeOfFile(e.name);
        const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;
        if (!kind) continue;
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        const key = LINKED + full;
        const made = info.mtime.toISOString();
        seenFiles.add(key);
        files++;
        const had = byKey.get(key);
        if (had) {
          // changed since it was read: its small picture, what was measured of it and what the timelines derived from it (strips,
          // motion, scenes: forgotten while the row still says how long the old file was) are made again when it is next looked at
          if (had.bytes !== info.size || had.created_at !== made) {
            if (had.thumb_key) await this.storage.delete(had.thumb_key).catch(() => {});
            await this.derived.forgetDerived(had.id).catch(() => {});
            await this.db.updateTable("assets").set({ bytes: info.size, created_at: made, thumb_key: null, width: null, height: null, duration_ms: null }).where("id", "=", had.id).execute();
          }
          continue;
        }
        await this.db
          .insertInto("assets")
          .values(newAssetRow({
            id: newId(), kind, origin: "uploaded", name: e.name.slice(0, 200), file_key: key, thumb_key: null, mime, bytes: info.size,
            // what is measured of it (its size in pixels, its length) is read when it is first looked at
            width: null, height: null, duration_ms: null, fps: null, has_sound: kind === "audio" ? 1 : 0,
            folder_id: folder.id, generation_id: null, kept_at: now(), linked_path: null, created_at: made,
          }))
          .execute();
      }
    };
    await walk(dir, root);

    // gone from the disk: gone from the folder (nothing of it is in Afflatus's storage but its small picture)
    for (const [key, a] of byKey) if (!seenFiles.has(key)) await this.forget(a);
    for (const f of knownFolders) {
      if (seenFolders.has(f.id)) continue;
      await this.db.updateTable("assets").set({ folder_id: null }).where("folder_id", "=", f.id).execute();
      await this.db.deleteFrom("folders").where("id", "=", f.id).execute();
    }
    await this.load();
    this.events.emit("library");
    return { files, folders: seenFolders.size - 1 };
  }

  /** Every linked folder read again: at start, in the background. */
  async scanAll(): Promise<void> {
    for (const root of await this.roots()) await this.scan(root.id).catch((err) => console.warn(`[linked] ${root.name}: ${(err as Error).message}`));
  }

  /** A new folder inside a linked one is a new directory. */
  async makeFolder(parent: Folder, name: string): Promise<string> {
    const safe = diskSafe(name);
    if (!safe) throw httpError("This name cannot be a folder's name on a disk.");
    const full = join(resolve(parent.path!), safe);
    if (await stat(full).catch(() => null)) throw httpError(`There is already something called "${safe}" in that folder.`);
    await mkdir(full);
    await this.load();
    return full;
  }

  /** A name nothing in the directory has yet: "name.png", then "name_02.png"… */
  private async free(dir: string, wanted: string): Promise<string> {
    const ext = extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length) || "file";
    for (let n = 1; n < 10_000; n++) {
      const full = join(dir, n === 1 ? `${stem}${ext}` : `${stem}_${String(n).padStart(2, "0")}${ext}`);
      if (!(await stat(full).catch(() => null))) return full;
    }
    throw httpError("No free name was found for this file.");
  }

  /** What an item is called as a file: its own name when it has one, else the day it was made and the start of what was written to make it. */
  private async nameFor(a: Asset): Promise<string> {
    const ext = extOf(a.mime);
    // the extension is the file's real type, whatever the name ends with: a picture is never written as a ".exe"
    const stem = diskSafe(a.name).replace(/\.[A-Za-z0-9]{1,8}$/, "");
    if (stem) return `${stem}.${ext}`;
    const g = a.generation_id ? await this.db.selectFrom("generations").select("inputs").where("id", "=", a.generation_id).executeTakeFirst() : undefined;
    const texts = g ? Object.values(JSON.parse(g.inputs) as Record<string, unknown>).filter((v): v is string => typeof v === "string" && /\s/.test(v.trim())) : [];
    const words = slug(texts[0] ?? "");
    return `${a.created_at.slice(0, 10)}${words ? `_${words}` : ""}.${ext}`;
  }

  /**
   * File an item into a linked folder: it becomes a file in that folder's directory. One of Afflatus's
   * own storage is written there under a readable name; one that is already a linked file is moved.
   */
  async into(a: Asset, folder: Folder): Promise<void> {
    const dir = resolve(folder.path!);
    if (isLinked(a.file_key)) {
      const from = resolve(diskPath(a.file_key));
      if (dirname(from) === dir) return;
      const to = await this.free(dir, basename(from));
      await rename(from, to).catch(async () => {
        // another disk: copied, then removed where it was
        await writeFile(to, await readFile(from));
        await rm(from, { force: true });
      });
      await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id }).where("id", "=", a.id).execute();
      return;
    }
    const to = await this.free(dir, await this.nameFor(a));
    await writeFile(to, await this.storage.get(a.file_key));
    await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id, kept_at: a.kept_at ?? now() }).where("id", "=", a.id).execute();
    await this.storage.delete(a.file_key).catch(() => {});
  }

  /** To the bin: the file leaves its directory and waits in Afflatus's storage, from where it can be put back. */
  async toBin(a: Asset): Promise<void> {
    const from = resolve(diskPath(a.file_key));
    const key = `assets/${a.id.slice(0, 2)}/${a.id}.${extOf(a.mime)}`;
    await this.storage.put(key, await this.storage.get(a.file_key));
    await this.db.updateTable("assets").set({ file_key: key, linked_path: from, deleted_at: now() }).where("id", "=", a.id).execute();
    await rm(from, { force: true });
  }

  /** Back from the bin: into the directory it was in when that is still there, else it stays in the library as an item of its own. */
  async restore(a: Asset): Promise<void> {
    const dir = a.linked_path ? dirname(a.linked_path) : null;
    const folder = dir ? (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).find((f) => resolve(f.path!) === dir) : undefined;
    if (!dir || !folder || !(await stat(dir).catch(() => null))?.isDirectory()) {
      await this.db.updateTable("assets").set({ deleted_at: null, linked_path: null, folder_id: null }).where("id", "=", a.id).execute();
      return;
    }
    const to = await this.free(dir, basename(a.linked_path!));
    await writeFile(to, await this.storage.get(a.file_key));
    await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id, linked_path: null, deleted_at: null }).where("id", "=", a.id).execute();
    await this.storage.delete(a.file_key).catch(() => {});
  }
}
