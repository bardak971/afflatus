import { constants, createReadStream, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { slug } from "@afflatus/core";
import { loadConfig, environment } from "./config";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { httpError } from "./errors";
import { extOf, mimeOfDiskFile, newAssetRow } from "./media";
import type { Storage } from "./storage";
import { missingFiles } from "./missingFiles";
import { inUse } from "./sweep";
import { oneAtATime } from "./keyedLock";

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
 * Whether a path names a network share (\\server\share, //server/share). On Windows even a stat of one makes the system
 * reach for the share over SMB, sending the account's credentials there and taking many seconds to fail: such a path is
 * refused before anything on the disk is asked about it.
 */
export const isNetworkPath = (path: string) => /^[\\/]{2}/.test(path.trim());
const NETWORK_REFUSED = "A network path (\\\\server\\share) cannot be used here: mount the share as a folder of this computer first, then use that folder.";

/**
 * whyNotLinkable on what the paths really are on the disk: a short name (PROGRA~1), a junction or a symbolic link leads
 * to a directory the text of the path does not show, so the directory, the home folder, the data folder, ComfyUI's
 * folder and LINK_ROOTS are each followed to their real place first. The text is checked as well, for a path that cannot
 * be followed. ComfyUI's folder on a network share is left as it is written (following it would reach for the share).
 */
export async function whyNotLinkableOnDisk(dir: string, comfyDir = "", env: NodeJS.ProcessEnv = environment()): Promise<string | null> {
  const real = (p: string) => realpath(resolve(p)).catch(() => resolve(p));
  const roots = (env.LINK_ROOTS ?? "").split(delimiter).map((r) => r.trim()).filter(Boolean);
  const onDisk: NodeJS.ProcessEnv = { ...env, DATA_DIR: await real(loadConfig(env).dataDir), ...(roots.length ? { LINK_ROOTS: (await Promise.all(roots.map((r) => (isNetworkPath(r) ? resolve(r) : real(r))))).join(delimiter) } : {}) };
  const comfy = comfyDir.trim() && !isNetworkPath(comfyDir) ? await real(comfyDir.trim()) : comfyDir;
  return whyNotLinkable(dir, env, process.platform, homedir(), comfyDir) ?? whyNotLinkable(await real(dir), onDisk, process.platform, await real(homedir()), comfy);
}

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
export function whyNotLinkable(dir: string, env: NodeJS.ProcessEnv = environment(), platform: NodeJS.Platform = process.platform, home: string = homedir(), comfyDir = ""): string | null {
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
  const roots = linkRoots(env).map((r) => norm(resolve(r)));
  const host = loadConfig(env).host.toLowerCase();
  if (!roots.length && !LOOPBACK.has(host) && !host.startsWith("127.")) return "Afflatus listens on the network (HOST): set LINK_ROOTS to the folders that may be linked before linking one.";
  if (roots.length && !roots.some((r) => inside(d, r))) return `Linking is limited to the folders named in LINK_ROOTS (${roots.join(", ")}) and what is inside them.`;
  return null;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const linkRoots = (env: NodeJS.ProcessEnv) => (env.LINK_ROOTS ?? "").split(delimiter).map((r) => r.trim()).filter(Boolean);

/**
 * Whether a request may link a folder from where it comes (`here`: hostCheck.ts fromThisComputer). Behind a proxy or a
 * tunnel on this same machine (Caddy, cloudflared, Tailscale serve) HOST stays loopback while every device reaches the
 * server, so the HOST rule above does not hold them back: another device links nothing until LINK_ROOTS names what it may.
 */
export function whyNotLinkableFrom(here: boolean, env: NodeJS.ProcessEnv = environment()): string | null {
  if (here || linkRoots(env).length) return null;
  return "A folder is linked from the computer Afflatus runs on: set LINK_ROOTS to the folders that may be linked to let other devices link them.";
}

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
  /**
   * The file's facts on the disk. A file a timeline still uses keeps its row when it leaves its directory (Linked.read):
   * asked for then, it is a 404 that says so, not a server error.
   */
  private async statOf(key: string) {
    const p = this.file(key);
    return stat(p).then((info) => {
      missingFiles.found(key);
      return info;
    }, (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        missingFiles.mark(key);
        throw httpError(`This file is not on the disk any more (${p}): it was moved, renamed or deleted. Put it back, or press Look again on its folder.`, 404);
      }
      throw err;
    });
  }
  // nothing is ever stored under a "linked:" key: a file goes into a linked directory by name, through Linked.into
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (isLinked(key)) throw httpError("A file is put into a linked folder by name, not by key.");
    this.unheld.delete(key);
    return this.own.put(key, bytes);
  }
  async putFile(key: string, path: string): Promise<void> {
    if (isLinked(key)) throw httpError("A file is put into a linked folder by name, not by key.");
    this.unheld.delete(key);
    return this.own.putFile(key, path);
  }
  async get(key: string): Promise<Uint8Array> {
    if (!isLinked(key)) return this.own.get(key);
    await this.statOf(key);
    return new Uint8Array(await readFile(this.file(key)));
  }
  /** Where the file lies on disk, for ffmpeg to read it there rather than from memory. */
  localPath(key: string): string | null {
    return isLinked(key) ? this.file(key) : (this.own.localPath?.(key) ?? null);
  }
  async size(key: string): Promise<number> {
    return isLinked(key) ? (await this.statOf(key)).size : this.own.size(key);
  }
  /** Of a file of a linked folder, which can change on the disk under the same key: its size and when it was last written. */
  async version(key: string): Promise<string | null> {
    if (!isLinked(key)) return null;
    const info = await this.statOf(key);
    return `${info.size}-${Math.round(info.mtimeMs)}`;
  }
  async open(key: string, range?: { start: number; end: number }): Promise<{ size: number; stream: Readable }> {
    if (!isLinked(key)) return this.own.open(key, range);
    const p = this.file(key);
    return { size: (await this.statOf(key)).size, stream: createReadStream(p, range) as Readable };
  }
  async delete(key: string): Promise<void> {
    if (isLinked(key)) {
      await rm(this.file(key), { force: true });
      return;
    }
    // a backup is being made: the file waits until it is done, so that the database it copied finds every file it names
    if (this.holds > 0) {
      this.unheld.add(key);
      return;
    }
    return this.own.delete(key);
  }
  list(prefix: string) {
    return this.own.list?.(prefix) ?? (async function* () {})();
  }

  private holds = 0;
  /** The files of Afflatus's own storage deleted while a backup was being made, deleted once it is done (unless written again since). */
  private readonly unheld = new Set<string>();
  /**
   * Hold every deletion of Afflatus's own files until the function answered is called: a backup copies the database, then
   * zips the files for minutes, and a file erased meanwhile (the hourly sweep, Empty the bin, a file put back into its
   * linked folder) would leave the copy naming a file the zip does not have.
   */
  hold(): () => Promise<void> {
    this.holds++;
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      if (--this.holds > 0) return;
      const keys = [...this.unheld];
      this.unheld.clear();
      for (const key of keys) await this.own.delete(key).catch(() => {});
    };
  }
}

type Folder = Tables["folders"];
type Asset = Tables["assets"];

/** A name for a file on the disk: nothing a file system refuses, and no white space. */
const diskSafe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 120);
/**
 * The name a file from the user's computer keeps on the disk: its own, without the folders a browser may
 * send with it, the characters a file system refuses, or leading dots (a hidden file is never read back).
 * Its own extension stays when a reading takes it for the same kind of file (a .mov stays a .mov, a .jpeg a .jpeg:
 * the bytes are still that container); one that says another kind, or none, becomes the extension of what it
 * really is. "." and ".." are refused: a name never leads out of the folder.
 */
export function uploadName(wanted: string, mime: string): string {
  const last = wanted.split(/[\\/]/).pop()?.trim() ?? "";
  if (last === "." || last === "..") throw httpError(`"${wanted}" is not a file name that can be written into a folder.`);
  let name = last.replace(/[:*?"<>|\u0000-\u001f]/g, "").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  const kind = (m: string) => m.split("/")[0];
  if (kind(mimeOfDiskFile(name)) !== kind(mime)) name = `${name.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "file"}.${extOf(mime)}`;
  const ext = extname(name);
  let stem = name.slice(0, name.length - ext.length).slice(0, 120).trim() || "file";
  // names Windows keeps for devices, whatever their extension
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `_${stem}`;
  return `${stem}${ext}`;
}

/** Why a file could not be written into a linked folder, said for the person who dropped it. */
function writeRefused(err: NodeJS.ErrnoException, folder: Folder, dir: string, name: string): Error {
  if (err.code === "ENOENT" || err.code === "ENOTDIR") return httpError(`"${folder.name}" is not on the disk any more (${dir}): it was moved or deleted, or its disk is not there. "${name}" was not imported.`);
  if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS") return httpError(`"${folder.name}" is read-only (${dir}): "${name}" was not written there, nor imported.`);
  if (err.code === "ENOSPC" || err.code === "EDQUOT") return httpError(`The disk of "${folder.name}" is full (${dir}): "${name}" was not written there, nor imported.`);
  return httpError(`"${name}" could not be written into ${dir}: ${err.message}. It was not imported.`);
}

/** The start of a text as a part of a file name: lower case, words joined by dashes, accents dropped ("Crème brûlée": "creme-brulee"). */

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
    if (isNetworkPath(path)) throw httpError(NETWORK_REFUSED);
    const dir = resolve(path.trim());
    const there = await stat(dir).catch(() => null);
    if (!there?.isDirectory()) throw httpError(`"${path}" is not a folder the computer Afflatus runs on can read.`);
    const refused = await whyNotLinkableOnDisk(dir, comfyDir);
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
    if (isNetworkPath(path)) throw httpError(NETWORK_REFUSED);
    const dir = resolve(path.trim());
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw httpError(`"${path}" is not a folder the computer Afflatus runs on can read.`);
    const refused = await whyNotLinkableOnDisk(dir, comfyDir);
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

  /**
   * Stop showing a linked folder. Nothing on the disk is touched: only what Afflatus knew about it goes. Refused while
   * something still uses one of its files (a timeline's take, a person's picture, a job to run): forgetting the file would
   * take that take off its timeline for good, and keeping it would leave a file in no linked folder, which cannot be read.
   */
  async unlink(rootId: string): Promise<void> {
    const root = await this.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst();
    if (!root?.path) throw httpError("This folder is not linked to the disk.");
    // not while a reading registers files into the folders it takes away
    await inTurnOf(this.db, [root.path], () => this.unlinkNow(root));
  }
  private async unlinkNow(root: Folder): Promise<void> {
    const dir = resolve(root.path!);
    const folders = (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), dir));
    const ids = folders.map((f) => f.id);
    const files = await this.db.selectFrom("assets").select(["id", "name", "file_key", "thumb_key"]).where("folder_id", "in", ids).execute();
    const used = await inUse(this.db, { undo: true });
    const needed = files.filter((a) => isLinked(a.file_key) && used.has(a.id));
    if (needed.length) {
      const first = needed[0]!;
      const more = needed.length > 1 ? ` and ${needed.length - 1} more of its files are` : " is";
      throw httpError(`"${first.name || basename(diskPath(first.file_key))}"${more} still used by ${used.get(first.id)}: "${root.name}" stays linked until they are taken out of there. If its directory moved, link it again where it is now instead.`, 409);
    }
    // all of it or none: a stop halfway would leave folders without their files, or files in folders that are gone
    await this.db.transaction().execute(async (tx) => {
      for (const a of files) {
        if (isLinked(a.file_key)) await this.forgetRows([a.id], tx);
        // a result that was waiting there to be kept stays in the library, in no folder
        else await tx.updateTable("assets").set({ folder_id: null }).where("id", "=", a.id).execute();
      }
      await tx.deleteFrom("folders").where("id", "in", ids).execute();
    });
    // the small pictures are Afflatus's own files: dropped once the rows are gone
    for (const a of files) if (isLinked(a.file_key) && a.thumb_key) await this.storage.delete(a.thumb_key).catch(() => {});
    await this.load();
    // folders gone, their files with them, the results that waited there in no folder now: every list is read
    this.events.emit("library");
  }

  private async forgetRows(ids: string[], db: Db): Promise<void> {
    await db.deleteFrom("generation_inputs").where("asset_id", "in", ids).execute();
    await db.deleteFrom("assets").where("id", "in", ids).execute();
  }

  /**
   * The rows of files gone from their directory forgotten, a slice at a time in one transaction each (one commit per file
   * held a reading of thousands for minutes). Only a row still as the reading found it goes: one taken to the bin, moved or
   * filed elsewhere since says another file_key or a deleted_at, and is the user's file still. Their small pictures after.
   */
  private async forgetGone(gone: Array<Pick<Asset, "id" | "file_key">>): Promise<void> {
    for (let i = 0; i < gone.length; i += SLICE) {
      const part = new Map(gone.slice(i, i + SLICE).map((a) => [a.id, a.file_key]));
      const forgotten = await this.db.transaction().execute(async (tx) => {
        const rows = await tx.selectFrom("assets").select(["id", "file_key", "thumb_key"]).where("id", "in", [...part.keys()]).where("deleted_at", "is", null).execute();
        const still = rows.filter((a) => part.get(a.id) === a.file_key);
        if (still.length) await this.forgetRows(still.map((a) => a.id), tx);
        return still;
      });
      for (const a of forgotten) if (a.thumb_key) await this.storage.delete(a.thumb_key).catch(() => {});
    }
  }

  /**
   * The files being dropped into a linked folder (importFile), by key, with when: a reading meanwhile leaves them to the
   * upload, which registers each once its small picture is made, rather than registering a second row (or half a file) itself.
   */
  private readonly arriving = new Map<string, number>();
  private isArriving(key: string): boolean {
    const at = this.arriving.get(key);
    if (at !== undefined && Date.now() - at < ARRIVING_MS) return true;
    this.arriving.delete(key);
    return false;
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
    // in the folder's turn: a file taken to the bin, put back or filed while the directory was walked was forgotten or registered twice
    return inTurnOf(this.db, [root.path!], () => this.readRoot(root));
  }

  private async readRoot(root: Folder): Promise<{ files: number; folders: number }> {
    const dir = resolve(root.path!);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw httpError(`"${dir}" cannot be read: it was moved or deleted, or its disk is not there.`);

    const knownFolders = (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).filter((f) => under(resolve(f.path!), dir));
    const byPath = new Map(knownFolders.map((f) => [resolve(f.path!), f]));
    const knownFiles = await this.db.selectFrom("assets").select(["id", "file_key", "thumb_key", "bytes", "created_at", "name", "folder_id"]).where("file_key", "like", `${LINKED}%`).execute();
    const byKey = new Map(knownFiles.filter((a) => under(resolve(diskPath(a.file_key)), dir)).map((a) => [a.file_key, a]));
    const seenFolders = new Set<string>([root.id]);
    const seenFiles = new Set<string>();
    // the directories that could not be listed (no permission for a moment, a share that hiccuped, too many files open): what
    // is under them is not known, which is not the same as gone, so nothing under them is forgotten
    const unknown: string[] = [];
    const inUnknown = (path: string) => unknown.some((u) => under(path, u));
    // the files not known yet, registered once the whole directory was read: one may be a known file renamed or moved
    const fresh: Array<{ full: string; name: string; folder: Folder; size: number; made: string; kind: "image" | "video" | "audio"; mime: string }> = [];
    let files = 0;

    const walk = async (at: string, folder: Folder): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(at, { withFileTypes: true });
      } catch (err) {
        // gone since its parent was listed: it is gone; anything else, it is there but cannot be read now
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") unknown.push(at);
        return;
      }
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
        const mime = mimeOfDiskFile(e.name);
        const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;
        if (!kind) continue;
        const key = LINKED + full;
        seenFiles.add(key);
        const info = await stat(full).catch(() => null);
        // listed but not readable for a moment: a file known by this name keeps its row, a new one waits for the next reading
        if (!info) continue;
        missingFiles.found(key);
        const made = info.mtime.toISOString();
        files++;
        const had = byKey.get(key);
        if (had) {
          // changed since it was read: its small picture, what was measured of it, what it holds (a paste of the old content was
          // found as this file by its digest) and what the timelines derived from it (strips, motion, scenes: forgotten while the
          // row still says how long the old file was) are made again when it is next looked at
          if (had.bytes !== info.size || had.created_at !== made) {
            if (had.thumb_key) await this.storage.delete(had.thumb_key).catch(() => {});
            await this.derived.forgetDerived(had.id).catch(() => {});
            await this.db.updateTable("assets").set({ bytes: info.size, created_at: made, thumb_key: null, width: null, height: null, duration_ms: null, digest: null }).where("id", "=", had.id).execute();
          }
          continue;
        }
        if (this.isArriving(key)) continue;
        fresh.push({ full, name: e.name, folder, size: info.size, made, kind, mime });
      }
    };
    await walk(dir, root);

    // not where they were: the known files not seen, but for those under a directory that could not be read
    const missing = [...byKey].filter(([key]) => !seenFiles.has(key) && !inUnknown(resolve(diskPath(key)))).map(([, a]) => a);
    const followed: Array<{ id: string; set: { file_key: string; name: string; folder_id: string } }> = [];
    const added: Array<ReturnType<typeof newAssetRow>> = [];
    for (const f of fresh) {
      // the same size and the same time of last writing as a file that went: that file, renamed or moved within the folder. Its
      // row follows it, with its id, and so do its name, its tags and the timeline takes that play it
      const same = missing.filter((a) => a.bytes === f.size && a.created_at === f.made);
      const was = same.find((a) => basename(diskPath(a.file_key)) === f.name) ?? same[0];
      if (was) {
        missing.splice(missing.indexOf(was), 1);
        // a name given in Afflatus stays; the file's own name follows the file
        const name = was.name === basename(diskPath(was.file_key)) ? f.name.slice(0, 200) : was.name;
        followed.push({ id: was.id, set: { file_key: LINKED + f.full, name, folder_id: f.folder.id } });
        continue;
      }
      added.push(newAssetRow({
        id: newId(), kind: f.kind, origin: "uploaded", name: f.name.slice(0, 200), file_key: LINKED + f.full, thumb_key: null, mime: f.mime, bytes: f.size,
        // what is measured of it (its size in pixels, its length) is read when it is first looked at
        width: null, height: null, duration_ms: null, fps: null, has_sound: f.kind === "audio" ? 1 : 0,
        folder_id: f.folder.id, generation_id: null, kept_at: now(), linked_path: null, created_at: f.made,
      }));
    }
    // a slice of rows per transaction, not a commit per file: linking ten thousand files made ten thousand commits (each an
    // fsync, and the search index's triggers) while the request waited and every other query of the app queued behind them
    for (let i = 0; i < Math.max(followed.length, added.length); i += SLICE) {
      const moves = followed.slice(i, i + SLICE);
      const rows = added.slice(i, i + SLICE);
      await this.db.transaction().execute(async (tx) => {
        for (const m of moves) await tx.updateTable("assets").set(m.set).where("id", "=", m.id).execute();
        if (rows.length) await tx.insertInto("assets").values(rows).execute();
      });
    }

    // gone from the disk: gone from the folder (nothing of it is in Afflatus's storage but its small picture). Unless something
    // still uses it (a timeline's take, a person's picture, a job to run): that row stays as it is, its file answered as not on
    // the disk, until the file comes back, a later reading finds it renamed, or the folder is linked again where it is now
    const used = missing.length ? await inUse(this.db, { undo: true }) : new Map<string, string>();
    const staying = new Set<string>();
    for (const a of missing) {
      if (!used.has(a.id)) continue;
      missingFiles.mark(a.file_key);
      if (a.folder_id) staying.add(a.folder_id);
    }
    await this.forgetGone(missing.filter((a) => !used.has(a.id)));
    // the folder of such a file stays too, and the folders around it, so that it is still found where it was
    const parentOf = new Map(knownFolders.map((f) => [f.id, f.parent_id]));
    for (const id of [...staying]) for (let at = parentOf.get(id); at; at = parentOf.get(at)) staying.add(at);
    for (const f of knownFolders) {
      if (seenFolders.has(f.id) || staying.has(f.id) || inUnknown(resolve(f.path!))) continue;
      await this.db.updateTable("assets").set({ folder_id: null }).where("folder_id", "=", f.id).execute();
      await this.db.deleteFrom("folders").where("id", "=", f.id).execute();
    }
    await this.load();
    // files came, went, moved or changed, folders were made or went: every list is read
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
    const words = slug(texts[0] ?? "", 40);
    return `${a.created_at.slice(0, 10)}${words ? `_${words}` : ""}.${ext}`;
  }

  /**
   * File an item into a linked folder: it becomes a file in that folder's directory. One of Afflatus's
   * own storage is written there under a readable name; one that is already a linked file is moved.
   */
  async into(item: Asset, folder: Folder): Promise<void> {
    const dir = resolve(folder.path!);
    await inTurnOf(this.db, isLinked(item.file_key) ? [dir, diskPath(item.file_key)] : [dir], async () => {
      // as it is when its turn comes: a reading may have followed it to another name meanwhile
      const a = await this.db.selectFrom("assets").selectAll().where("id", "=", item.id).executeTakeFirst();
      if (!a) throw httpError("This item is not in the library any more.", 404);
      await this.intoNow(a, dir, folder);
    });
  }
  private async intoNow(a: Asset, dir: string, folder: Folder): Promise<void> {
    if (isLinked(a.file_key)) {
      const from = resolve(diskPath(a.file_key));
      if (dirname(from) === dir) return;
      const to = await this.free(dir, basename(from));
      await rename(from, to).catch(async () => {
        // another disk: copied, then removed where it was
        await copyFile(from, to);
        await rm(from, { force: true });
      });
      await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id }).where("id", "=", a.id).execute();
      return;
    }
    const to = await this.free(dir, await this.nameFor(a));
    await writeOut(this.storage, a.file_key, to);
    await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id, kept_at: a.kept_at ?? now() }).where("id", "=", a.id).execute();
    await this.storage.delete(a.file_key).catch(() => {});
  }

  /**
   * A file from the user's computer dropped on a linked folder: copied into its directory under its own name, never
   * over another file ("name (2).png", "name (3).png"…). Answers what a reading of the directory would register it
   * with (its key, name, size and date), so that the row made from it now is the one the next reading finds. A
   * folder whose directory is gone, read-only or on a full disk refuses it, and nothing of it is left there.
   */
  async importFile(folder: Folder, from: string, wanted: string, mime: string): Promise<{ file_key: string; name: string; bytes: number; created_at: string; path: string }> {
    const dir = resolve(folder.path!);
    if (!this.storage.roots.some((r) => under(dir, r))) throw httpError(`"${folder.name}" is not linked any more.`);
    const name = uploadName(wanted, mime);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw writeRefused(Object.assign(new Error("gone"), { code: "ENOENT" }), folder, dir, name);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 10_000; n++) {
      const full = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      // the name never leads anywhere but into the folder itself
      if (dirname(full) !== dir) throw httpError(`"${wanted}" is not a file name that can be written into a folder.`);
      for (const [key, at] of this.arriving) if (Date.now() - at >= ARRIVING_MS) this.arriving.delete(key);
      this.arriving.set(LINKED + full, Date.now());
      try {
        // EXCL: a file that appeared there since is never written over, whoever made it
        await copyFile(from, full, constants.COPYFILE_EXCL);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        this.arriving.delete(LINKED + full);
        if (e.code === "EEXIST") continue;
        // a copy that failed half way (a full disk, a read error) leaves half a file: not to be read back as one
        await rm(full, { force: true }).catch(() => {});
        throw writeRefused(e, folder, dir, name);
      }
      const info = await stat(full);
      return { file_key: LINKED + full, name: basename(full), bytes: info.size, created_at: info.mtime.toISOString(), path: full };
    }
    throw httpError("No free name was found for this file.");
  }

  /** To the bin: the file leaves its directory and waits in Afflatus's storage, from where it can be put back. */
  async toBin(a: Asset): Promise<void> {
    await linkedToBin(this.db, this.storage, a);
  }

  /** Back from the bin: into the directory it was in when that is still there, else it stays in the library as an item of its own. */
  async restore(item: Asset): Promise<void> {
    if (!item.linked_path) return this.restoreNow(item);
    await inTurnOf(this.db, [item.linked_path], async () => {
      const a = await this.db.selectFrom("assets").selectAll().where("id", "=", item.id).executeTakeFirst();
      // put back already (two Put back at once), or erased meanwhile by an Empty the bin
      if (!a?.deleted_at || !a.linked_path) return;
      await this.restoreNow(a);
    });
  }
  private async restoreNow(a: Asset): Promise<void> {
    const dir = a.linked_path ? dirname(a.linked_path) : null;
    const folder = dir ? (await this.db.selectFrom("folders").selectAll().where("path", "is not", null).execute()).find((f) => resolve(f.path!) === dir) : undefined;
    if (!dir || !folder || !(await stat(dir).catch(() => null))?.isDirectory()) {
      await this.db.updateTable("assets").set({ deleted_at: null, linked_path: null, folder_id: null }).where("id", "=", a.id).execute();
      return;
    }
    const to = await this.free(dir, basename(a.linked_path!));
    await writeOut(this.storage, a.file_key, to);
    await this.db.updateTable("assets").set({ file_key: LINKED + to, name: basename(to), folder_id: folder.id, linked_path: null, deleted_at: null }).where("id", "=", a.id).execute();
    await this.storage.delete(a.file_key).catch(() => {});
  }
}

/**
 * A stored file written out to `to` on the disk: copied there by the file system when the storage has it on this disk, else
 * written from its bytes. Read whole into memory first, a 515 MB video moved into a linked folder held 521 MB more. Written
 * under a hidden name beside it (a reading skips it) and renamed once whole: a copy that failed half way (a full disk, a
 * read error) left half a file in the user's folder, which the next reading registered as an item.
 */
async function writeOut(storage: Storage, key: string, to: string): Promise<void> {
  const part = join(dirname(to), `.${basename(to)}.part`);
  try {
    const path = storage.localPath?.(key);
    if (path) await copyFile(path, part);
    else await writeFile(part, await storage.get(key));
    await rename(part, to);
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

/** Rows written per transaction by a reading of a linked folder. */
const SLICE = 200;
/** How long a file dropped into a linked folder is left to its upload to register (its small picture is made first). */
const ARRIVING_MS = 10 * 60_000;

/**
 * Work in the turn of the linked folders the paths are in, one at a time per folder linked (keyedLock.ts). A reading lists
 * the files it knows, then walks the disk for seconds or minutes: a file taken to the bin in between was not found by the
 * walk, and its row was forgotten with the bin copy only that row named, the user's file already gone from the folder; one
 * put back or filed there meanwhile was registered a second time. Readings and the moves of linked files take turns.
 * Several folders (a file moved from one to another) are taken in one order everywhere, so two moves never wait on each other.
 */
async function inTurnOf<T>(db: Db, paths: string[], work: () => Promise<T>): Promise<T> {
  const linked = await db.selectFrom("folders").select(["id", "parent_id", "path"]).where("path", "is not", null).execute();
  const tops = linked.filter((f) => !linked.some((p) => p.id === f.parent_id)).map((f) => resolve(f.path!));
  const keys = [...new Set(paths.map((p) => tops.find((t) => under(resolve(p), t)) ?? resolve(p)))].sort();
  return keys.reduceRight<() => Promise<T>>((next, key) => () => oneAtATime(db, `linked:${key}`, next), work)();
}

/**
 * A file of a linked folder to the bin: copied into Afflatus's storage, its row changed to name that copy, and only then
 * removed from its directory. A stop between any two steps loses nothing: before the row is written the file is in its
 * folder and the row names it there; after, the row names the bin's copy, the file at worst still in its folder too (the
 * next reading registers it again). Removing it first, a stop before the row was written left a row naming a file gone:
 * the next reading forgot it, and the orphan sweep erased the bin's copy that nothing named any more (card #186). A file
 * another program holds open (Windows refuses to remove it) is left as it was, its row named it in its folder again and
 * the copy dropped. Also for a video taken apart by a cut (timelineRange.ts).
 */
export async function linkedToBin(db: Db, storage: Storage, item: Pick<Asset, "id" | "mime" | "file_key">): Promise<void> {
  await inTurnOf(db, [diskPath(item.file_key)], async () => {
    // as it is when its turn comes: a reading may have followed it to another name meanwhile
    const a = await db.selectFrom("assets").select(["id", "mime", "file_key", "deleted_at"]).where("id", "=", item.id).executeTakeFirst();
    if (!a || a.deleted_at || !isLinked(a.file_key)) throw httpError("This file is not in its folder any more: press Look again on its folder.", 409);
    await toBinNow(db, storage, a);
  });
}
async function toBinNow(db: Db, storage: Storage, a: Pick<Asset, "id" | "mime" | "file_key">): Promise<void> {
  const from = resolve(diskPath(a.file_key));
  const key = `assets/${a.id.slice(0, 2)}/${a.id}.${extOf(a.mime)}`;
  const path = storage.localPath?.(a.file_key);
  if (path) await storage.putFile(key, path);
  else await storage.put(key, await storage.get(a.file_key));
  try {
    await db.updateTable("assets").set({ file_key: key, linked_path: from, deleted_at: now() }).where("id", "=", a.id).execute();
  } catch (err) {
    // the row still names the file in its folder, which has not been touched: only the copy goes
    await storage.delete(key).catch(() => {});
    throw err;
  }
  try {
    await rm(from, { force: true });
  } catch (err) {
    // removed after all (a refusal reported late): the row says where the file is now, the bin
    if (!(await stat(from).then(() => true, () => false))) return;
    // still in its folder: its row names it there again (failing that, the bin's copy stays named by the row, the file
    // in its folder as well, found again by the next reading), and the copy goes
    const back = await db.updateTable("assets").set({ file_key: a.file_key, linked_path: null, deleted_at: null }).where("id", "=", a.id).execute().then(() => true, () => false);
    if (back) await storage.delete(key).catch(() => {});
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw httpError(`"${basename(from)}" is open in another program, or read-only: close it there, then try again. It stays in its folder.`, 409);
    throw err;
  }
}
