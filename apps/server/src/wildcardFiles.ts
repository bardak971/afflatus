import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { expandWildcards, FILE_CHOICE, MissingWildcard, seededRandom, typedSeed, type InputSpec, type Recipe, type RegionValue, type WildcardFiles } from "@afflatus/core";
import { httpError } from "./errors";
import { isNetworkPath } from "./linked";

/**
 * The wildcard files `__name__` reads (core wildcards.ts): `.txt` files, one choice a line, under Afflatus's own folder
 * (`wildcards` in the data folder) and the ones ComfyUI's wildcard packs read, when ComfyUI's folder is on this computer:
 * the Impact pack's `wildcards` and `custom_wildcards`, Dynamic Prompts' `wildcards`. A pack's files are the ones its
 * users already have, put where its README says; they work here as they do in ComfyUI. Names are matched as the Impact
 * pack matches them: lower case, `/` between folders; a name with no file of its own takes every file of that name in
 * any folder (`__hats__` reads `clothes/hats.txt`).
 */

/** The packs' folders under custom_nodes, by the pack folder's name in lower case. */
const PACK_FOLDERS: Record<string, string[]> = {
  "comfyui-impact-pack": ["wildcards", "custom_wildcards"],
  "comfyui-dynamicprompts": ["wildcards"],
};

/** A folder wildcard files are read from, and whose it is ("Afflatus", or the pack's folder name). */
export interface WildcardFolder {
  path: string;
  from: string;
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);

/** The folders there are, Afflatus's own first: a name in two of them is read from the first. */
export async function wildcardFolders(dataDir: string | null, comfyDir: string): Promise<WildcardFolder[]> {
  const out: WildcardFolder[] = [];
  if (dataDir && (await isDir(join(dataDir, "wildcards")))) out.push({ path: join(dataDir, "wildcards"), from: "Afflatus" });
  const base = comfyDir.trim();
  // a ComfyUI on a share is never walked through (see isNetworkPath): its packs' files stay its own
  if (!base || isNetworkPath(base)) return out;
  const packs = await readdir(join(base, "custom_nodes"), { withFileTypes: true }).catch(() => []);
  for (const p of packs) {
    const sub = p.isDirectory() ? PACK_FOLDERS[p.name.toLowerCase()] : undefined;
    for (const f of sub ?? []) {
      const path = join(base, "custom_nodes", p.name, f);
      if (await isDir(path)) out.push({ path, from: p.name });
    }
  }
  return out;
}

/** Files at most in one folder: a folder of tens of thousands (a whole drive set by mistake) is not walked through. */
const MOST_FILES = 20_000;

/** Every `.txt` under a folder, by its name as a prompt writes it (lower case, `/`, no `.txt`). */
async function namesIn(folder: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile() || !/\.txt$/i.test(e.name)) continue;
    const path = join(e.parentPath, e.name);
    out.set(relative(folder, path).split(sep).join("/").replace(/\.txt$/i, "").toLowerCase(), path);
    if (out.size >= MOST_FILES) break;
  }
  return out;
}

/** A file's choices: its lines that are not empty, without the comments (`#`) the packs allow. */
const linesOf = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** How long the folders' list is kept before it is read again: files added are seen by the next render after that. */
const KEPT_MS = 5_000;
let kept: { key: string; at: number; names: Map<string, string[]> } | null = null;

/** Every name of the folders, with the files that answer it (more than one only through the any-folder match). */
async function indexOf(folders: WildcardFolder[]): Promise<Map<string, string[]>> {
  const key = folders.map((f) => f.path).join("\n");
  if (kept && kept.key === key && Date.now() - kept.at < KEPT_MS) return kept.names;
  const names = new Map<string, string[]>();
  for (const f of folders) for (const [name, path] of await namesIn(f.path)) if (!names.has(name)) names.set(name, [path]);
  kept = { key, at: Date.now(), names };
  return names;
}

/**
 * The files a form's texts read, all read before the texts are settled: the names in them, the names in the lines of
 * those, and so on. Their lines, by name; the core's WildcardFiles over them.
 */
async function filesFor(texts: string[], folders: WildcardFolder[]): Promise<WildcardFiles> {
  const index = await indexOf(folders);
  const lines = new Map<string, string[]>();
  const want = (text: string) => [...text.matchAll(new RegExp(FILE_CHOICE.source, "gu"))].map((m) => m[1]!.toLowerCase());
  const read = async (name: string): Promise<string[] | undefined> => {
    const paths = index.get(name) ?? [...index].filter(([n]) => n.endsWith(`/${name}`)).map(([, p]) => p[0]!);
    if (!paths.length) return undefined;
    return (await Promise.all(paths.map((p) => readFile(p, "utf8").then(linesOf, () => [])))).flat();
  };
  const queue = texts.flatMap(want);
  // a name with no file is looked for once: a text naming it a thousand times walked the whole index a thousand times
  const missed = new Set<string>();
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (lines.has(name) || missed.has(name)) continue;
    const got = await read(name);
    if (!got) {
      missed.add(name);
      continue;
    }
    lines.set(name, got);
    queue.push(...got.flatMap(want));
  }
  return (name) => lines.get(name.toLowerCase());
}

/**
 * The wildcard names a text holds that no file answers, as the prompt box says them before Render is pressed (card #318):
 * a `__colors__` with no colors.txt was said only once the job was refused. Its own names alone: the files' lines are
 * read when the job is queued.
 */
export async function missingWildcards(places: WildcardPlaces, text: string): Promise<string[]> {
  const names = [...new Set([...text.matchAll(new RegExp(FILE_CHOICE.source, "gu"))].map((m) => m[1]!.toLowerCase()))];
  if (!names.length) return [];
  const index = await indexOf(await wildcardFolders(places.dataDir, await places.comfyDir()));
  return names.filter((name) => !index.has(name) && ![...index.keys()].some((n) => n.endsWith(`/${name}`)));
}

/** What a server needs to read the files: its data folder (none in most tests) and the ComfyUI folder of its settings. */
export interface WildcardPlaces {
  dataDir: string | null;
  comfyDir: () => Promise<string>;
}

/** No folder: `__name__` is refused, `{a|b}` still settled. */
export const NO_WILDCARDS: WildcardPlaces = { dataDir: null, comfyDir: async () => "" };

/**
 * A form's texts with their choices and wildcard files settled, one pick each. With a typed seed the picks follow it, so
 * the same seed renders the same prompt again; with a random seed (drawn later, as the job is sent) they are drawn now.
 * A name with no file is refused, as a 400 that says where the files were looked for.
 */
export async function settleTexts(places: WildcardPlaces, recipe: Recipe<any>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const specs = (recipe.inputs as InputSpec[]).filter((s) => s.type === "prompt" && typeof input[s.id] === "string");
  // a region's words and a text box's letters are prompts too (card #300): `{red|blue} coat` in a box reached the encoders
  // as typed. Each is settled under a salt of its own, so that two boxes with the same choice may pick apart
  const regionsSpec = (recipe.inputs as InputSpec[]).find((s) => s.type === "regions");
  const regions = regionsSpec && Array.isArray(input[regionsSpec.id]) ? (input[regionsSpec.id] as RegionValue[]) : [];
  const parts = regions.flatMap((r, i) => (["prompt", "text"] as const).filter((key) => typeof r[key] === "string" && r[key]).map((key) => ({ i, key, salt: `${regionsSpec!.id}.${i}.${key}`, label: `Region ${i + 1}${key === "text" ? "'s text" : ""}` })));
  if (!specs.length && !parts.length) return input;
  const texts = [...specs.map((s) => input[s.id] as string), ...parts.map((p) => regions[p.i]![p.key]!)];
  const named = texts.some((t) => FILE_CHOICE.test(t));
  const folders = named ? await wildcardFolders(places.dataDir, await places.comfyDir()) : [];
  const files = named ? await filesFor(texts, folders) : undefined;
  const seed = typedSeed(input.seed);
  const settle = (text: string, salt: string, label: string) => {
    try {
      return expandWildcards(text, seed === null ? Math.random : seededRandom(seed, salt), files);
    } catch (err) {
      if (!(err instanceof MissingWildcard)) throw httpError(`${label}: ${(err as Error).message}`);
      const where = folders.length ? `looked for in ${folders.map((f) => f.path).join(", ")}` : `put it in a "wildcards" folder of Afflatus's data folder${places.dataDir ? ` (${join(places.dataDir, "wildcards")})` : ""}`;
      throw httpError(`${label}: ${err.message}, ${where}`);
    }
  };
  const out = { ...input };
  for (const s of specs) out[s.id] = settle(out[s.id] as string, s.id, s.label);
  if (parts.length) {
    const settled = regions.map((r) => ({ ...r }));
    for (const p of parts) settled[p.i]![p.key] = settle(regions[p.i]![p.key]!, p.salt, p.label);
    out[regionsSpec!.id] = settled;
  }
  return out;
}
