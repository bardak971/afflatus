/**
 * What a model file says about itself. A .safetensors file starts with a header, and trainers write
 * things into it: a name, the model it was trained for, sometimes a trigger phrase, and (kohya's
 * trainer, the common one) how often each caption word was used. Nothing here is certain to be
 * present: a file can say nothing at all.
 */
export interface ModelInfo {
  /** The name its author gave it, when that is not just the file name. */
  title?: string;
  /** The model family it was trained for, in plain words ("SDXL", "Wan 2.2"). */
  base?: string;
  /** The checkpoint it was trained on, as the trainer recorded it. */
  trainedOn?: string;
  /** The words that call it up, when its author wrote them down. */
  trigger?: string;
  /** The caption words it was trained with, most used first. The first ones are usually what triggers it. */
  tags?: string[];
  /** What its author wrote about it. */
  about?: string;
  /**
   * The hash of its weights, as the trainer wrote it in the file (12 letters and digits): the same for
   * the same LoRA under any file name, and the one Civitai knows its versions by.
   */
  fingerprint?: string;
  /**
   * Its base model as its version's page on Civitai gives it ("LTXV 2.3", "Wan Video 2.2 I2V-A14B"), found by its hash in
   * Settings › Models: not from the file, and finer than `base` (which says "LTX" for every LTX).
   */
  civitaiBase?: string;
}

/** The reading of a file's header that is current: raised when more is read from it, so that what was read before is read again. */
export const MODEL_INFO_VERSION = 4;

/**
 * The ComfyUI model folder a node's file input reads from, told from the input's name (and the node's,
 * where the name alone does not say). Null when it cannot be told.
 */
export function folderOfFileInput(classType: string, input: string): string | null {
  if (/^ckpt_name/.test(input)) return "checkpoints";
  if (/^unet_name/.test(input)) return "diffusion_models";
  if (/^vae_name/.test(input)) return "vae";
  if (/^clip_name/.test(input)) return /vision/i.test(classType) ? "clip_vision" : "text_encoders";
  if (input === "text_encoder") return "text_encoders";
  if (/^lora(_name)?(_?\d+)?$/.test(input) || /^lora_/.test(input)) return "loras";
  if (/^control_net_name/.test(input)) return "controlnet";
  if (input === "model_name" && /upscale/i.test(classType)) return "upscale_models";
  // the Impact pack's detectors and segmenters (the face detailer's eyes and faces)
  if (input === "model_name" && /ultralytics|detectorprovider/i.test(classType)) return "ultralytics";
  if (input === "model_name" && /^SAMLoader/i.test(classType)) return "sams";
  if (/lora/i.test(classType) && /name|file/.test(input)) return "loras";
  return null;
}

/** A trainer's name for a model family, as a person would say it. What is not recognised is kept as written. */
export function baseLabel(raw: string): string {
  const s = raw.toLowerCase();
  if (/wan[\s._-]*2[\s._-]*2/.test(s)) return "Wan 2.2";
  if (/wan/.test(s)) return "Wan 2.1";
  if (/minimax|(^|[^a-z])h3([^a-z]|$)/.test(s)) return "MiniMax H3";
  if (/klein/.test(s)) return "FLUX.2 Klein";
  if (/flux[\s._-]*2/.test(s)) return "FLUX.2";
  if (/flux/.test(s)) return "FLUX.1";
  if (/ltx/.test(s)) return "LTX";
  if (/hunyuan/.test(s)) return "Hunyuan";
  if (/krea[\s._-]*2|(^|[^a-z0-9])k2([^a-z0-9]|$)/.test(s)) return "Krea 2";
  // before the Qwens: Z-Image's files name its text encoder ("z_image_turbo_qwen_3_4b")
  if (/z[\s._-]*image/.test(s)) return "Z-Image";
  if (/qwen[\s._-]*image[\s._-]*2[._]1|qwen[\s._-]*2[._]1/.test(s)) return "Qwen Image 2.1";
  if (/qwen/.test(s)) return "Qwen Image";
  if (/chroma/.test(s)) return "Chroma";
  // "xl" as a word of its own: a file name can hold those two letters by chance
  if (/sdxl|(^|[^a-z])xl([^a-z]|$)|illustrious|pony|noob/.test(s)) return "SDXL";
  if (/stable-diffusion-v?3|sd3/.test(s)) return "SD 3";
  if (/stable-diffusion-v?2|sd_?v?2/.test(s)) return "SD 2";
  if (/stable-diffusion-v?1|sd_?v?1/.test(s)) return "SD 1.5";
  return raw.replace(/\/lora.*$/i, "");
}

/** A version of a model, as its files' names say it (and a LoRA's base model on Civitai), and the hashes of its own files. */
export interface LineVersion {
  /** As a power user says it: "LTX-2", "LTX 2.3". */
  is: string;
  /** Regex sources tried against the file's path (and a LoRA's trained-on model and Civitai base), case-insensitive. */
  name: string[];
  /** SHA-256 (upper or lower case) of its published files: a copy renamed is still told. */
  sha256?: string[];
}

/** A model's versions, whose files do not go with each other's. */
export interface ModelLine {
  /** The family's own version (one of `versions`). */
  own: string;
  versions: LineVersion[];
}

const testedBy = (sources: readonly string[] | undefined, text: string) =>
  (sources ?? []).some((s) => {
    try {
      return new RegExp(s, "i").test(text);
    } catch {
      return false;
    }
  });

/**
 * The version of its line a file is for: by its hash first (a renamed copy), then its name, then, for a LoRA, the model it
 * says it was trained on and its base model on Civitai. Null when nothing says.
 *
 * A hash listed under several versions is one file shipped for each (LTX 2.5's temporal upscaler is 2.3's, byte for byte,
 * card #104): it goes with each of them, so it is the line's own version when that is one of them, else the name decides
 * among them.
 */
export function versionOf(line: ModelLine, file: string, sha?: string, info?: ModelInfo): string | null {
  const byHash = line.versions.filter((v) => Boolean(sha && v.sha256?.some((h) => h.toUpperCase() === sha.toUpperCase()))).map((v) => v.is);
  if (byHash.length > 1 && byHash.includes(line.own)) return line.own;
  if (byHash.length === 1) return byHash[0]!;
  for (const text of [file, info?.trainedOn, info?.civitaiBase]) {
    if (!text) continue;
    const hit = line.versions.find((v) => testedBy(v.name, text));
    if (hit && (!byHash.length || byHash.includes(hit.is))) return hit.is;
  }
  return byHash[0] ?? null;
}

/** Versions of one model whose LoRAs are known to carry over (a Wan 2.1 LoRA works on Wan 2.2). */
export function baseGroup(label: string): string {
  return /^Wan\b/.test(label) ? "Wan" : label;
}

/**
 * Whether a file whose weights (or metadata) say it is for `base` is made for the family called
 * `familyName`: the same model, or a version of it whose files carry over. Unknown bases never fit.
 */
export function sameBase(base: string | undefined, familyName: string): boolean {
  if (!base) return false;
  return baseGroup(baseLabel(base)) === baseGroup(baseLabel(familyName));
}

/**
 * How well a LoRA suits a model family: 2 made for it, 1 probably (a close version, or only its file
 * name says so), 0 unknown (the file says nothing), -1 made for another model.
 */
export function loraFit(family: { name: string; loraMatch?: string[]; line?: ModelLine }, file: string, info?: ModelInfo): 2 | 1 | 0 | -1 {
  // a LoRA for another version of a model whose versions do not share LoRAs (LTX 2.3 on 2.5) is for another model
  const version = family.line ? versionOf(family.line, file, undefined, info) : null;
  if (version && version !== family.line!.own) return -1;
  const wanted = baseLabel(family.name);
  const patterns = (family.loraMatch ?? []).flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      return [];
    }
  });
  if (info?.base) {
    if (info.base === wanted) return 2;
    if (patterns.some((re) => re.test(info.base!) || re.test(info.trainedOn ?? ""))) return 2;
    return baseGroup(info.base) === baseGroup(wanted) ? 1 : -1;
  }
  // a file that does not say: its name or folder can still give it away
  const named = `${info?.trainedOn ?? ""} ${file}`;
  if (patterns.some((re) => re.test(named))) return 1;
  const told = baseLabel(named);
  return told !== named && baseGroup(told) === baseGroup(wanted) ? 1 : 0;
}

/**
 * Lines of checkpoints within one family whose LoRAs do not carry over to each other: they are all
 * SDXL, but a Pony LoRA does little on an Illustrious checkpoint. (NoobAI is built on Illustrious and
 * shares its LoRAs.)
 */
const LINES: Array<[string, RegExp]> = [
  ["Illustrious", /illustrious|noob|(^|[^a-z])(il[\s._-]?xl|illu|nai[\s._-]?xl)([^a-z]|$)/i],
  ["Pony", /pony|(^|[^a-z])pdxl([^a-z]|$)/i],
  ["Animagine", /animagine/i],
];
/** The line a model or a LoRA belongs to, as far as its names say. */
export function lineOf(text: string): string | null {
  return LINES.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Words any model file can have in its name: they say nothing about which model it is. */
const GENERIC = /^(nsfw|sfw|checkpoint|checkpoints|model|models|pruned|turbo|hybrid|scaled|convrot|diffusion|realistic|realism|anime|base|final|version|sdxl|lora|loras|noise|high|low|safetensors|mix|merge|unet|vae|clip|main|default|other|misc|test|new|old|fp\d+.*|int\d+.*|bf\d+.*|q\d.*|v\d.*|\d+.*)$/;

/**
 * The words a model's file is known by: the folders it is kept in (the user's own sorting) and the
 * words of its name, without the ones any model has ("pruned", "fp8", "v10").
 */
export function identityWords(file: string): string[] {
  const parts = file.split(/[\\/]/);
  const stem = (parts.pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
  const words = stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 5 && !GENERIC.test(w));
  const folders = parts.map((p) => p.toLowerCase().trim()).filter((p) => p.length >= 3 && !GENERIC.test(p));
  return [...new Set([...folders, ...words])];
}

/**
 * How well a LoRA suits the very model that is picked, beyond its family: 2 trained on that model,
 * 1 made for the same line (Illustrious, Pony) or named or filed like it, 0 nothing says so, -1 made
 * for another line of the same family.
 */
export function modelFit(model: string, lora: string, info?: ModelInfo): 2 | 1 | 0 | -1 {
  const stem = (f: string) => (f.split(/[\\/]/).pop() ?? f).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  if (info?.trainedOn && stem(info.trainedOn) === stem(model)) return 2;
  const about = `${info?.trainedOn ?? ""} ${info?.title ?? ""} ${lora}`;
  const mine = lineOf(model);
  const its = lineOf(about);
  if (mine && its) return mine === its ? 1 : -1;
  const hay = about.toLowerCase();
  return identityWords(model).some((w) => hay.includes(w)) ? 1 : 0;
}
