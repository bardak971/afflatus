import { baseLabel, checkModelSet, graphFiles, setPlaces, type BuiltGraph, type Family, type InputSpec, type ModelInfo, type Recipe, type SetFinding, type SetLook } from "@afflatus/core";
import type { Db } from "./db";

/**
 * Whether a render's files go together (core modelSet.ts), on what this computer knows of them: the SHA-256 Settings ›
 * Models' pass read (model_hashes), with the base model Civitai gave for that hash, and what each file's header said
 * (model_info). Never a hash of its own on the render path: a file not hashed yet is told by its name alone.
 */

/** A file's path as a folder's lists and the hashes both give it: forward slashes, lower case. */
const key = (folder: string, file: string) => `${folder}|${file.replace(/\\/g, "/").toLowerCase()}`;

/** What is known of the files of these folders, read in two statements. */
export async function setLook(db: Db, folders: string[]): Promise<SetLook> {
  if (!folders.length) return {};
  const [hashes, infos] = await Promise.all([
    db.selectFrom("model_hashes").select(["folder", "file", "sha256", "civitai_base"]).where("folder", "in", folders).execute(),
    db.selectFrom("model_info").select(["folder", "file", "info"]).where("folder", "in", folders).execute(),
  ]);
  const sha = new Map(hashes.map((h) => [key(h.folder, h.file), h.sha256]));
  const site = new Map(hashes.filter((h) => h.civitai_base).map((h) => [key(h.folder, h.file), h.civitai_base!]));
  const info = new Map(infos.map((r) => [key(r.folder, r.file), JSON.parse(r.info) as ModelInfo]));
  return {
    sha256: (folder, file) => sha.get(key(folder, file)),
    info: (folder, file) => withSite(info.get(key(folder, file)), site.get(key(folder, file))),
  };
}

/** A file's header reading with Civitai's base model beside it: a LoRA whose header names none is filed by Civitai's. */
export function withSite(info: ModelInfo | undefined, civitaiBase: string | undefined): ModelInfo | undefined {
  if (!civitaiBase) return info;
  return { ...info, civitaiBase, ...(!info?.base ? { base: baseLabel(civitaiBase) } : {}) };
}

/** The files a built graph loads, held against its family's declarations. */
export async function setFindings(db: Db, family: Family | undefined, recipe: Recipe<any>, input: Record<string, unknown>, built: Pick<BuiltGraph, "graph">, slots: Readonly<Record<string, string>>): Promise<SetFinding[]> {
  if (!family || (!family.line && !family.wrong?.length)) return [];
  const folders = Object.fromEntries(family.slots.map((s) => [s.id, s.folder]));
  const places = setPlaces(family, recipe.inputs as InputSpec[], input, graphFiles(built.graph, slots, folders));
  if (!places.length) return [];
  return checkModelSet(family, places, await setLook(db, [...new Set(places.map((p) => p.folder))]));
}

/** A refused mix, in the words the job and the form say it: what is wrong, and that it would not render. */
export const refusedSaid = (found: SetFinding[]) => `${found.filter((f) => f.black).map((f) => f.text).join(" ")} It would give black or garbled frames, so it was not sent.`;
