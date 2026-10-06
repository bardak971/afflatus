import type { Graph } from "@afflatus/core";

/** A file name a loader takes, as opposed to a prompt or a number. */
const MODEL_FILE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;
/** A node that loads or stacks LoRAs: its type says what it can take, not what this workflow runs on. */
const LORA_NODE = /lora/i;

/**
 * A guess at the model a workflow is for, from its node types and the files it loads: the name
 * Afflatus's own families go by, so that the workflow sits with them and shares their LoRAs and
 * saved settings. "" when nothing in the workflow says. Only a starting value for the Model field.
 * The files its loaders name are the best evidence, so they are read first; node types after.
 */
export function guessModel(graph: Graph): string {
  const nodes = Object.values(graph);
  const classes = nodes.map((n) => n.class_type).filter((c) => !LORA_NODE.test(c));
  // the diffusion model's file first: a text encoder's (a Qwen one serves other models) or a VAE's says less
  const fileOf = (n: Graph[string], re: RegExp) => Object.entries(n.inputs).filter(([k, v]) => re.test(k) && typeof v === "string" && MODEL_FILE.test(v as string)).map(([, v]) => v as string);
  const mainFiles = nodes.flatMap((n) => fileOf(n, /^(unet_name|ckpt_name|model_name|model)$/));
  // a text encoder's or a VAE's file is left out altogether: a Qwen encoder or VAE serves models of other families
  const otherFiles = nodes.flatMap((n) => fileOf(n, /^(?!unet_name$|ckpt_name$|model_name$|model$|clip_name|text_encoder|vae_name)/));
  const from = (names: string) => {
    const has = (re: RegExp) => re.test(names);
    if (has(/minimax|mmh3|(^|[^a-z0-9])h3([^a-z0-9]|$)/i)) return "MiniMax H3";
    if (has(/wan\s*2[._-]?1(?![0-9])/i)) return "Wan 2.1";
    if (has(/wanvideo|\bwan\b|wan2|wan[_-]2/i)) return "Wan 2.2";
    if (has(/qwen[_ -]?image[_ -]?2|qwen[_ -]?2[._]1/i)) return "Qwen Image 2.1";
    if (has(/qwen/i)) return "Qwen Image";
    if (has(/ltx/i)) return "LTX 2.3";
    if (has(/klein/i)) return "FLUX.2 Klein";
    if (has(/krea/i)) return "Krea 2";
    if (has(/flux/i)) return "FLUX.1";
    if (has(/hunyuan/i)) return "HunyuanVideo";
    if (has(/\bsd3|stable[_ -]?diffusion[_ -]?3/i)) return "SD 3.5";
    if (has(/sdxl|(^|[^a-z])xl([^a-z]|$)|pony|illustrious|noob/i)) return "SDXL";
    if (has(/sd15|sd[_ -]?1[._]5|v1-5/i)) return "SD 1.5";
    return "";
  };
  const byMain = from(mainFiles.join("\n"));
  if (byMain) return byMain;
  const byFile = from(otherFiles.join("\n"));
  if (byFile) return byFile;
  const byClass = from(classes.join("\n"));
  if (byClass) return byClass;
  // a plain checkpoint with nothing in its name: the latent's size tells SDXL from SD 1.5
  if (classes.includes("CheckpointLoaderSimple")) {
    const sizes = nodes.filter((n) => n.class_type === "EmptyLatentImage").flatMap((n) => [n.inputs.width, n.inputs.height]).filter((v): v is number => typeof v === "number");
    if (sizes.some((s) => s >= 1024)) return "SDXL";
    if (sizes.length && sizes.every((s) => s <= 768)) return "SD 1.5";
  }
  return "";
}
