import { api, type Entity, type PresetDef } from "./api";

/**
 * A preset as a file: the shape the presets that ship with Afflatus have (`presets/*.json`), so that a
 * preset saved from here can be imported by another Afflatus, or contributed by pull request as it is.
 */

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "preset";

export function presetToFile(e: Extract<Entity, { kind: "preset" }>): Record<string, unknown> {
  const { recipe, inputs, look, files, author, note, homepage, licence } = e.def;
  return {
    id: e.source === "shipped" ? e.id.replace(/^shipped:/, "") : slug(e.name),
    name: e.name,
    ...(author ? { author } : {}),
    ...(note ? { note } : {}),
    ...(homepage ? { homepage } : {}),
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
  const blob = new Blob([JSON.stringify(out, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${out.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A preset file brought in: becomes one of the user's presets. */
export async function importPresetFile(file: File): Promise<Entity> {
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  // either the file shape above, or a saved entity ({ name, def })
  const def: PresetDef = raw.def && typeof raw.def === "object"
    ? (raw.def as PresetDef)
    : {
        ...(typeof raw.recipe === "string" ? { recipe: raw.recipe } : {}),
        inputs: (raw.inputs as Record<string, unknown> | undefined) ?? {},
        ...(raw.look ? { look: raw.look as PresetDef["look"] } : {}),
        ...(Array.isArray(raw.files) ? { files: raw.files as PresetDef["files"] } : {}),
        ...(typeof raw.author === "string" ? { author: raw.author } : {}),
        ...(typeof raw.note === "string" ? { note: raw.note } : {}),
        ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
        ...(raw.licence && typeof raw.licence === "object" ? { licence: raw.licence as PresetDef["licence"] } : {}),
      };
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : file.name.replace(/\.json$/i, "");
  return api.createEntity("preset", name, def);
}
