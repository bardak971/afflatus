import { endsIn, MODEL_EXT, MODEL_EXTS, modelStem, type NodeCatalog } from "@afflatus/core";

/** A name with something before the dot: "model.safetensors", "sub\\pic.png". A bare ".png" is an extension, not a file. */
const FILE = new RegExp(String.raw`[^\\/.]` + endsIn([...MODEL_EXTS, "engine", "png", "jpe?g", "webp", "gif", "bmp", "tiff?", "mp4", "webm", "mov", "mkv", "avi", "wav", "mp3", "flac", "ogg", "m4a", "opus", "txt", "json", "ya?ml", "csv", "patch", "latent", "glb", "obj", "ply", "ttf", "otf", "woff2?"]).source, "i");

/** A model file named inside a text ("a model such as person_yolov8m-seg.pt finds…"), not only at its end. */
const NAMES_A_MODEL = new RegExp(String.raw`[^\s\\/.]\.(` + MODEL_EXTS.join("|") + String.raw`)\b`, "i");

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
const isFileList = (v: unknown): v is string[] => isStrings(v) && v.some((x) => FILE.test(x));
/** A file's name as some nodes list it: without its folder and without its extension, in lower case. */
const stemOf = (name: string) => modelStem(name).toLowerCase();

/** Every array and object of the catalog, with the means to empty a list found in it. */
function walk(value: unknown, visit: (list: string[], empty: () => void, key: string | null, holder: Record<string, unknown> | null) => boolean): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (!(isStrings(v) && visit(v, () => (value[i] = []), null, null))) walk(v, visit);
    });
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(obj)) {
      if (!(isStrings(v) && visit(v, () => (obj[key] = []), key, obj))) walk(v, visit);
    }
  }
}

/**
 * Empties every list of files in a node catalog, wherever it sits (required, optional and hidden
 * inputs alike): model names, pictures in the input folder, saved workflows. Those lists describe one
 * person's disk, so a catalog saved into the repository (the graph checker's reference) must not
 * carry them. Node names, inputs, types and fixed choices stay. Returns how many lists were emptied.
 *
 * Some nodes list the same model files by name only, without folder or extension (a "pick a LoRA to
 * insert" list). Those do not look like files, so they are found by what they hold: a list in which
 * two or more entries are the names of model files seen in the file lists is emptied too.
 */
export function stripFileLists(catalog: NodeCatalog): number {
  const models = new Set<string>();
  walk(catalog, (list) => {
    if (isFileList(list)) for (const f of list) if (MODEL_EXT.test(f)) models.add(stemOf(f));
    return false;
  });
  let n = 0;
  const named = (list: string[]) => {
    const hits = list.filter((x) => models.has(stemOf(x))).length;
    return hits >= 2 || (hits > 0 && hits === list.length);
  };
  const dropDefaults = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(dropDefaults);
    else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const [key, v] of Object.entries(obj)) {
        // the default of a list of files is one of the files
        if (key === "default" && typeof v === "string" && (FILE.test(v) || models.has(stemOf(v)))) delete obj[key];
        // a tooltip that names a model file (a node pack's example: "a person model such as person_yolov8m-seg.pt") names
        // one on this disk when it is there; the checker never reads tooltips
        else if (key === "tooltip" && typeof v === "string" && NAMES_A_MODEL.test(v)) delete obj[key];
        else dropDefaults(v);
      }
    }
  };
  walk(catalog, (list, empty) => {
    if (!isFileList(list) && !named(list)) return false;
    empty();
    n++;
    return true;
  });
  dropDefaults(catalog);
  return n;
}

/**
 * The names of model files that are still written somewhere in a catalog, given the files a ComfyUI
 * has: inside a longer text (a default prompt, a note). For checking a catalog before it is saved for
 * others to see: this should come back empty. A choice that merely is the same word as a file's name,
 * alone in a list of fixed choices, is not reported: lists of file names were emptied before.
 */
export function leftoverNames(catalog: NodeCatalog, files: string[]): string[] {
  // short names are ordinary words more often than not
  const stems = [...new Set(files.map(stemOf))].filter((x) => x.length >= 8);
  const found = new Set<string>();
  const look = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.toLowerCase();
      for (const stem of stems) if (text.length > stem.length && text.includes(stem)) found.add(stem);
    } else if (Array.isArray(value)) value.forEach(look);
    else if (value && typeof value === "object") Object.values(value).forEach(look);
  };
  look(catalog);
  return [...found];
}
