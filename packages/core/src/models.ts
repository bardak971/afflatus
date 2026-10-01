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
}

/**
 * The ComfyUI model folder a node's file input reads from, told from the input's name (and the node's,
 * where the name alone does not say). Null when it cannot be told.
 */
export function folderOfFileInput(classType: string, input: string): string | null {
  if (/^ckpt_name/.test(input)) return "checkpoints";
  if (/^unet_name/.test(input)) return "diffusion_models";
  if (/^vae_name/.test(input)) return "vae";
  if (/^clip_name/.test(input)) return /vision/i.test(classType) ? "clip_vision" : "text_encoders";
  if (/^lora(_name)?(_?\d+)?$/.test(input) || /^lora_/.test(input)) return "loras";
  if (/^control_net_name/.test(input)) return "controlnet";
  if (input === "model_name" && /upscale/i.test(classType)) return "upscale_models";
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
  if (/qwen/.test(s)) return "Qwen Image";
  if (/z[\s._-]*image/.test(s)) return "Z-Image";
  // "xl" as a word of its own: a file name can hold those two letters by chance
  if (/sdxl|(^|[^a-z])xl([^a-z]|$)|illustrious|pony|noob/.test(s)) return "SDXL";
  if (/stable-diffusion-v?3|sd3/.test(s)) return "SD 3";
  if (/stable-diffusion-v?2|sd_?v?2/.test(s)) return "SD 2";
  if (/stable-diffusion-v?1|sd_?v?1/.test(s)) return "SD 1.5";
  return raw.replace(/\/lora.*$/i, "");
}

/** Versions of one model whose LoRAs are known to carry over (a Wan 2.1 LoRA works on Wan 2.2). */
export function baseGroup(label: string): string {
  return /^Wan\b/.test(label) ? "Wan" : label;
}

/**
 * How well a LoRA suits a model family: 2 made for it, 1 probably (a close version, or only its file
 * name says so), 0 unknown (the file says nothing), -1 made for another model.
 */
export function loraFit(family: { name: string; loraMatch?: string[] }, file: string, info?: ModelInfo): 2 | 1 | 0 | -1 {
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
