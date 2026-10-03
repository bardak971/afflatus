import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { extOf, mimeOfFile } from "./media";
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

export const LINKED = "linked:";
export const isLinked = (key: string) => key.startsWith(LINKED);
export const diskPath = (key: string) => key.slice(LINKED.length);
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export class LinkedError extends Error {
  statusCode = 400;
}

/** The files of Afflatus's own storage, and the files of linked folders, behind one door. */
export class RoutedStorage implements Storage {
  /** The directories that are linked: a "linked:" key is only ever read or written inside one of them. */
  roots: string[] = [];

  constructor(private readonly own: Storage) {}

  private file(key: string): string {
    const p = resolve(diskPath(key));
    if (!this.roots.some((r) => under(p, r))) throw new LinkedError("This file is in a folder that is not linked any more.");
    return p;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!isLinked(key)) return this.own.put(key, bytes);
    const p = this.file(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array> {
    return isLinked(key) ? new Uint8Array(await readFile(this.file(key))) : this.own.get(key);
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
export const diskSafe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 120);
/** The start of a text as a part of a file name: lower case, words joined by dashes. */
const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export class Linked {
  private scanning = new Map<string, Promise<{ files: number; folders: number }>>();

  constructor(private readonly db: Db, private readonly storage: RoutedStorage, private readonly events: EventEmitter) {}

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

  /** Link a directory: it becomes a folder at the top of the tree, and is read at once. */
  async link(path: string, name?: string): Promise<Folder> {
    const dir = resolve(path.trim());
    const there = await stat(dir).catch(() => null);
    if (!there?.isDirectory()) throw new LinkedError(`"${path}" is not a folder the computer Afflatus runs on can read.`);
    for (const f of await this.roots()) {
      const other = resolve(f.path!);
      if (under(dir, other) || under(other, dir)) throw new LinkedError(`This folder is already linked, or is inside or around "${f.name}", which is.`);
    }
    const row: Folder = { id: newId(), owner_id: OWNER, parent_id: null, name: (name?.trim() || basename(dir) || dir).slice(0, 120), path: dir, created_at: now() };
    await this.db.insertInto("folders").values(row).execute();
    await this.load();
    await this.scan(row.id);
    return row;
  }

  /** Stop showing a linked folder. Nothing on the disk is touched: only what Afflatus knew about it goes. */
  async unlink(rootId: string): Promise<void> {
    const root = await this.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst();
    if (!root?.path) throw new LinkedError("This folder is not linked to the disk.");
    const dir = resolve(root.path);
    const folders = (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), dir));
    const ids = folders.map((f) => f.id);
    const files = await this.db.selectFrom("assets").select(["id", "file_key", "thumb_key"]).where("folder_id", "in", ids).execute();
    for (const a of files) {
      if (isLinked(a.file_key)) await this.forget(a);
      // a result that was waiting there to be kept stays in the library, in no folder
      else await this.db.updateTable("assets").set({ folder_id: null }).where("id", "=", a.id).execute();
    }
    await this.db.deleteFrom("folders").where("id", "in", ids).execute();
    await this.load();
    this.events.emit("library");
  }

  private async forget(a: Pick<Asset, "id" | "thumb_key">): Promise<void> {
    if (a.thumb_key) await this.storage.delete(a.thumb_key).catch(() => {});
    await this.db.deleteFrom("generation_inputs").where("asset_id", "=", a.id).execute().catch(() => {});
    await this.db.deleteFrom("assets").where("id", "=", a.id).execute();
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
    if (!start?.path) throw new LinkedError("This folder is not linked to the disk.");
    const root = await this.rootOf(start);
    const dir = resolve(root.path!);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new LinkedError(`"${dir}" cannot be read: it was moved or deleted, or its disk is not there.`);

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
            sub = { id: newId(), owner_id: OWNER, parent_id: folder.id, name: e.name.slice(0, 120), path: full, created_at: now() };
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
          // changed since it was read: its small picture and what was measured of it are made again when it is next looked at
          if (had.bytes !== info.size || had.created_at !== made) {
            if (had.thumb_key) await this.storage.delete(had.thumb_key).catch(() => {});
            await this.db.updateTable("assets").set({ bytes: info.size, created_at: made, thumb_key: null, width: null, height: null, duration_ms: null }).where("id", "=", had.id).execute();
          }
          continue;
        }
        await this.db
          .insertInto("assets")
          .values({
            id: newId(), owner_id: OWNER, kind, origin: "uploaded", name: e.name.slice(0, 200), file_key: key, thumb_key: null, mime, bytes: info.size,
            // what is measured of it (its size in pixels, its length) is read when it is first looked at
            width: null, height: null, duration_ms: null, fps: null, has_sound: kind === "audio" ? 1 : 0,
            folder_id: folder.id, generation_id: null, kept_at: now(), deleted_at: null, linked_path: null, created_at: made,
          })
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
    if (!safe) throw new LinkedError("This name cannot be a folder's name on a disk.");
    const full = join(resolve(parent.path!), safe);
    if (await stat(full).catch(() => null)) throw new LinkedError(`There is already something called "${safe}" in that folder.`);
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
    throw new LinkedError("No free name was found for this file.");
  }

  /** What an item is called as a file: its own name when it has one, else the day it was made and the start of what was written to make it. */
  private async nameFor(a: Asset): Promise<string> {
    const ext = extOf(a.mime);
    if (a.name.trim()) {
      const safe = diskSafe(a.name);
      return /\.[A-Za-z0-9]{2,5}$/.test(safe) ? safe : `${safe}.${ext}`;
    }
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
