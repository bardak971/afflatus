import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { civitaiGet, civitaiVersionsByHash, type ApiVersion } from "./civitai";
import { now } from "./db";
import { findOnHuggingFace, huggingFaceSha256 } from "./huggingface";
import { fileName } from "./media";
import { MODEL_EXT, FULL_MODEL_FOLDERS } from "@afflatus/core";
import { inBinOrAside } from "./modelBin";
import { modelDirsSaid } from "./modelFiles";
import type { Services } from "./services";
import { ownMachines, readSettings } from "./settings";

/**
 * Every model file of this computer's ComfyUI, hashed once (its SHA-256), so that the sites can say which file it is
 * whatever it is called: Civitai by the hash itself (all of them in one request), Hugging Face by the file's name and
 * then the hash it lists for that file (it has no search by hash). What is found is the file's source for a rented pod
 * (podSources.ts) and its version for the update check. Hashing reads every file once: in the background, from the
 * start of Afflatus, every hour after (a file added or replaced since), and on the user's "Hash now", paused while this
 * computer renders (the disk is the render's).
 */

/** The folders whose files are hashed: the model folders a pod is sent files of. */
export const HASHED_FOLDERS = FULL_MODEL_FOLDERS;
/** A file matched to nothing is asked about again after this long (a site may have it since). */
const ASK_AGAIN_MS = 7 * 24 * 60 * 60_000;
/** The LoRAs whose Civitai base model is asked in one pass, one at a time: a library of a thousand is read over a few hours. */
const BASES_A_PASS = 200;
/** While a render runs here, how often the hashing looks whether it may go on. */
const PAUSE_MS = 2_000;
/** How long a close waits for a hashing pass to end before it goes on without it. */
const STOP_WAIT_MS = 3_000;

/**
 * The hashing itself, in a worker thread: SHA-256 over a model file on the server's own thread kept it 46 to 50 % busy and
 * every request 10 to 15 ms late while a pass ran (the 2026-10-15 performance review). One file at a time: `{ path }`
 * starts one, `{ pause }` and `{ resume }` hold it while this computer renders; it says `{ bytes }` as it reads and
 * `{ sha256 }` (null: the file could not be read) at the end. A string run with `eval`, as sqliteWorker.ts's is, so that
 * the same source works under tsx, vitest and the release's single bundled file.
 */
const HASHER = String.raw`
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
let stream = null;
let paused = false;
parentPort.on("message", (m) => {
  if (m.pause) { paused = true; stream?.pause(); return; }
  if (m.resume) { paused = false; stream?.resume(); return; }
  const hash = createHash("sha256");
  const s = createReadStream(m.path, { highWaterMark: 4 * 2 ** 20 });
  stream = s;
  if (paused) s.pause();
  s.on("data", (d) => { hash.update(d); parentPort.postMessage({ bytes: d.length }); });
  s.on("end", () => { stream = null; parentPort.postMessage({ sha256: hash.digest("hex").toUpperCase() }); });
  s.on("error", () => { stream = null; parentPort.postMessage({ sha256: null }); });
});
`;

export interface HashStatus {
  /** Model files found in this computer's ComfyUI folders. */
  files: number;
  hashed: number;
  /** The file being hashed now, how far. */
  hashing: { folder: string; file: string; bytes: number; total: number } | null;
  /** Waiting for this computer's render to end. */
  paused: boolean;
  /** What the sites said: a Civitai version, a Hugging Face file, neither (asked), not asked yet. */
  civitai: number;
  huggingFace: number;
  nowhere: number;
  /** No ComfyUI folder on this computer (Settings › ComfyUI): nothing can be hashed. */
  noFolder: boolean;
  /** A pass looked at the folders since Afflatus started (before, the counts are what was kept). */
  looked: boolean;
  /** Why the last pass stopped short, when it did. */
  error: string | null;
}

export interface Found {
  folder: string;
  /** As ComfyUI lists it: its sub-folder and name, with forward slashes. */
  file: string;
  path: string;
  size: number;
  mtime: number;
  /** The file on disk itself (identityOf): two places with the same one are one file, not a copy of it. */
  identity: string;
  /** Its bytes on disk (identityOf): the hard links of one file share them, and are hashed once. */
  inode: string;
  /**
   * Another file holds its name in an earlier directory of the folder (models/loras before A1111's Lora): ComfyUI loads
   * that one by the name, never this one. What is kept by name (model_hashes, uses, what presets need) is the other's;
   * this one's hash is kept by its path (model_hash_places), and Delete moves it only when asked by its path.
   */
  shadowed: boolean;
  /**
   * A symbolic link to a file: ComfyUI loads the file through it by its name (os.path.isfile follows it), so it takes the
   * name and is listed with the file's own size, date and identity (one file with the place it is linked from). Delete
   * never moves a link (modelLibrary.ts): it would move the link, not the file.
   */
  link?: boolean;
}

/** A path as one place on disk, whatever folder it is reached through (junctions, links resolved), for comparing. */
const realOf = (path: string) => realpath(path).then((p) => (process.platform === "win32" ? p.toLowerCase() : p), () => null);

/**
 * Which file on disk a path is, whatever folder it is reached through: its volume and file index (`dev` and `ino`, read
 * as bigints, which NTFS fills on Windows as other systems do), else, on a file system that gives no index, its real path.
 * extra_model_paths.yaml may list one folder twice (the owner's named A1111's Stable-diffusion for checkpoints and its
 * Krea2 sub-folder for diffusion_models), and ComfyUI reads models/unet as diffusion_models: the same file then shows in
 * two places with the same sha256, and taken for two copies one was deleted as the "extra" one (card #164, 85 GB lost).
 *
 * A file with hard links (A1111's and ComfyUI's folders linked file by file) is one index under several names: each name
 * is its own place (its real path), since a Delete moves one name and the others still hold the file (folded into one
 * row, the Delete said the file gone from them too). `inode` stays the index: the bytes are the same, hashed once.
 */
export async function identityOf(path: string, st: { dev: bigint; ino: bigint; nlink: bigint }): Promise<{ identity: string; inode: string }> {
  const real = st.ino === 0n || st.nlink > 1n ? `path:${(await realOf(path)) ?? path}` : null;
  const inode = st.ino !== 0n ? `${st.dev}:${st.ino}` : real!;
  return { identity: real ?? inode, inode };
}

/** A bigint stat's date as a plain stat's `Math.round(mtimeMs)`: kept dates and the pod's check compare with that one. */
export const msOf = (ns: bigint) => Math.round(Number(ns / 1000n) / 1000);

/**
 * The model files under a folder's directories, sub-folders included, and whether every directory of it could be read: a
 * drive away or a folder refused lists nothing, which is not the same as its files being gone.
 *
 * Never the files Delete moved: the set-aside folder and a drive's Recycle Bin are not walked, by where a directory really
 * is. A junction to a folder above a model folder (models/checkpoints/a1111 → A1111's models) reaches the set-aside folder
 * made beside that model folder: its file, listed, was "a copy that stays" of the one moved there, and Empty erased that
 * only copy (card #185). Nor a directory the walk is inside already (a junction to its own parent), walked for ever else.
 *
 * Two files with one volume and file index but another size or date are two files all the same: ReFS (a Dev Drive) says
 * its 64-bit index may repeat, and some network or FUSE mounts give one to several files. Taken as one, the second vanished
 * into the first one's row, a Delete said it gone too, and it was given the first one's hash (a pod sent the wrong bytes):
 * each is then told by its real path.
 */
export async function filesIn(dirs: string[], folder: string): Promise<{ files: Found[]; whole: boolean }> {
  const seen: Array<Omit<Found, "identity" | "inode" | "shadowed">> = [];
  const stats: Array<{ dev: bigint; ino: bigint; nlink: bigint }> = [];
  let whole = true;
  const walk = async (root: string, dir: string, depth: number, inside: string[]): Promise<void> => {
    if (depth > 6) return;
    const real = await realOf(dir);
    if (real && (inBinOrAside(real) || inside.includes(real))) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      whole = false;
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      // a folder linked in (a junction, a directory symlink) is walked as ComfyUI walks it (os.walk, followlinks): what it
      // holds may be listed elsewhere too, one file on disk then seen in two places (identity). A link to a file holds its
      // name as ComfyUI reads it (a link leading nowhere does not)
      const target = e.isSymbolicLink() ? await stat(path, { bigint: true }).catch(() => null) : null;
      if (e.isDirectory() || target?.isDirectory()) await walk(root, path, depth + 1, real ? [...inside, real] : inside);
      else if ((e.isFile() || target?.isFile()) && MODEL_EXT.test(e.name)) {
        const st = target ?? await stat(path, { bigint: true }).catch(() => null);
        if (!st) continue;
        const file = relative(root, path).replace(/\\/g, "/");
        seen.push({ folder, file, path, size: Number(st.size), mtime: msOf(st.mtimeNs), ...(target ? { link: true } : {}) });
        stats.push(st);
      }
    }
  };
  for (const d of dirs) await walk(d, d, 0, []);
  const ids: Array<{ identity: string; inode: string }> = [];
  for (const [i, f] of seen.entries()) ids.push(await identityOf(f.path, stats[i]!));
  // an index shared by files of another size or date: those are told apart by their real paths
  const first = new Map<string, { size: number; mtime: number }>();
  const clash = new Set<string>();
  for (const [i, f] of seen.entries()) {
    const id = ids[i]!.identity;
    const was = first.get(id);
    if (!was) first.set(id, { size: f.size, mtime: f.mtime });
    else if (was.size !== f.size || was.mtime !== f.mtime) clash.add(id);
  }
  /** The file on disk ComfyUI loads by each name: the first directory's that holds it. */
  const loaded = new Map<string, string>();
  const out: Found[] = [];
  for (const [i, f] of seen.entries()) {
    let id = ids[i]!;
    if (clash.has(id.identity)) {
      const real = `path:${(await realOf(f.path)) ?? f.path}`;
      id = { identity: real, inode: real };
    }
    // the same file seen again under the name (a directory listed twice) is not another one
    const name = loaded.get(f.file);
    if (name === undefined) loaded.set(f.file, id.identity);
    out.push({ ...f, ...id, shadowed: name !== undefined && name !== id.identity });
  }
  return { files: out, whole };
}

export class ModelHashes {
  private running: Promise<void> | null = null;
  private hashing: HashStatus["hashing"] = null;
  private paused = false;
  private error: string | null = null;
  private noFolder = false;
  private found = 0;
  private looked = false;
  /** Whether a machine runs a job now, or work queued from outside Afflatus (services.ts: the queue's busyOn). */
  runningOn: (machine: string) => boolean = () => false;
  /** This computer's machines (not rented ones), as the settings said at the pass's start: their renders hold the disk. */
  private home: string[] = [];
  private busy = () => this.home.some((m) => this.runningOn(m));
  /** Afflatus is closing (stop): no pass starts, and the one under way ends at its next step. */
  private stopped = false;
  /** The pass's hashing thread, while there is one: ended at once by a stop. */
  private worker: Worker | null = null;

  constructor(private readonly s: Pick<Services, "db">) {}

  async status(): Promise<HashStatus> {
    const rows = await this.s.db.selectFrom("model_hashes").select(["civitai_version", "hf_url", "matched_at"]).execute();
    return {
      files: Math.max(this.found, rows.length), hashed: rows.length, hashing: this.hashing, paused: this.paused,
      civitai: rows.filter((r) => Number(r.civitai_version) > 0).length,
      huggingFace: rows.filter((r) => !(Number(r.civitai_version) > 0) && r.hf_url).length,
      nowhere: rows.filter((r) => r.matched_at && !(Number(r.civitai_version) > 0) && !r.hf_url).length,
      noFolder: this.noFolder, error: this.error, looked: this.looked || rows.length > 0,
    };
  }

  /** A pass: what is not hashed (or changed) hashed, then what is not matched asked of the sites. One at a time. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.pass().catch((err: Error) => {
      this.error = err.message.slice(0, 300);
      console.warn("[hashes]", err.message);
    }).finally(() => {
      this.running = null;
      this.hashing = null;
      this.paused = false;
    });
    return this.running;
  }

  /**
   * Afflatus closes: the pass under way ends (its thread terminated, the file it read taken as not read, asked again at the
   * next start) before the database is closed under it. Resolves once it has.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.worker?.terminate();
    // waited for a moment, not for ever: a pass may be asking Civitai or Hugging Face, which nothing cuts short, and a
    // close waiting on a slow site held a test's end past its limit. A write after that only fails; the file is read again
    let late: NodeJS.Timeout | undefined;
    await Promise.race([this.running, new Promise<void>((done) => (late = setTimeout(done, STOP_WAIT_MS)))]);
    clearTimeout(late);
  }

  private async pass(): Promise<void> {
    this.error = null;
    const settings = await readSettings(this.s.db);
    this.home = ownMachines(settings).map((m) => m.id);
    const all: Found[] = [];
    let anyDir = false;
    // the folders whose every directory was read: only their files can be said to be gone
    const read = new Set<string>();
    for (const folder of HASHED_FOLDERS) {
      const { dirs, all: named } = await modelDirsSaid(settings.comfyDir, folder);
      anyDir ||= dirs.length > 0;
      const { files, whole } = await filesIn(dirs, folder);
      all.push(...files);
      if (dirs.length && named && whole) read.add(folder);
    }
    this.noFolder = !anyDir;
    this.found = all.length;
    this.looked = true;
    const kept = await this.s.db.selectFrom("model_hashes").selectAll().execute();
    const keyOf = (folder: string, file: string) => `${folder}|${file}`;
    const have = new Map(kept.map((k) => [keyOf(k.folder, k.file), k]));
    // a name's row is the file ComfyUI loads by it; another directory's file under the same name has its own, by path
    const byName = all.filter((f) => !f.shadowed);
    const shadowed = all.filter((f) => f.shadowed);
    const keptPlaces = await this.s.db.selectFrom("model_hash_places").selectAll().execute();
    const havePlace = new Map(keptPlaces.map((k) => [k.path, k]));
    const rowOf = (f: Found) => (f.shadowed ? havePlace.get(f.path) : have.get(keyOf(f.folder, f.file)));
    // gone from the disk: forgotten. Only in a folder read whole (an offline drive is not every file deleted), and kept
    // aside for this pass: a file renamed or moved is the same bytes under another name
    const here = new Set(byName.map((f) => keyOf(f.folder, f.file)));
    const gone = kept.filter((k) => read.has(k.folder) && !here.has(keyOf(k.folder, k.file)));
    for (const k of gone) await this.s.db.deleteFrom("model_hashes").where("folder", "=", k.folder).where("file", "=", k.file).execute();
    const herePlaces = new Set(shadowed.map((f) => f.path));
    for (const k of keptPlaces) if (read.has(k.folder) && !herePlaces.has(k.path)) await this.s.db.deleteFrom("model_hash_places").where("path", "=", k.path).execute();
    // the smallest first: most files are LoRAs, done in moments, before a checkpoint takes a minute
    const todo = all.filter((f) => {
      const k = rowOf(f);
      return !k || Number(k.size) !== f.size || Number(k.mtime) !== f.mtime;
    }).sort((a, b) => a.size - b.size);
    // one file on disk seen in two places (a folder listed twice, a hard link) is read once: its hash, known in one place
    // and the same size and date there, goes to the other, of the same size and date too (an index shared by two files
    // on a file system that repeats them never gives one the other's hash)
    type Known = { sha256: string; civitai_version: number | null; hf_url: string | null; matched_at: string | null };
    const known = new Map<string, Known & { size: number; mtime: number }>();
    for (const f of byName) {
      const k = have.get(keyOf(f.folder, f.file));
      if (k && Number(k.size) === f.size && Number(k.mtime) === f.mtime) known.set(f.inode, { sha256: k.sha256, civitai_version: k.civitai_version === null ? null : Number(k.civitai_version), hf_url: k.hf_url, matched_at: k.matched_at, size: f.size, mtime: f.mtime });
    }
    for (const f of shadowed) {
      const k = havePlace.get(f.path);
      if (k && Number(k.size) === f.size && Number(k.mtime) === f.mtime && !known.has(f.inode)) known.set(f.inode, { sha256: k.sha256, civitai_version: null, hf_url: null, matched_at: null, size: f.size, mtime: f.mtime });
    }
    /** A shadowed file's hash, kept by its path: never the name's row, which is the other file's. */
    const keepPlace = async (f: Found, sha256: string) => {
      const row = { folder: f.folder, file: f.file, size: f.size, mtime: f.mtime, sha256, hashed_at: now() };
      await this.s.db.insertInto("model_hash_places").values({ path: f.path, ...row }).onConflict((oc) => oc.column("path").doUpdateSet(row)).execute();
    };
    // the hashing's thread, for this pass only
    let worker: Worker | null = null;
    try {
      for (const f of todo) {
        if (this.stopped) return;
        const kept = known.get(f.inode);
        const same: Known | undefined = kept && kept.size === f.size && kept.mtime === f.mtime ? { sha256: kept.sha256, civitai_version: kept.civitai_version, hf_url: kept.hf_url, matched_at: kept.matched_at } : undefined;
        if (same && f.shadowed) {
          await keepPlace(f, same.sha256);
          continue;
        }
        if (same) {
          const row = { size: f.size, mtime: f.mtime, hashed_at: now(), ...same };
          await this.s.db.insertInto("model_hashes").values({ folder: f.folder, file: f.file, ...row }).onConflict((oc) => oc.columns(["folder", "file"]).doUpdateSet(row)).execute();
          continue;
        }
        // a file just found gone with the same size and time: the same file renamed or moved, its hash and match kept
        // rather than a checkpoint read again in full
        const moved = !f.shadowed && !have.has(keyOf(f.folder, f.file)) ? gone.findIndex((g) => Number(g.size) === f.size && Number(g.mtime) === f.mtime) : -1;
        if (moved >= 0) {
          const [g] = gone.splice(moved, 1);
          await this.s.db.insertInto("model_hashes").values({ ...g!, folder: f.folder, file: f.file }).execute();
          continue;
        }
        // made at the first file to read, and again after one that stopped (its id is then -1)
        if (!worker || worker.threadId === -1) {
          worker = this.worker = new Worker(HASHER, { eval: true });
          // a pass under way never holds the process open at its end
          worker.unref();
        }
        const sha256 = await this.hashOf(worker, f);
        if (!sha256 || this.stopped) continue;
        known.set(f.inode, { sha256, civitai_version: null, hf_url: null, matched_at: null, size: f.size, mtime: f.mtime });
        if (f.shadowed) {
          await keepPlace(f, sha256);
          continue;
        }
        const row = { size: f.size, mtime: f.mtime, sha256, hashed_at: now(), civitai_version: null, hf_url: null, matched_at: null };
        await this.s.db.insertInto("model_hashes").values({ folder: f.folder, file: f.file, ...row }).onConflict((oc) => oc.columns(["folder", "file"]).doUpdateSet(row)).execute();
      }
    } finally {
      await worker?.terminate();
      this.worker = null;
    }
    if (!this.stopped) await this.match();
  }

  /** A file's SHA-256, read in pieces in the hashing's thread, held while this computer renders. Null when it could not be read. */
  private hashOf(worker: Worker, f: Found): Promise<string | null> {
    this.hashing = { folder: f.folder, file: f.file, bytes: 0, total: f.size };
    return new Promise((done) => {
      let waiting: NodeJS.Timeout | null = null;
      /** The hash, when the file's last piece was read as the hashing was held: it is said once the render is over. */
      let held: { sha256: string | null } | null = null;
      const goOn = () => {
        if (this.busy()) {
          this.paused = true;
          waiting = setTimeout(goOn, PAUSE_MS);
          waiting.unref();
          return;
        }
        this.paused = false;
        waiting = null;
        // the thread goes on reading, or, when it was done already, is ready for the next file
        worker.postMessage({ resume: true });
        if (held) end(held.sha256);
      };
      const said = (m: { bytes?: number; sha256?: string | null }) => {
        if (m.bytes !== undefined) {
          if (this.hashing) this.hashing.bytes += m.bytes;
          if (!waiting && this.busy()) {
            worker.postMessage({ pause: true });
            goOn();
          }
          return;
        }
        if (waiting) held = { sha256: m.sha256 ?? null };
        else end(m.sha256 ?? null);
      };
      // a thread that stopped (out of memory, terminated) says nothing more: the file is taken as not read
      const failed = () => end(null);
      const end = (sha256: string | null) => {
        worker.off("message", said);
        worker.off("error", failed);
        worker.off("exit", failed);
        if (waiting) clearTimeout(waiting);
        done(sha256);
      };
      worker.on("message", said);
      worker.on("error", failed);
      worker.on("exit", failed);
      worker.postMessage({ path: f.path });
    });
  }

  /**
   * The hashes not matched yet (or matched to nothing a while ago) asked of the sites: Civitai all at once; what it does
   * not know, Hugging Face by the file's name, taken only when the file there has this very hash. Only with lookups on.
   */
  private async match(): Promise<void> {
    const settings = await readSettings(this.s.db);
    if (!settings.civitaiLookups) return;
    const rows = await this.s.db.selectFrom("model_hashes").selectAll().execute();
    const due = rows.filter((r) => !r.matched_at || (!(Number(r.civitai_version) > 0) && !r.hf_url && Date.now() - Date.parse(r.matched_at) > ASK_AGAIN_MS));
    if (!due.length) return this.bases(settings.civitaiKey);
    const versions = await civitaiVersionsByHash([...new Set(due.map((r) => r.sha256))], settings.civitaiKey);
    if (!versions) throw new Error("Civitai did not answer the hashes: asked again at the next pass");
    for (const r of due) {
      if (this.stopped) return;
      const version = versions.get(r.sha256) ?? 0;
      let hf: string | null = null;
      // whether Hugging Face gave a full answer: one away, refusing (429) or slow says nothing of the file, so the file is
      // left unmatched (asked again at the next pass) rather than taken as found nowhere for a week
      let answered = true;
      if (!version) {
        const found = await findOnHuggingFace(fileName(r.file)).catch(() => ({ items: [], answered: false }));
        answered = found.answered;
        for (const item of found.items) {
          const theirs = await huggingFaceSha256(item.repo, item.path, settings.huggingFaceToken ?? "").catch(() => undefined);
          if (theirs === undefined) answered = false;
          if (theirs === r.sha256) {
            hf = item.url;
            answered = true;
            break;
          }
        }
      }
      await this.s.db.updateTable("model_hashes").set({ civitai_version: version, hf_url: hf, matched_at: version || hf || answered ? now() : null }).where("folder", "=", r.folder).where("file", "=", r.file).execute();
    }
    await this.bases(settings.civitaiKey);
  }

  /**
   * The base model of each LoRA's Civitai version, asked once a file ("" when it gives none): a LoRA's header says "LTX" for
   * every LTX, Civitai says which, and a LoRA made for another version is told by it (modelSet.ts). No answer: asked again
   * at the next pass.
   */
  private async bases(key: string): Promise<void> {
    const rows = await this.s.db.selectFrom("model_hashes").select(["folder", "file", "civitai_version"]).where("folder", "=", "loras").where("civitai_base", "is", null).where("civitai_version", ">", 0).limit(BASES_A_PASS).execute();
    for (const r of rows) {
      if (this.stopped) return;
      const version = await civitaiGet<ApiVersion>(`/api/v1/model-versions/${Number(r.civitai_version)}`, key).catch(() => undefined);
      if (version === undefined) return;
      await this.s.db.updateTable("model_hashes").set({ civitai_base: version?.baseModel ?? "" }).where("folder", "=", r.folder).where("file", "=", r.file).execute();
    }
  }
}
