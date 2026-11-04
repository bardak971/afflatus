import type { InputSpec, Recipe } from "@afflatus/core";

/**
 * Every picture form laid out by one skeleton (card #275), as h3Form lays out H3's: the owner's rule for H3 (every form alike:
 * the same rows in the same order and words, a form only adds or drops what its job needs) applied to the picture models.
 * The forms were written by three hands (the flow kit, SDXL, Klein, Qwen Image 2.1) and drifted apart: the model after the
 * prompt on SDXL alone, "Prompt" for an instruction on Klein, "Additional images" on Qwen Edit. Here the shared rows of each
 * operation are said once, in their order; a form's own rows stay right after the shared row they came after, and a shared
 * row a form does not take is named in its drop, with why (the parity test reads them).
 */

/** What a picture form does: its operation decides which rows it shares with the other families' forms of it. */
export type PictureOp = "txt2img" | "img2img" | "inpaint" | "outpaint" | "upscale" | "face" | "edit" | "own";

/** The model's row: "checkpoint" on SDXL (a checkpoint holds the model, its text encoders and its VAE), "model" elsewhere. */
const MODEL = ["model", "checkpoint"];
/** How every picture form samples, in this order: the LoRAs, the negative, then the sampler's own rows. */
const SAMPLING = ["loras", "negative", "steps", "cfg", "sampler", "scheduler", "shift", "precision"];
const DETAIL = ["detail", "detailStrength", "detailMethod", "detailStart", "detailEnd"];
/** ADetailer inside txt2img (card #272, shared/adetail.ts): a switch, a prompt, a denoise and a size gate for each detector. */
const ADETAIL = ["Face", "Hands", "Person"].flatMap((k) => [`detail${k}`, `detail${k}Prompt`, `detail${k}Denoise`, `detail${k}Under`]);
const TILES = ["tiles", "tileSize", "tileOverlap"];
const HIRES = ["hires", "hiresScale", "hiresUpscaler", "hiresDenoise", "hiresSteps", "hiresSampler", "hiresScheduler", ...TILES];
const FACE = ["detector", "faceThreshold", "faceCrop", "faceGrow", "faceSize", "faceMax", "faceFeather"];
/** Reference images and a guide picture (card #277): the same rows on every family that takes them (shared/references.ts, shared/guide.ts). */
export const REFERENCES = ["references", "referenceStrength"];
export const GUIDE = ["guide", "guideFollows", "guideStrength", "guideStart", "guideEnd", "guideLow", "guideHigh", "guideModel"];

/**
 * The shared rows of each operation, in the order every form of it shows them (the model first, the seed last). The web
 * draws a form's rows by what they are (texts, pictures, sampling, output), each group in this order.
 */
export const PICTURE_ROWS: Record<PictureOp, readonly string[]> = {
  txt2img: ["prompt", ...REFERENCES, ...GUIDE, "size", ...ADETAIL, ...DETAIL, ...SAMPLING, ...HIRES],
  img2img: ["source", "prompt", "strength", ...REFERENCES, ...GUIDE, ...SAMPLING],
  inpaint: ["source", "mask", "prompt", "strength", "maskGrow", "maskBlur", ...SAMPLING],
  outpaint: ["source", "prompt", "shape", "padLeft", "padRight", "padTop", "padBottom", "feathering", ...SAMPLING],
  upscale: ["source", "prompt", "upscaler", "factor", "refine", "strength", "colourMatch", ...TILES, ...SAMPLING],
  face: ["source", "prompt", "strength", ...FACE, ...SAMPLING],
  edit: ["source", "prompt", "references", ...SAMPLING],
  // a job of its own (a variation, a motion picture): its pictures are its own, only the model and its sampling are shared
  own: [...SAMPLING],
};

/** The words of a shared row that differ by operation: an edit's text is an instruction, the pictures it reads are references. */
const OP_LABELS: Partial<Record<PictureOp, Record<string, string>>> = {
  edit: { prompt: "Instruction", references: "Reference images" },
};

/** What each picture form drops of its operation's rows, with why, by its id (read by the parity test). */
export const PICTURE_DROPS = new Map<string, { op: PictureOp; drop: Readonly<Record<string, string>> }>();

/** A family that takes no guide picture: every guide row dropped, with the one reason. */
export const noGuide = (why: string): Record<string, string> => Object.fromEntries(GUIDE.map((id) => [id, why]));
/** A family that reads no reference image: both rows dropped, with the one reason. */
export const noReferences = (why: string): Record<string, string> => Object.fromEntries(REFERENCES.map((id) => [id, why]));
/**
 * A family's drops as one operation shares them: a family says its guide and references once (noGuide, noReferences), for its
 * txt2img and img2img. Its edit's references are the edit's own matter (Qwen Image 2.1's edit reads them where its txt2img does not).
 */
export const dropsFor = (op: PictureOp, drops: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(drops).filter(([id]) => ![...GUIDE, ...REFERENCES].includes(id) || (["txt2img", "img2img"].includes(op) && PICTURE_ROWS[op].includes(id))));

/**
 * The shared rows a form leaves out that a user looks for on every model (a guide picture, reference images): shown greyed
 * where they would be, with why (card #277), so that their absence is said rather than guessed. The others (a shift on SDXL)
 * are left out quietly.
 */
const SAID_ABSENT = [{ id: "references", label: "Reference images" }, { id: "guide", label: "Control image" }];

/** The ids of a form's operation's shared rows, the model and the seed included, in their order. */
export const pictureRowsOf = (op: PictureOp, model = "model"): string[] => [model, ...PICTURE_ROWS[op], "seed"];

/**
 * A picture form's recipe with its rows laid out by the skeleton: its operation's shared rows in their order, the form's
 * own rows each right after the shared row it came after (before the first one: after the model), and the operation's
 * words. Refuses a form that leaves a shared row out without saying why, or drops one its operation does not have.
 */
export function pictureForm<In>(op: PictureOp, recipe: Recipe<In>, drop: Record<string, string> = {}): Recipe<In> {
  const model = recipe.inputs.find((i) => MODEL.includes(i.id))?.id ?? "model";
  const shared = pictureRowsOf(op, model);
  const stale = Object.keys(drop).filter((id) => !shared.includes(id));
  if (stale.length) throw new Error(`${recipe.id} drops ${stale.join(", ")}, which its operation (${op}) does not share`);
  const lost = shared.filter((id) => drop[id] === undefined && !recipe.inputs.some((i) => i.id === id));
  if (lost.length) throw new Error(`${recipe.id} leaves out the ${op} row${lost.length > 1 ? "s" : ""} ${lost.join(", ")} without saying why (its drop)`);
  const taken = shared.filter((id) => drop[id] !== undefined && recipe.inputs.some((i) => i.id === id));
  if (taken.length) throw new Error(`${recipe.id} drops ${taken.join(", ")} and has it`);

  // each own row goes with the shared row before it; those before any go with the model
  const after = new Map<string, InputSpec[]>();
  let anchor = model;
  for (const input of recipe.inputs) {
    if (shared.includes(input.id)) anchor = input.id;
    else after.set(anchor, [...(after.get(anchor) ?? []), input]);
  }
  const words = OP_LABELS[op] ?? {};
  const inputs = shared.flatMap((id) => {
    const row = recipe.inputs.find((i) => i.id === id);
    return [...(row ? [words[id] ? { ...row, label: words[id] } : row] : []), ...(after.get(id) ?? [])];
  });
  PICTURE_DROPS.set(recipe.id, { op, drop });
  const absent = SAID_ABSENT.filter((a) => drop[a.id] !== undefined).map((a) => ({ ...a, why: drop[a.id]! }));
  return { ...recipe, inputs, ...(absent.length ? { absent } : {}) };
}
