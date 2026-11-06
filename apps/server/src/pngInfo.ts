import { baseName, dryContext, isModelFile, modelStem, parseInput, type InputSpec, type Recipe, type RegionValue } from "@afflatus/core";
import { a1111Slots, MEDIA_TYPES, SAMPLER_NAMES, SCHEDULE_NAMES } from "./a1111";
import { VERSION } from "./config";
import type { Tables } from "./db";
import { pictureOut } from "./pictureWords";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * How a render was made, written into its picture on the way out (a download, a timeline export), beside the AI mark:
 *  - A1111's "parameters" text, the one A1111, Forge, ComfyUI's readers and Civitai read: the prompt, the negative, the
 *    sampling settings, the model's and the LoRAs' short hashes (AutoV2, the first ten of the SHA-256 Afflatus already
 *    keeps for every model file), by which Civitai links a posted picture to them, and their Civitai versions when known;
 *  - "afflatus": the form itself, for an exact round trip into the same model's form (embedded.ts reads it back).
 * Never a path on this computer: the model and the LoRAs go by their file stems, and the pictures a form was given (the
 * library's ids, meaningless elsewhere) are left out. Settings › Storage turns it off (`pngInfo`); the prompt leaves with
 * the file otherwise, which the switch's "?" says. Nothing is hashed here: a file not hashed yet goes without its hash.
 */

/** What the text is made from, in A1111's terms where it has them. */
export interface InfoFields {
  prompt: string;
  negative?: string;
  steps?: number;
  /** ComfyUI's names: written as A1111's (a1111Sampler). */
  sampler?: string;
  scheduler?: string;
  cfg?: number;
  seed?: number;
  width?: number;
  height?: number;
  model?: { name: string; hash?: string; civitai?: number };
  loras?: Array<{ name: string; weight: number; hash?: string; civitai?: number }>;
  denoise?: number;
  clipSkip?: number;
  hires?: { scale?: number; steps?: number; upscaler?: string; denoise?: number };
  version?: string;
}

const a1111Sampler = (sampler: string | undefined) => (sampler ? SAMPLER_NAMES[sampler] ?? sampler : undefined);
const a1111Schedule = (scheduler: string | undefined) => (scheduler ? SCHEDULE_NAMES[scheduler] ?? scheduler : undefined);

/** A1111's `quote` (infotext_utils.py): a value with a comma, a colon or a new line goes in JSON quotes, else as it is. */
const quote = (v: string) => (/[,:\n]/.test(v) ? JSON.stringify(v) : v);

/** A1111's own rounding of a figure: 7 for 7.0, 0.55 for 0.55. */
const figure = (n: number) => String(Math.round(n * 1000) / 1000);

/** A LoRA's name as A1111 lists it in "Lora hashes": without the signs that split that list (extra_networks_lora.py). */
const loraKey = (name: string) => name.replace(/[:,]/g, "");

/**
 * The "parameters" text, as A1111's create_infotext writes it: the prompt (its LoRAs as `<lora:name:weight>` tags, as
 * A1111 has them), "Negative prompt:", then one line of `key: value` pairs in A1111's order. The line starts with Steps,
 * which A1111 and Civitai find it by: a picture whose steps are not known gets no text rather than one they cannot read.
 */
export function infotext(f: InfoFields): string | null {
  if (!f.steps) return null;
  const tags = (f.loras ?? []).map((l) => `<lora:${l.name}:${figure(l.weight)}>`).join(" ");
  const said = f.prompt.trim();
  const prompt = !tags ? said : !said ? tags : `${said}${said.endsWith(",") ? "" : ","} ${tags}`;
  const hashed = (f.loras ?? []).filter((l) => l.hash);
  const civitai = [
    ...(f.model?.civitai ? [{ type: "checkpoint", modelVersionId: f.model.civitai, modelName: f.model.name }] : []),
    ...(f.loras ?? []).filter((l) => l.civitai).map((l) => ({ type: "lora", weight: l.weight, modelVersionId: l.civitai, modelName: l.name })),
  ];
  const pairs: Array<[string, string | number | undefined]> = [
    ["Steps", f.steps],
    ["Sampler", a1111Sampler(f.sampler)],
    ["Schedule type", a1111Schedule(f.scheduler)],
    ["CFG scale", f.cfg !== undefined ? figure(f.cfg) : undefined],
    ["Seed", f.seed],
    ["Size", f.width && f.height ? `${f.width}x${f.height}` : undefined],
    ["Model hash", f.model?.hash],
    ["Model", f.model?.name],
    ["Denoising strength", f.hires?.denoise ?? f.denoise],
    ["Clip skip", f.clipSkip && f.clipSkip > 1 ? f.clipSkip : undefined],
    ["Hires upscale", f.hires?.scale],
    ["Hires steps", f.hires?.steps],
    ["Hires upscaler", f.hires?.upscaler],
    ["Lora hashes", hashed.length ? hashed.map((l) => `${loraKey(l.name)}: ${l.hash}`).join(", ") : undefined],
    ["Version", f.version],
  ];
  const line = pairs.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}: ${quote(String(v))}`);
  // Civitai's own key, last as Civitai writes it: its JSON is read whole by Civitai and by embedded.ts (A1111 skips it)
  if (civitai.length) line.push(`Civitai resources: ${JSON.stringify(civitai)}`);
  const negative = f.negative?.trim() ? `\nNegative prompt: ${f.negative.trim()}` : "";
  return `${prompt}${negative}\n${line.join(", ")}`.trim();
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * The sampling settings of a graph, for a form that does not have them as inputs (a family that fixes its steps and
 * sampler in its build): the first of each the graph sets by value, in its nodes' order (the first pass is built first).
 */
export function samplingOf(graph: Graph): Pick<InfoFields, "steps" | "cfg" | "sampler" | "scheduler"> {
  const out: Pick<InfoFields, "steps" | "cfg" | "sampler" | "scheduler"> = {};
  const nodes = Object.entries(graph).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b)).map(([, n]) => n);
  for (const n of nodes) {
    const i = n.inputs;
    if (out.steps === undefined && typeof i.steps === "number" && i.steps > 0) out.steps = i.steps;
    if (out.cfg === undefined && typeof i.cfg === "number") out.cfg = i.cfg;
    if (out.sampler === undefined && typeof i.sampler_name === "string") out.sampler = i.sampler_name;
    if (out.scheduler === undefined && typeof i.scheduler === "string") out.scheduler = i.scheduler;
  }
  return out;
}

/** A value that names a place on this computer (C:\…, \\server\…, /home/…): never written, whatever input holds it. */
const isPath = (v: string) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v);

/**
 * A region as it goes out: its box and words, its own LoRA by its file name. The cast person (a kit id), their LoRA (put in
 * by the server, with the sub-folder it sits in) and a painted mask (an upload's name) mean nothing elsewhere and name
 * what is on this computer, so they are left out: read back, the box keeps its words, which already hold the person's.
 */
const ownRegion = ({ cast: _cast, castLora: _castLora, mask: _mask, lora, ...r }: RegionValue): Omit<RegionValue, "cast" | "castLora" | "mask"> =>
  ({ ...r, ...(lora ? { lora: { file: baseName(lora.file), weight: lora.weight } } : {}) });

/**
 * The form as it goes into the "afflatus" text: every setting but the library's pictures, sounds and clips; a model file
 * by its name alone; nothing that looks like a path. Read back, a model goes by its stem (fromPicture.ts sameModel).
 */
function ownForm(recipe: Recipe<any>, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of recipe.inputs as InputSpec[]) {
    const v = input[spec.id];
    if (v === undefined || MEDIA_TYPES.has(spec.type)) continue;
    if (spec.type === "loras" && Array.isArray(v)) out[spec.id] = (v as Array<{ file: string; weight: number }>).map((l) => ({ file: baseName(l.file), weight: l.weight }));
    else if (spec.type === "regions" && Array.isArray(v)) out[spec.id] = (v as RegionValue[]).map(ownRegion);
    else if (typeof v === "string") {
      if (isPath(v)) continue;
      out[spec.id] = isModelFile(v) ? baseName(v) : v;
    } else out[spec.id] = v;
  }
  return out;
}

/** The text of the "afflatus" chunk: which form, its version, and the form. Read by embedded.ts. */
const ownText = (recipe: Recipe<any>, input: Record<string, unknown>, seed: number | undefined) =>
  JSON.stringify({ afflatus: 1, recipe: recipe.id, version: recipe.version, input: { ...ownForm(recipe, input), ...(seed !== undefined ? { [(recipe.inputs as InputSpec[]).find((i) => i.type === "seed")?.id ?? "seed"]: seed } : {}) } });

/**
 * What the texts of several pictures going out at once read alike (a selection's zip of 2000 renders): the hashes table,
 * read once for all of them rather than once a picture. Left empty, each read is made for that one picture.
 */
export interface OutgoingReads {
  hashes?: Promise<Array<Pick<Tables["model_hashes"], "folder" | "file" | "sha256" | "civitai_version">>>;
}

/** A model file's short hash (AutoV2) and Civitai version, from what Afflatus has hashed. */
type Known = { hash?: string; civitai?: number };
const shortHash = (sha256: string | null | undefined) => (sha256 ? sha256.slice(0, 10).toLowerCase() : undefined);

/**
 * The texts a render's picture goes out with, by keyword; empty when it is not a render of a form still here, or the
 * switch is off. `a` is the item downloaded: only its own render is said (a cut or a mirrored copy is another picture).
 */
async function infoTexts(s: Pick<Services, "db" | "registry">, a: Pick<Tables["assets"], "generation_id" | "width" | "height">, reads: OutgoingReads): Promise<Record<string, string>> {
  if (!a.generation_id || !(await readSettings(s.db)).pngInfo) return {};
  const g = await s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "resolved"]).where("id", "=", a.generation_id).executeTakeFirst();
  const recipe = g ? s.registry.recipe(g.recipe_id) : undefined;
  if (!g || !recipe || recipe.output !== "image") return {};
  const stored = JSON.parse(g.inputs) as Record<string, unknown>;
  let input = stored;
  try {
    input = parseInput(recipe, stored) as Record<string, unknown>;
  } catch {
    /* a form from before its recipe changed: read as it was stored */
  }
  const seed = (JSON.parse(g.resolved) as { seed?: unknown }).seed;
  const seedOf = typeof seed === "number" && seed >= 0 ? seed : undefined;
  const specs = recipe.inputs as InputSpec[];

  // what the graph loaded, with the hashes it ran on (modelUses.ts); what was hashed since, by name
  const used = await s.db.selectFrom("model_uses").select(["folder", "file", "sha256"]).where("generation_id", "=", g.id).execute();
  reads.hashes ??= s.db.selectFrom("model_hashes").select(["folder", "file", "sha256", "civitai_version"]).execute();
  const hashes = await reads.hashes;
  const known = (folder: string | null, file: string): Known => {
    const inFolder = (x: { folder: string }) => !folder || x.folder === folder;
    // ComfyUI on Windows names a sub-folder's file with a backslash; the hashes keep forward slashes (modelHashes.ts)
    const key = (f: string) => f.replace(/\\/g, "/").toLowerCase();
    const same = (x: { folder: string; file: string }) => inFolder(x) && key(x.file) === key(file);
    const sha = used.find(same)?.sha256 ?? hashes.find(same)?.sha256;
    // the same bytes matched to Civitai under any name (a copy, a file renamed since)
    const civitai = sha ? hashes.find((h) => h.sha256 === sha && Number(h.civitai_version) > 0)?.civitai_version : undefined;
    return { hash: shortHash(sha), ...(Number(civitai) > 0 ? { civitai: Number(civitai) } : {}) };
  };

  const slot = a1111Slots(recipe);
  const text = (i: InputSpec | undefined) => (i && typeof input[i.id] === "string" ? (input[i.id] as string).trim() : "");
  // the quality tags go in front of the prompt, as the SDXL forms send them
  const prompt = [text(slot.quality).replace(/,\s*$/, ""), text(slot.prompt)].filter(Boolean).join(", ");

  const modelInput = slot.model;
  const picked = modelInput && typeof input[modelInput.id] === "string" ? (input[modelInput.id] as string) : undefined;
  const loaded = used.find((u) => u.folder === "checkpoints" || u.folder === "diffusion_models");
  const ownFile = (recipe.files ?? []).find((f) => /ckpt_name|unet_name/.test(f.input))?.file;
  const modelFile = picked ?? loaded?.file ?? ownFile;
  // modelStem strips the folders as well
  const model = modelFile ? { name: modelStem(modelFile), ...known(picked ? modelInput!.folder : loaded?.folder ?? null, modelFile) } : undefined;

  const loras = (slot.loras && Array.isArray(input[slot.loras.id]) ? (input[slot.loras.id] as Array<{ file: string; weight: number }>) : [])
    .map((l) => ({ name: modelStem(l.file), weight: l.weight, ...known("loras", l.file) }));

  const num = (i: InputSpec | undefined) => (i && typeof input[i.id] === "number" ? (input[i.id] as number) : undefined);
  const str = (i: InputSpec | undefined) => (i && typeof input[i.id] === "string" ? (input[i.id] as string) : undefined);
  // a Turbo render (FLUX, Qwen and the like) ran its own step count, not the form's Steps
  const turbo = input.fast === true ? num(specs.find((i) => i.id === "turboSteps")) : undefined;
  const form = { steps: turbo ?? num(slot.steps), cfg: num(slot.cfg), sampler: str(slot.sampler), scheduler: str(slot.scheduler) };
  // what the form does not set, its build does: read off the graph it makes, built dry (no ComfyUI asked, nothing sent)
  let graph: Pick<InfoFields, "steps" | "cfg" | "sampler" | "scheduler"> = {};
  if (Object.values(form).some((v) => v === undefined)) {
    try {
      const uploads: Record<string, string> = {};
      const media: Record<string, { width: number; height: number }> = {};
      for (const spec of specs) if (MEDIA_TYPES.has(spec.type) && input[spec.id] !== undefined) {
        uploads[spec.id] = "stand-in";
        media[spec.id] = { width: a.width ?? 1024, height: a.height ?? 1024 };
      }
      graph = samplingOf(recipe.build(input, dryContext({ seed: seedOf ?? 1, uploads, media })).graph as Graph);
    } catch {
      /* a build that needs what a dry one lacks: the form's own settings only */
    }
  }

  const asked = slot.size ? (input[slot.size.id] as { width?: number; height?: number } | undefined) : undefined;
  const hires = slot.hires && input.hires === true ? slot.hires : undefined;
  const clipSkip = num(slot.clipSkip);
  const fields: InfoFields = {
    prompt, negative: text(slot.negative),
    steps: form.steps ?? graph.steps, cfg: form.cfg ?? graph.cfg, sampler: form.sampler ?? graph.sampler, scheduler: form.scheduler ?? graph.scheduler,
    seed: seedOf,
    // the first pass's size, as A1111 writes it beside its hires fix; else the picture's own
    width: asked?.width ?? a.width ?? undefined, height: asked?.height ?? a.height ?? undefined,
    model, loras,
    ...(slot.strength && !hires ? { denoise: num(slot.strength) } : {}),
    ...(clipSkip ? { clipSkip } : {}),
    ...(hires ? { hires: { scale: num(hires.scale), steps: num(hires.steps), denoise: num(hires.denoise), upscaler: typeof input.hiresUpscaler === "string" ? (input.hiresUpscaler === "latent" ? "Latent" : modelStem(input.hiresUpscaler)) : undefined } } : {}),
    version: `Afflatus ${VERSION}`,
  };
  const parameters = infotext(fields);
  return { ...(parameters ? { parameters } : {}), afflatus: ownText(recipe, input, seedOf) };
}

/**
 * A render's picture as it leaves Afflatus: marked as made by a model (aiMark.ts), with how it was made when the switch is on.
 * The texts it came with are dropped first, the switch on or off: ComfyUI's own "prompt" and "workflow" hold the whole
 * graph, every model and LoRA with its sub-folder and an imported workflow's paths, which the switch's "?" promises never
 * leave; the "parameters" and "afflatus" written here say the same settings without them (review 2026-11-05 S1). A JPEG or
 * a WebP gets the same, its "parameters" in EXIF as A1111 writes them (pictureWords.ts, review 2026-11-05b N3).
 * What cannot be read for it (a generation gone) leaves it with the mark alone: a download never fails for its text.
 */
export async function outgoingRender(s: Pick<Services, "db" | "registry">, a: Pick<Tables["assets"], "generation_id" | "width" | "height">, bytes: Uint8Array, reads: OutgoingReads = {}): Promise<Uint8Array> {
  const texts = await infoTexts(s, a, reads).catch(() => ({}));
  return pictureOut(bytes, { mark: true, texts });
}

/**
 * A picture the user brought in, as it leaves: as it came with the switch on (its texts are the user's own, put there before
 * Afflatus had it), without them with the switch off, which says a download carries nothing of how a picture was made:
 * a JPEG's EXIF (A1111's "parameters", a phone's GPS) and XMP go as a PNG's texts do, its orientation kept.
 */
export async function outgoingOwn(s: Pick<Services, "db">, bytes: Uint8Array): Promise<Uint8Array> {
  return (await readSettings(s.db)).pngInfo ? bytes : pictureOut(bytes, { mark: false });
}
