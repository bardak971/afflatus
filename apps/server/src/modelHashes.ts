import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { civitaiVersionsByHash } from "./civitai";
import { now } from "./db";
import { findOnHuggingFace, huggingFaceSha256 } from "./huggingface";
import { fileName } from "./media";
import { MODEL_EXT } from "@afflatus/core";
import { modelDirs } from "./modelFiles";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Every model file of this computer's ComfyUI, hashed once (its SHA-256), so that the sites can say which file it is
 * whatever it is called: Civitai by the hash itself (all of them in one request), Hugging Face by the file's name and
 * then the hash it lists for that file (it has no search by hash). What is found is the file's source for a rented pod
 * (podSources.ts) and its version for the update check. Hashing reads every file once: in the background, from the
 * start of Afflatus and on the user's "Hash now", paused while this computer renders (the disk is the render's).
 */

/** The folders whose files are hashed: the model folders a pod is sent files of. */
export const HASHED_FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders"];
/** A file matched to nothing is asked about again after this long (a site may have it since). */
const ASK_AGAIN_MS = 7 * 24 * 60 * 60_000;
/** While a render runs here, how often the hashing looks whether it may go on. */
const PAUSE_MS = 2_000;

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
  /** Why the last pass stopped short, when it did. */
  error: string | null;
}

interface Found {
  folder: string;
  /** As ComfyUI lists it: its sub-folder and name, with forward slashes. */
  file: string;
  path: string;
  size: number;
  mtime: number;
}

/** The model files under a folder's directories, sub-folders included. */
async function filesIn(dirs: string[], folder: string): Promise<Found[]> {
  const out: Found[] = [];
  const walk = async (root: string, dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(root, path, depth + 1);
      else if (e.isFile() && MODEL_EXT.test(e.name)) {
        const st = await stat(path).catch(() => null);
        if (st) out.push({ folder, file: relative(root, path).replace(/\\/g, "/"), path, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  for (const d of dirs) await walk(d, d, 0);
  return out;
}

export class ModelHashes {
  private running: Promise<void> | null = null;
  private hashing: HashStatus["hashing"] = null;
  private paused = false;
  private error: string | null = null;
  private noFolder = false;
  private found = 0;
  /** Whether a machine runs a job now (services.ts: the queue's). */
  runningOn: (machine: string) => boolean = () => false;
  /** This computer's machines (not rented ones), as the settings said at the pass's start: their renders hold the disk. */
  private home: string[] = [];
  private busy = () => this.home.some((m) => this.runningOn(m));

  constructor(private readonly s: Pick<Services, "db">) {}

  async status(): Promise<HashStatus> {
    const rows = await this.s.db.selectFrom("model_hashes").select(["civitai_version", "hf_url", "matched_at"]).execute();
    return {
      files: Math.max(this.found, rows.length), hashed: rows.length, hashing: this.hashing, paused: this.paused,
      civitai: rows.filter((r) => Number(r.civitai_version) > 0).length,
      huggingFace: rows.filter((r) => !(Number(r.civitai_version) > 0) && r.hf_url).length,
      nowhere: rows.filter((r) => r.matched_at && !(Number(r.civitai_version) > 0) && !r.hf_url).length,
      noFolder: this.noFolder, error: this.error,
    };
  }

  /** A pass: what is not hashed (or changed) hashed, then what is not matched asked of the sites. One at a time. */
  run(): Promise<void> {
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

  private async pass(): Promise<void> {
    this.error = null;
    const settings = await readSettings(this.s.db);
    this.home = settings.machines.filter((m) => !m.rented).map((m) => m.id);
    const all: Found[] = [];
    let anyDir = false;
    for (const folder of HASHED_FOLDERS) {
      const dirs = await modelDirs(settings.comfyDir, folder);
      anyDir ||= dirs.length > 0;
      all.push(...(await filesIn(dirs, folder)));
    }
    this.noFolder = !anyDir;
    this.found = all.length;
    const kept = await this.s.db.selectFrom("model_hashes").select(["folder", "file", "size", "mtime"]).execute();
    const keyOf = (folder: string, file: string) => `${folder}|${file}`;
    const have = new Map(kept.map((k) => [keyOf(k.folder, k.file), k]));
    // gone from the disk: forgotten
    const here = new Set(all.map((f) => keyOf(f.folder, f.file)));
    for (const k of kept) if (!here.has(keyOf(k.folder, k.file))) await this.s.db.deleteFrom("model_hashes").where("folder", "=", k.folder).where("file", "=", k.file).execute();
    // the smallest first: most files are LoRAs, done in moments, before a checkpoint takes a minute
    const todo = all.filter((f) => {
      const k = have.get(keyOf(f.folder, f.file));
      return !k || Number(k.size) !== f.size || Number(k.mtime) !== f.mtime;
    }).sort((a, b) => a.size - b.size);
    for (const f of todo) {
      const sha256 = await this.hashOf(f);
      if (!sha256) continue;
      const row = { size: f.size, mtime: f.mtime, sha256, hashed_at: now(), civitai_version: null, hf_url: null, matched_at: null };
      await this.s.db.insertInto("model_hashes").values({ folder: f.folder, file: f.file, ...row }).onConflict((oc) => oc.columns(["folder", "file"]).doUpdateSet(row)).execute();
    }
    await this.match();
  }

  /** A file's SHA-256, read in pieces, waiting while this computer renders. Null when it could not be read. */
  private hashOf(f: Found): Promise<string | null> {
    this.hashing = { folder: f.folder, file: f.file, bytes: 0, total: f.size };
    return new Promise((done) => {
      const hash = createHash("sha256");
      const stream = createReadStream(f.path, { highWaterMark: 4 * 2 ** 20 });
      let waiting: NodeJS.Timeout | null = null;
      const goOn = () => {
        if (this.busy()) {
          this.paused = true;
          waiting = setTimeout(goOn, PAUSE_MS);
          waiting.unref();
          return;
        }
        this.paused = false;
        waiting = null;
        stream.resume();
      };
      stream.on("data", (d) => {
        hash.update(d);
        if (this.hashing) this.hashing.bytes += d.length;
        if (this.busy()) {
          stream.pause();
          if (!waiting) goOn();
        }
      });
      stream.on("end", () => done(hash.digest("hex").toUpperCase()));
      stream.on("error", () => done(null));
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
    if (!due.length) return;
    const versions = await civitaiVersionsByHash([...new Set(due.map((r) => r.sha256))], settings.civitaiKey);
    if (!versions) throw new Error("Civitai did not answer the hashes: asked again at the next pass");
    for (const r of due) {
      const version = versions.get(r.sha256) ?? 0;
      let hf: string | null = null;
      if (!version) {
        const found = await findOnHuggingFace(fileName(r.file)).catch(() => ({ items: [] }));
        for (const item of found.items) {
          if ((await huggingFaceSha256(item.repo, item.path, settings.huggingFaceToken ?? "")) === r.sha256) {
            hf = item.url;
            break;
          }
        }
      }
      await this.s.db.updateTable("model_hashes").set({ civitai_version: version, hf_url: hf, matched_at: now() }).where("folder", "=", r.folder).where("file", "=", r.file).execute();
    }
  }
}
