import { api, type Entity, type PresetDef } from "./api";
import { readPresetFile, slug as coreSlug } from "@afflatus/core";
import { saveJson } from "./download";

/**
 * A preset as a file: the shape the presets that ship with Afflatus have (`presets/*.json`), so that a
 * preset saved from here can be imported by another Afflatus, or contributed by pull request as it is.
 */

/** A preset's name made its file id: "Crème brûlée" → "creme-brulee"; "preset" when nothing is left. */
export const slug = (name: string) => coreSlug(name, 60) || "preset";

export function presetToFile(e: Extract<Entity, { kind: "preset" }>): Record<string, unknown> {
  const { recipe, inputs, look, files, author, line, note, homepage, links, licence } = e.def;
  return {
    id: e.source === "shipped" ? e.id.replace(/^shipped:/, "") : slug(e.name),
    name: e.name,
    ...(author ? { author } : {}),
    ...(line ? { line } : {}),
    ...(note ? { note } : {}),
    ...(homepage ? { homepage } : {}),
    ...(links?.length ? { links } : {}),
    ...(licence ? { licence } : {}),
    ...(recipe ? { recipe } : {}),
    inputs,
    ...(look && (look.cast.length || look.style || look.snippets?.length) ? { look } : {}),
    files: files ?? [],
  };
}

/** The preset in the browser's downloads, as JSON. */
export function savePresetFile(e: Extract<Entity, { kind: "preset" }>): void {
  const out = presetToFile(e);
  saveJson(out, `${out.id}.json`);
}

/** A preset file brought in: becomes one of the user's presets. A file that is not JSON, or not a preset, says so plainly. */
export async function importPresetFile(file: File): Promise<Entity> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not a preset file: it is not JSON.`);
  }
  const { name, def } = presetOfFile(raw, file.name);
  return api.createEntity("preset", name, def);
}

/** What a preset file holds, as a preset: its name (else the file's), and what it sets. Throws, in plain words, for anything else. */
export function presetOfFile(raw: unknown, fileName: string): { name: string; def: PresetDef } {
  const read = readPresetFile(raw);
  if ("error" in read) throw new Error(`${fileName} is not a preset file: ${read.error}.`);
  const name = read.name?.trim() || fileName.replace(/\.json$/i, "");
  return { name, def: read.def as PresetDef };
}
