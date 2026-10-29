import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rmdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { envSaid } from "./config";

/**
 * Where Settings › Model files' Delete puts a model file: never erased there, only moved, so that Put back is a move again.
 *
 * On Windows, into the drive's Recycle Bin, written by Afflatus itself: the file renamed to `$Recycle.Bin\<SID>\$R…` on its
 * own drive (a rename, at once, whatever its size) and its `$I…` entry written beside it (what Explorer reads: the file's
 * size, when it was deleted, where it was), so that Explorer lists it and its Restore puts it back. Windows' own delete
 * (SHFileOperation) was not used: asked for no dialog, it erases a file too big for the bin for good, without a word;
 * asked for its dialog, it opens one on the desktop of a server.
 *
 * Elsewhere, and on Windows whenever the bin would not take the file as Windows would keep it (its drive has no bin, the
 * bin is set to erase at once, it is full or the file bigger than its room), into the set-aside folder beside the model
 * folder (`.afflatus-set-aside`, on the same drive: a rename too), where neither ComfyUI nor the hashing looks.
 */

export type Place = "bin" | "aside";

export interface Moved {
  place: Place;
  /** Where the file is now. */
  stored: string;
  /** The bin's `$I` entry, for a file in the bin. */
  info: string | null;
  /** Why a file meant for the bin went to the set-aside folder instead (said to the user); null when it went where asked. */
  why: string | null;
}

/** A drive's Recycle Bin as Afflatus may write to it: its folder (`$Recycle.Bin\<SID>`), and the room it has left. */
export interface BinSpot {
  dir: string;
  /** Bytes the bin may still take before Windows erases its oldest items: its size limit less what is in it. */
  room: number;
}

/** How a file's bin is found: Windows' for the drive of `path`, or a stand-in (the tests'). Null: no bin takes it, and why. */
export type BinFinder = (path: string) => Promise<BinSpot | { none: string }>;

/** The set-aside folder's name, beside a model folder. */
export const ASIDE_DIR = ".afflatus-set-aside";

/**
 * One of Windows' own tools, by its full path: a `whoami` of Git for Windows, first on the PATH of a shell Afflatus was started
 * from, answers in its own way (and knows no SID).
 */
const run = (tool: string, args: string[]) =>
  new Promise<string>((done, fail) => execFile(join(envSaid.systemRoot() ??"C:\\Windows", "System32", `${tool}.exe`), args, { encoding: "utf8", timeout: 15_000, windowsHide: true }, (err, out) => (err ? fail(err) : done(out))));

/** The signed-in user's SID ("S-1-5-21-…"), read once: the bin folder of each drive is the user's own. */
let sid: Promise<string | null> | null = null;
const userSid = () => (sid ??= run("whoami", ["/user", "/fo", "csv", "/nh"]).then((out) => /"(S-1-[\d-]+)"/.exec(out)?.[1] ?? null, () => null));

/** A REG_DWORD of a key under HKCU, or null when it is not there. */
async function dword(key: string, name: string): Promise<number | null> {
  const out = await run("reg", ["query", key, "/v", name]).catch(() => "");
  const hex = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i").exec(out)?.[1];
  return hex ? parseInt(hex, 16) : null;
}

/**
 * What a bin folder holds, by the sizes its `$I` entries say (a deleted folder's too, which a walk of its `$R` would read
 * whole). An entry whose `$R` is gone is not counted: Explorer's Restore leaves the `$I` behind, and lists it no more.
 */
export async function binHolds(dir: string): Promise<number> {
  let total = 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  const held = new Set(names.filter((n) => n.startsWith("$R")).map((n) => n.slice(2)));
  for (const name of names) {
    if (!name.startsWith("$I") || !held.has(name.slice(2))) continue;
    const fh = await open(join(dir, name), "r").catch(() => null);
    if (!fh) continue;
    try {
      const b = Buffer.alloc(16);
      await fh.read(b, 0, 16, 0);
      total += Number(b.readBigInt64LE(8));
    } finally {
      await fh.close();
    }
  }
  return total;
}

/**
 * Windows' bin for a file: its drive's `$Recycle.Bin\<SID>` (made by Windows at a drive's first delete: a drive without one
 * is not written into), its size limit and whether it erases at once, as Explorer's settings keep them per volume (the
 * limit 5 % of the drive when never set, as Windows starts it at about that).
 */
export const windowsBin: BinFinder = async (path) => {
  const root = parse(resolve(path)).root;
  if (!/^[a-z]:\\$/i.test(root)) return { none: "it is not on a drive of this computer" };
  const id = await userSid();
  if (!id) return { none: "Windows did not say whose bin to use" };
  const dir = join(root, "$Recycle.Bin", id);
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return { none: `${root} has no Recycle Bin yet` };
  const guid = /Volume\{[0-9a-f-]+\}/i.exec(await run("mountvol", [root, "/L"]).catch(() => ""))?.[0];
  const key = guid ? `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\${guid.slice("Volume".length)}` : null;
  if (key && (await dword(key, "NukeOnDelete")) === 1) return { none: `${root}'s Recycle Bin is set to erase files at once` };
  const mb = key ? await dword(key, "MaxCapacity") : null;
  const fs = mb === null ? await statfs(root).catch(() => null) : null;
  const limit = mb !== null ? mb * 2 ** 20 : fs ? Math.floor(fs.blocks * fs.bsize * 0.05) : 0;
  return { dir, room: limit - (await binHolds(dir)) };
};

/** No bin at all: Linux, a Docker install, a Mac. Everything goes to the set-aside folder. */
export const noBin: BinFinder = async () => ({ none: "" });

/** The bin of this system: Windows' own, else none. */
export const systemBin: BinFinder = process.platform === "win32" ? windowsBin : noBin;

/** A `$I` entry as Windows 10 and 11 write one (version 2): the file's size, when it was deleted, the full path it had. */
export function binEntry(path: string, size: number, at = Date.now()): Buffer {
  const name = Buffer.from(`${path}\0`, "utf16le");
  const b = Buffer.alloc(28 + name.length);
  b.writeBigInt64LE(2n, 0);
  b.writeBigInt64LE(BigInt(size), 8);
  // a FILETIME: hundreds of nanoseconds since 1601
  b.writeBigInt64LE((BigInt(at) + 11_644_473_600_000n) * 10_000n, 16);
  b.writeUInt32LE(name.length / 2, 24);
  name.copy(b, 28);
  return b;
}

/** The six letters a bin entry's pair is named by ($R and $I), as Windows makes them. */
const binName = () => Array.from(randomBytes(6), (n) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[n % 36]).join("");

/** Whether `p` is `dir` itself or inside it. */
const within = (dir: string, p: string) => {
  const back = relative(resolve(dir), resolve(p));
  return back === "" || (!back.startsWith(`..${sep}`) && back !== ".." && !/^[a-z]:/i.test(back) && !back.startsWith(sep));
};

/**
 * The set-aside folder for a file of a model folder's directory `dir`: beside that directory (`models/.afflatus-set-aside`),
 * or higher up while that place is itself inside a model directory (`modelDirs`, every folder's): ComfyUI would list it.
 */
export function asideRoot(dir: string, modelDirs: readonly string[]): string {
  let up = dirname(resolve(dir));
  while (modelDirs.some((d) => within(d, up)) && dirname(up) !== up) up = dirname(up);
  return join(up, ASIDE_DIR);
}

/** A path not taken yet: `x.safetensors`, else `x (2).safetensors`, and on. */
async function free(path: string): Promise<string> {
  const ext = extname(path);
  for (let n = 1; ; n++) {
    const p = n === 1 ? path : `${path.slice(0, path.length - ext.length)} (${n})${ext}`;
    if (!(await stat(p).then(() => true, () => false))) return p;
  }
}

/**
 * A file moved out of its model folder: to the bin when asked and the bin takes it whole, else to the set-aside folder
 * (`aside`, under its model folder's name and its sub-folder, so it keeps its place). Throws when neither move can be made
 * (the set-aside folder on another drive than the file: a copy is not made of a file of many gigabytes).
 */
export async function moveOut(path: string, o: { want: Place; size: number; folder: string; file: string; aside: string; bin: BinFinder; at?: number }): Promise<Moved> {
  let why: string | null = null;
  if (o.want === "bin") {
    const spot = await o.bin(path).catch((err: Error) => ({ none: err.message }));
    if ("none" in spot) why = spot.none || null;
    else if (o.size > spot.room) why = "the Recycle Bin has no room for it (Windows would erase its oldest items)";
    else {
      const id = binName();
      const ext = extname(path);
      const stored = join(spot.dir, `$R${id}${ext}`);
      const info = join(spot.dir, `$I${id}${ext}`);
      try {
        await rename(path, stored);
      } catch (err) {
        // another drive mounted in a folder of this one: its bin is not this one's
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        why = "it is on a drive mounted in a folder";
      }
      if (!why) {
        try {
          await writeFile(info, binEntry(resolve(path), o.size, o.at));
        } catch (err) {
          // no entry, no file in the bin Explorer would list: back where it was
          await rename(stored, path).catch(() => {});
          throw err;
        }
        return { place: "bin", stored, info, why: null };
      }
    }
  }
  const target = await free(join(o.aside, o.folder, ...o.file.split(/[\\/]/)));
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(path, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") throw new Error(`${basename(path)} was left in place: the set-aside folder (${o.aside}) is on another drive.`);
    throw err;
  }
  return { place: "aside", stored: target, info: null, why: o.want === "bin" ? why ?? "" : null };
}

/** A file put back where it was: a move again. Refused when a file is there again. */
export async function moveBack(r: { stored: string; info: string | null; was: string }): Promise<void> {
  if (await stat(r.was).then(() => true, () => false)) throw new Error(`a file is at ${r.was} again: put back nothing over it`);
  await mkdir(dirname(r.was), { recursive: true });
  await rename(r.stored, r.was);
  if (r.info) await unlink(r.info).catch(() => {});
  await dropEmpty(dirname(r.stored));
}

/** A moved file erased for good (Empty), its bin entry with it. A file gone already counts as erased. */
export async function erase(r: { stored: string; info: string | null }): Promise<void> {
  await unlink(r.stored).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  if (r.info) await unlink(r.info).catch(() => {});
  await dropEmpty(dirname(r.stored));
}

/** The set-aside folder's sub-folders left empty, up to the set-aside folder itself (removed too once empty). A bin's folder is left. */
async function dropEmpty(dir: string): Promise<void> {
  if (!dir.split(/[\\/]/).includes(ASIDE_DIR)) return;
  for (let d = dir; ; d = dirname(d)) {
    if (!(await rmdir(d).then(() => true, () => false)) || basename(d) === ASIDE_DIR) return;
  }
}
