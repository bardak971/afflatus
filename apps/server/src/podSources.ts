import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { baseName, type Family, type PresetFile } from "@afflatus/core";
import { civitaiVersion } from "./civitai";
import type { Selectable } from "kysely";
import { now, type Db, type Tables } from "./db";
import { huggingFaceSha256 } from "./huggingface";
import { lookUpPage, type ModelPage } from "./modelPages";
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
  /** `sha256`: the bytes the file must have (this computer's copy's hash), which the pod's node pack checks before naming it. */
  | { kind: "url"; url: string; sha256?: string }
  /** `sha256`, `fileId`: the file of the version with these bytes, or of Civitai's id, whatever its name. */
  | { kind: "civitai"; version: number; pick?: string; sha256?: string; fileId?: number }
  | { kind: "upload"; path: string };

const HF_HOSTS = ["huggingface.co", "hf.co"];

/**
 * Usual files' public copies on Hugging Face, by their SHA-256 (upper case, as model_hashes keeps it): a file of this
 * computer with these bytes is fetched there by a pod, whatever page its name was matched to. Each pinned to the commit
 * whose X-Linked-ETag is that hash (a branch moves: the repo's owner, or a stolen account, could put other bytes on main),
 * and the hash is handed to the pod's node pack, which checks the file before naming it. RealESRGAN_x4plus.pth's Civitai
 * version has its downloads disabled by its creator (card #206).
 */
export const USUAL_COPIES: Record<string, string> = {
  "4FA0D38905F75AC06EB49A7951B426670021BE3018265FD191D2125DF9D682F1": "https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/RealESRGAN_x4plus.pth",
};

/**
 * Whether a Civitai version refused on a pod (closeVersion) is still refused for this row: the close stands only while the
 * row is as it was then. A row hashed again (other bytes in the file) or matched again (another version) since is asked
 * afresh: a close kept for good sent every later pod this computer's copy over the home line (the 0.9.0 review, M3).
 */
export const versionClosed = (row: Pick<HashRow, "civitai_closed_at" | "hashed_at" | "matched_at">): boolean =>
  Boolean(row.civitai_closed_at && row.civitai_closed_at >= row.hashed_at && (!row.matched_at || row.civitai_closed_at >= row.matched_at));

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

// Core's split, the one the fetch's official test uses: a name matched here and refused there sent a pod a file it then
// would not fetch (a Windows sub-folder name, 2026-10-22).
const nameOf = (file: string) => baseName(file).toLowerCase();
const CIVITAI_PAGE = /civitai\.(?:com|red|green)\/models\/\d+[^\s#]*?[?&]modelVersionId=(\d+)/i;
const HF_FILE = /^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/(?:blob|resolve)\/([^/]+)\/(.+)$/i;

/**
 * What a lookup reads for many files at once, read once: a search's 30 files, a set's 200 and the queue's plan each asked
 * for the presets, the folder's hashes and its Civitai matches once per file (91 to 241 statements, and the shipped
 * presets' folder listed, for one search word). Kept a moment per lookup and shared while it is read; a read that failed
 * is not kept. The lookup is the server's one (services.ts), so a moment later the next request reads afresh.
 */
const BRIEF_MS = 2_000;
const brief = new WeakMap<SourceLookup, Map<string, { at: number; value: Promise<unknown> }>>();
function once<T>(l: SourceLookup, key: string, read: () => Promise<T>): Promise<T> {
  let kept = brief.get(l);
  if (!kept) brief.set(l, (kept = new Map()));
  const had = kept.get(key);
  if (had && Date.now() - had.at < BRIEF_MS) return had.value as Promise<T>;
  const entry = { at: Date.now(), value: read() };
  kept.set(key, entry);
  entry.value.catch(() => {
    if (kept.get(key) === entry) kept.delete(key);
  });
  return entry.value;
}

/** The presets that name files, read once for the many files a request asks about (a file's size is looked for there too). */
export const presetsOf = (l: SourceLookup) => once(l, "presets", l.presets);

type HashRow = Selectable<Tables["model_hashes"]>;
/** A folder's hashes by the file's path (lower case, forward slashes) and by its name alone. */
const hashesOf = (l: SourceLookup, folder: string) =>
  once(l, `hashes|${folder}`, async () => {
    const rows = await l.db.selectFrom("model_hashes").selectAll().where("folder", "=", folder).execute().catch(() => [] as HashRow[]);
    const byName = new Map<string, HashRow[]>();
    for (const r of rows) {
      const list = byName.get(nameOf(r.file));
      if (list) list.push(r);
      else byName.set(nameOf(r.file), [r]);
    }
    return { byPath: new Map(rows.map((r) => [r.file.toLowerCase(), r])), byName };
  });
/** The pages known for a folder's files (model_pages, the rows with an address), by the file's name. */
const pagesOf = (l: SourceLookup, folder: string) =>
  once(l, `pages|${folder}`, async () => {
    const rows = await l.db.selectFrom("model_pages").select(["name", "url", "title"]).where("folder", "=", folder).where("url", "!=", "").execute();
    return new Map<string, ModelPage>(rows.map((r) => [r.name, { url: r.url, title: r.title }]));
  });
/** The Civitai version each file of a folder was matched to (model updates), by the file's name: the first row of a name. */
const updatesOf = (l: SourceLookup, folder: string) =>
  once(l, `updates|${folder}`, async () => {
    const rows = await l.db.selectFrom("model_updates").select(["version_id", "file"]).where("folder", "=", folder).execute().catch(() => []);
    const byName = new Map<string, number>();
    for (const r of rows) if (!byName.has(nameOf(r.file))) byName.set(nameOf(r.file), r.version_id);
    return byName;
  });

/** A source given as a PresetFile's (an address, or a Civitai version and which of its files). */
export function presetSource(f: Pick<PresetFile, "url" | "civitai">): PodSource | null {
  if (f.url) return { kind: "url", url: f.url };
  if (f.civitai) {
    const { version, pick, sha256, fileId } = f.civitai;
    return { kind: "civitai", version, ...(pick ? { pick } : {}), ...(sha256 ? { sha256 } : {}), ...(fileId ? { fileId } : {}) };
  }
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
  for (const p of await presetsOf(l)) {
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
  const matched = (await updatesOf(l, want.folder)).get(name);
  if (matched) return { kind: "civitai", version: matched, pick: baseName(want.file) };
  const page = o.live ? (await lookUpPage(l.db, want.folder, want.file).catch(() => null))?.page : ((await pagesOf(l, want.folder).catch(() => null))?.get(name) ?? null);
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
  const hashes = await hashesOf(l, want.folder);
  // by its path, else by its name alone only when one file has that name (two of the same name are two files)
  const named = hashes.byName.get(nameOf(want.file)) ?? [];
  const row = hashes.byPath.get(want.file.replace(/\\/g, "/").toLowerCase()) ?? (named.length === 1 ? named[0] : undefined);
  // the hash is this copy's only while the file is as it was hashed: one replaced since is other bytes until hashed again
  if (!row || Number(row.size) !== st.size || Number(row.mtime) !== Math.round(st.mtimeMs)) return null;
  const pick = baseName(want.file);
  // a site's copy proven by this hash: the pod's node pack checks the bytes it gets against it (the copy may change after)
  const usual = USUAL_COPIES[row.sha256.toUpperCase()];
  if (usual) return { kind: "url", url: usual, sha256: row.sha256 };
  // a version Civitai refused (its downloads disabled) is not asked again: the file is sent from here instead
  if (Number(row.civitai_version) > 0 && !versionClosed(row)) return { kind: "civitai", version: Number(row.civitai_version), pick, sha256: row.sha256 };
  if (row.hf_url) return { kind: "url", url: row.hf_url, sha256: row.sha256 };
  // asked of the sites by its hash already and found nowhere: no file of its name there is these bytes
  if (row.matched_at || !live) return null;
  const settings = await readSettings(l.db);
  if (!settings.civitaiLookups) return null;
  const keep = async (set: { civitai_version: number; hf_url: string | null }) => {
    await l.db.updateTable("model_hashes").set({ ...set, matched_at: now(), civitai_closed_at: null }).where("folder", "=", row.folder).where("file", "=", row.file).execute().catch(() => undefined);
    // the folder's hashes kept a moment are read again: the next file asked sees the match
    brief.get(l)?.delete(`hashes|${row.folder}`);
  };
  const updated = (await updatesOf(l, want.folder)).get(nameOf(want.file));
  const page = (await lookUpPage(l.db, want.folder, want.file).catch(() => null))?.page;
  const versions = [...new Set([updated, page ? Number(CIVITAI_PAGE.exec(page.url)?.[1] ?? 0) : 0].filter((v): v is number => Boolean(v)))];
  for (const version of versions) {
    const found = await civitaiVersion(version, pick, settings.civitaiKey, { sha256: row.sha256 }).catch(() => null);
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
      return { ...src, sha256: row.sha256 };
    }
  }
  return null;
}

/**
 * A Civitai version refused for good (its creator disabled downloads: card #206), kept on the hashes matched to it: a pod's
 * next lookup takes another copy of the same bytes, or this computer's. Never a paid one (Early Access ends, the user may
 * unlock it): podFiles.ts does not close those. Open again (openVersion) once a download of it succeeds.
 */
export async function closeVersion(l: SourceLookup, folder: string, version: number): Promise<void> {
  await l.db.updateTable("model_hashes").set({ civitai_closed_at: now() }).where("folder", "=", folder).where("civitai_version", "=", version).execute();
  brief.get(l)?.delete(`hashes|${folder}`);
}

/** A Civitai version that gave its file after all (its creator allowed downloads again): its hashes take it again. */
export async function openVersion(l: SourceLookup, folder: string, version: number): Promise<void> {
  await l.db.updateTable("model_hashes").set({ civitai_closed_at: null }).where("folder", "=", folder).where("civitai_version", "=", version).where("civitai_closed_at", "is not", null).execute();
  brief.get(l)?.delete(`hashes|${folder}`);
}

/**
 * This computer's copy to send in place of a refused source: localCopy's, and, when the bytes the source would have given
 * are known (`sha256`: a preset's, the version's file's), only a copy hashed as those bytes and unchanged since. A file of
 * the same name may be another model (a preset's loras/wan/foo.safetensors against loras/foo.safetensors): the pod would
 * render with the wrong LoRA and nothing said (the 0.9.0 review, S2).
 */
export async function localCopyOf(l: SourceLookup, folder: string, file: string, sha256?: string): Promise<string | null> {
  const comfyDir = await l.comfyDir();
  const path = await localCopy(comfyDir, folder, file);
  if (!path || !sha256) return path;
  const st = await stat(path).catch(() => null);
  if (!st) return null;
  const rows = await l.db.selectFrom("model_hashes").select(["file", "size", "mtime"]).where("folder", "=", folder).where("sha256", "=", sha256.toUpperCase()).execute().catch(() => []);
  const dirs = await modelDirs(comfyDir, folder);
  const same = (a: string) => resolve(a).toLowerCase();
  // the row of this very path, and the file as it was hashed: another file of these bytes says nothing of this one
  const hashed = rows.some((r) => Number(r.size) === st.size && Number(r.mtime) === Math.round(st.mtimeMs) && dirs.some((d) => same(join(d, ...r.file.split(/[\\/]/))) === same(path)));
  return hashed ? path : null;
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
