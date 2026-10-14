import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Family, PresetFile } from "@afflatus/core";
import { civitaiVersion } from "./civitai";
import { now, type Db } from "./db";
import { huggingFaceSha256 } from "./huggingface";
import { knownPage, lookUpPage, type ModelPage } from "./modelPages";
import { modelDirs } from "./modelFiles";
import { readSettings } from "./settings";

/**
 * Where a rented pod can get a model file it lacks. A pod cannot reach this computer, so a file comes from its site
 * (Hugging Face, Civitai) straight onto the pod, or, when no site is known for it, is sent from this computer. Looked for
 * in what Afflatus knows already: the address the caller has (a job's missing file, a model set's), the presets that name
 * the file, the families' usual files. Then, when this computer has the file, only a site's copy proven to be the same
 * bytes: the Civitai version or Hugging Face file its hash was matched to (modelHashes.ts), or a page found by its name
 * whose file there has that very hash; else the file is sent from here. A name says little (pytorch_lora_weights.safetensors
 * is a thousand LoRAs): a stranger's file of the same name is never rendered with in place of the user's own. When this
 * computer has no copy, nothing else can give the file: the Civitai version it was matched to (model updates), its page
 * known or found by its name.
 */

export type PodSource =
  | { kind: "url"; url: string }
  /** `sha256`: the file of the version with these bytes (a version found by the file's hash), whatever its name. */
  | { kind: "civitai"; version: number; pick?: string; sha256?: string }
  | { kind: "upload"; path: string };

const HF_HOSTS = ["huggingface.co", "hf.co"];

/**
 * Whether an address is Hugging Face's: https, and its host (parsed, not read off the text) huggingface.co, hf.co or one
 * under them. A pattern over the text took https://127.0.0.1:8188?.hf.co/ for one, and its size was then asked of it.
 */
export function isHuggingFace(url: string): boolean {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return false;
  }
  if (at.protocol !== "https:" || at.port || at.username || at.password) return false;
  const host = at.hostname.toLowerCase();
  return HF_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Which of the measured sources a pod's file comes by (pod_measures.kind). */
export function measureKind(src: PodSource): "hf" | "civitai" | "upload" | "url" {
  if (src.kind === "civitai") return "civitai";
  if (src.kind === "upload") return "upload";
  return isHuggingFace(src.url) ? "hf" : "url";
}

export interface SourceLookup {
  db: Db;
  presets: () => Promise<Array<{ files: PresetFile[] }>>;
  families: () => Family[];
  /** This computer's ComfyUI folder, when it has one here (Settings › ComfyUI): an upload is read from it. */
  comfyDir: () => Promise<string>;
}

const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();
const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const CIVITAI_PAGE = /civitai\.(?:com|red|green)\/models\/\d+[^\s#]*?[?&]modelVersionId=(\d+)/i;
const HF_FILE = /^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/(?:blob|resolve)\/([^/]+)\/(.+)$/i;

/** A source given as a PresetFile's (an address, or a Civitai version and which of its files). */
export function presetSource(f: Pick<PresetFile, "url" | "civitai">): PodSource | null {
  if (f.url) return { kind: "url", url: f.url };
  if (f.civitai) return { kind: "civitai", version: f.civitai.version, ...(f.civitai.pick ? { pick: f.civitai.pick } : {}) };
  return null;
}

/** A page as a pod's source: a Civitai version, or a Hugging Face file of that name. */
function pageSource(page: ModelPage, file: string): PodSource | null {
  const version = CIVITAI_PAGE.exec(page.url)?.[1];
  if (version) return { kind: "civitai", version: Number(version), pick: baseName(file) };
  const hf = HF_FILE.exec(page.url);
  if (hf && nameOf(decodeURIComponent(hf[4]!)) === nameOf(file)) return { kind: "url", url: `https://huggingface.co/${hf[1]}/${hf[2]}/resolve/${hf[3]}/${hf[4]}` };
  return null;
}

/**
 * Where the pod gets `file` (in `folder`): the first that knows it; null when none does and this computer has no copy.
 * `live`: a site may be asked (a page looked for by the name, a site's hash of its file); only a pod's actual fetch does:
 * the lists that say where a file would come from (a search, a set, the Deploy dialog) take what is known.
 */
export async function podSource(l: SourceLookup, want: { file: string; folder: string; url?: string; civitai?: PresetFile["civitai"] }, o: { live?: boolean } = {}): Promise<PodSource | null> {
  const given = presetSource(want);
  if (given) return given;
  const name = nameOf(want.file);
  for (const p of await l.presets()) {
    const f = p.files.find((x) => x.folder === want.folder && nameOf(x.file) === name);
    const src = f && presetSource(f);
    if (src) return src;
  }
  for (const family of l.families()) {
    const slot = family.slots.find((x) => x.folder === want.folder && x.get && nameOf(x.get.file) === name);
    if (slot?.get) return { kind: "url", url: slot.get.url };
  }
  const path = await localCopy(await l.comfyDir(), want.folder, want.file);
  if (path) return (await sameBytes(l, want, path, Boolean(o.live))) ?? { kind: "upload", path };
  // no copy here, so nothing else can give it: the version Afflatus matched the file to on Civitai (model updates), that
  // version's file of that name; else its page, known or (live) looked for by its name
  const matched = await l.db.selectFrom("model_updates").select(["version_id", "file"]).where("folder", "=", want.folder).execute().catch(() => []);
  const hit = matched.find((r) => nameOf(r.file) === name);
  if (hit?.version_id) return { kind: "civitai", version: hit.version_id, pick: baseName(want.file) };
  const page = o.live ? (await lookUpPage(l.db, want.folder, want.file).catch(() => null))?.page : await knownPage(l.db, want.folder, want.file).catch(() => null);
  return page ? pageSource(page, want.file) : null;
}

/**
 * A site's copy of this computer's file proven to be the same bytes, by its SHA-256 (modelHashes.ts): the Civitai version
 * or Hugging Face file the hash was matched to; else (live, the hash not asked of the sites yet) the version or page found
 * by the name, once the site lists that very hash for its file, kept as the hash's match. Null: the file is sent from here.
 */
async function sameBytes(l: SourceLookup, want: { file: string; folder: string }, path: string, live: boolean): Promise<PodSource | null> {
  const st = await stat(path).catch(() => null);
  if (!st) return null;
  const rows = await l.db.selectFrom("model_hashes").selectAll().where("folder", "=", want.folder).execute().catch(() => []);
  const exact = want.file.replace(/\\/g, "/").toLowerCase();
  // by its path, else by its name alone only when one file has that name (two of the same name are two files)
  const named = rows.filter((r) => nameOf(r.file) === nameOf(want.file));
  const row = rows.find((r) => r.file.toLowerCase() === exact) ?? (named.length === 1 ? named[0] : undefined);
  // the hash is this copy's only while the file is as it was hashed: one replaced since is other bytes until hashed again
  if (!row || Number(row.size) !== st.size || Number(row.mtime) !== Math.round(st.mtimeMs)) return null;
  const pick = baseName(want.file);
  if (Number(row.civitai_version) > 0) return { kind: "civitai", version: Number(row.civitai_version), pick, sha256: row.sha256 };
  if (row.hf_url) return { kind: "url", url: row.hf_url };
  // asked of the sites by its hash already and found nowhere: no file of its name there is these bytes
  if (row.matched_at || !live) return null;
  const settings = await readSettings(l.db);
  if (!settings.civitaiLookups) return null;
  const keep = (set: { civitai_version: number; hf_url: string | null }) =>
    l.db.updateTable("model_hashes").set({ ...set, matched_at: now() }).where("folder", "=", row.folder).where("file", "=", row.file).execute().catch(() => undefined);
  const updated = await l.db.selectFrom("model_updates").select(["version_id", "file"]).where("folder", "=", want.folder).execute().catch(() => []);
  const page = (await lookUpPage(l.db, want.folder, want.file).catch(() => null))?.page;
  const versions = [...new Set([updated.find((r) => nameOf(r.file) === nameOf(want.file))?.version_id, page ? Number(CIVITAI_PAGE.exec(page.url)?.[1] ?? 0) : 0].filter((v): v is number => Boolean(v)))];
  for (const version of versions) {
    const found = await civitaiVersion(version, pick, settings.civitaiKey, row.sha256).catch(() => null);
    if (found?.file.hashes?.SHA256?.toUpperCase() !== row.sha256) continue;
    await keep({ civitai_version: version, hf_url: null });
    return { kind: "civitai", version, pick, sha256: row.sha256 };
  }
  const hf = page ? HF_FILE.exec(page.url) : null;
  if (hf) {
    const theirs = await huggingFaceSha256(`${hf[1]}/${hf[2]}`, decodeURIComponent(hf[4]!), settings.huggingFaceToken ?? "").catch(() => null);
    const src = page && pageSource(page, want.file);
    if (theirs === row.sha256 && src?.kind === "url") {
      await keep({ civitai_version: 0, hf_url: src.url });
      return src;
    }
  }
  return null;
}

/** The file in this computer's ComfyUI folders, when it is there: by its name with its sub-folder, else by its name in the folder's top. */
export async function localCopy(comfyDir: string, folder: string, file: string): Promise<string | null> {
  const parts = file.split(/[\\/]/).filter(Boolean);
  // a model folder's name only (never a path up out of models/), and a name that never goes up a folder
  if (!parts.length || parts.some((p) => p === "." || p === "..") || !/^[\w-]+$/.test(folder)) return null;
  for (const dir of await modelDirs(comfyDir, folder)) {
    for (const path of [join(dir, ...parts), join(dir, parts[parts.length - 1]!)]) {
      const st = await stat(path).catch(() => null);
      if (st?.isFile()) return path;
    }
  }
  return null;
}
