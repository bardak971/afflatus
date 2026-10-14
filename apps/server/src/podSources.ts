import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Family, PresetFile } from "@afflatus/core";
import type { Db } from "./db";
import { lookUpPage } from "./modelPages";
import { modelDirs } from "./modelFiles";

/**
 * Where a rented pod can get a model file it lacks. A pod cannot reach this computer, so a file comes from its site
 * (Hugging Face, Civitai) straight onto the pod, or, when no site is known for it, is sent from this computer. Looked for
 * in what Afflatus knows already, without asking any site: the address the caller has (a job's missing file, a model
 * set's), the presets that name the file, the families' usual files, the Civitai version Afflatus matched the file to
 * (model updates), its page when that page names a version or a file; else the file in this computer's ComfyUI.
 */

export type PodSource =
  | { kind: "url"; url: string }
  | { kind: "civitai"; version: number; pick?: string }
  | { kind: "upload"; path: string };

/** Which of the measured sources a pod's file comes by (pod_measures.kind). */
export function measureKind(src: PodSource): "hf" | "civitai" | "upload" | "url" {
  if (src.kind === "civitai") return "civitai";
  if (src.kind === "upload") return "upload";
  return /^https:\/\/([^/]+\.)?(huggingface\.co|hf\.co)\//i.test(src.url) ? "hf" : "url";
}

export interface SourceLookup {
  db: Db;
  presets: () => Promise<Array<{ files: PresetFile[] }>>;
  families: () => Family[];
  /** This computer's ComfyUI folder, when it has one here (Settings › ComfyUI): an upload is read from it. */
  comfyDir: () => Promise<string>;
}

const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();

/** A source given as a PresetFile's (an address, or a Civitai version and which of its files). */
export function presetSource(f: Pick<PresetFile, "url" | "civitai">): PodSource | null {
  if (f.url) return { kind: "url", url: f.url };
  if (f.civitai) return { kind: "civitai", version: f.civitai.version, ...(f.civitai.pick ? { pick: f.civitai.pick } : {}) };
  return null;
}

/** Where the pod gets `file` (in `folder`): the first that knows it; null when none does and this computer has no copy. */
export async function podSource(l: SourceLookup, want: { file: string; folder: string; url?: string; civitai?: PresetFile["civitai"] }): Promise<PodSource | null> {
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
  // what this computer's copy of it is, by its hash (modelHashes.ts): the Civitai version it is, else the Hugging Face file
  // with the same hash. Exact, whatever the file is called here
  const hashed = await l.db.selectFrom("model_hashes").select(["file", "civitai_version", "hf_url"]).where("folder", "=", want.folder).execute().catch(() => []);
  const same = hashed.find((r) => r.file.toLowerCase() === want.file.replace(/\\/g, "/").toLowerCase()) ?? hashed.find((r) => nameOf(r.file) === name);
  if (same && Number(same.civitai_version) > 0) return { kind: "civitai", version: Number(same.civitai_version), pick: want.file.split(/[\\/]/).pop() };
  if (same?.hf_url) return { kind: "url", url: same.hf_url };
  // the version Afflatus matched the file to on Civitai (model updates): that version's file of that name
  const matched = await l.db.selectFrom("model_updates").select(["version_id", "file"]).where("folder", "=", want.folder).execute().catch(() => []);
  const hit = matched.find((r) => nameOf(r.file) === name);
  if (hit?.version_id) return { kind: "civitai", version: hit.version_id, pick: want.file.split(/[\\/]/).pop() };
  // its page, when that page names one version on Civitai or is the file on Hugging Face: the one known, else looked for
  // (Civitai by the file's fingerprint, then the sites by its name, when lookups are on): most models a user has are on
  // one of them, and a site is faster than this computer's upload and spares its line
  const page = (await lookUpPage(l.db, want.folder, want.file).catch(() => null))?.page;
  if (page) {
    const version = /civitai\.(?:com|red|green)\/models\/\d+[^\s#]*?[?&]modelVersionId=(\d+)/i.exec(page.url)?.[1];
    if (version) return { kind: "civitai", version: Number(version), pick: want.file.split(/[\\/]/).pop() };
    const hf = /^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/(?:blob|resolve)\/([^/]+)\/(.+)$/i.exec(page.url);
    if (hf && nameOf(decodeURIComponent(hf[4]!)) === name) return { kind: "url", url: `https://huggingface.co/${hf[1]}/${hf[2]}/resolve/${hf[3]}/${hf[4]}` };
  }
  const path = await localCopy(await l.comfyDir(), want.folder, want.file);
  return path ? { kind: "upload", path } : null;
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
