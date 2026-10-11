/**
 * Which model a .safetensors file is for, told from the names and shapes of its tensors, the way ComfyUI
 * itself tells a model's architecture when it loads it (comfy/model_detection.py). A file name says what
 * its author chose to say; the weights cannot lie. Works for a model file and for a LoRA: a LoRA's keys
 * name the layers of the model it patches, under a prefix of its trainer's choosing.
 */

/** The tensors of a header: name → shape. Everything in a safetensors header but `__metadata__`. */
export function tensorsOf(header: Record<string, unknown>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [name, v] of Object.entries(header)) {
    if (name === "__metadata__" || !v || typeof v !== "object") continue;
    const shape = (v as { shape?: unknown }).shape;
    if (Array.isArray(shape) && shape.every((n) => typeof n === "number")) out.set(name, shape as number[]);
  }
  return out;
}

/** The wrappers a trainer or a loader puts before a layer's name, and the LoRA suffixes after it. */
const PREFIXES = [
  "model.diffusion_model.", "diffusion_model.", "lora_unet_", "lora_transformer_", "lora_prior_unet_", "transformer.", "unet.", "net.", "base_model.model.",
];
const SUFFIXES = /\.(lora_down|lora_up|lora_A|lora_B|alpha|diff|diff_b|dora_scale|hada_w1_a|hada_w1_b|hada_w2_a|hada_w2_b|lokr_w1|lokr_w2|lokr_w1_a|lokr_w1_b|lokr_w2_a|lokr_w2_b|weight|bias|scale)(\.weight)?$/;

/** A layer's name as the model knows it: wrappers off, LoRA suffixes off, lower case. */
function layerOf(key: string): string {
  let k = key;
  for (let again = true; again; ) {
    again = false;
    for (const p of PREFIXES) if (k.startsWith(p)) { k = k.slice(p.length); again = true; }
  }
  return k.replace(SUFFIXES, "").toLowerCase();
}

/** A pattern over layer names where "." and "_" are the same separator (kohya writes "_" for both). */
const matcher = (pattern: string) => new RegExp("^" + pattern.replace(/[._]/g, "[._]").replace(/\*/g, "[^.]*"));

interface Architecture {
  /** The family, named as `baseLabel` names it ("FLUX.1", "Wan 2.2", "SDXL", "Krea 2"). */
  base: string;
  /** A word more, when the weights say it: "Klein", "I2V", "refiner", "AV"... */
  note?: string;
}

/**
 * The architecture behind a set of tensors, or null when the weights are not of a kind this knows
 * (a text encoder, a VAE, an upscaler, an unknown model). `shapes` is what the header gave; a LoRA's
 * shapes are those of its low-rank factors, which still hold the width of the layer they patch.
 */
export function architectureOf(tensors: Map<string, number[]>): Architecture | null {
  if (!tensors.size) return null;
  const layers = new Map<string, number[]>();
  for (const [k, shape] of tensors) {
    const l = layerOf(k);
    // the first shape seen for a layer: for a LoRA, lora_down (rank × in) comes before lora_up in most files
    if (!layers.has(l)) layers.set(l, shape);
  }
  const names = [...layers.keys()];
  const has = (pattern: string) => {
    const re = matcher(pattern);
    return names.some((n) => re.test(n));
  };
  const shapeOf = (pattern: string): number[] | undefined => {
    const re = matcher(pattern);
    const hit = names.find((n) => re.test(n));
    return hit ? layers.get(hit) : undefined;
  };
  // the width of a layer's input: a model's weight is (out × in); a LoRA's lora_down is (rank × in), its lora_A likewise
  const inWidth = (pattern: string): number | undefined => {
    const s = shapeOf(pattern);
    return s && s.length >= 2 ? s[s.length - 1] : undefined;
  };

  if (has("video_patch_proj") && has("audio_patch_proj")) return { base: "MiniMax H3" };
  if (has("txtfusion")) return { base: "Krea 2" };
  // the single-stream DiTs by the names of their attention: H3 writes qkv_proj / out_proj (and a token refiner), Krea 2 wq / wk / wv / wo and a gate
  if (has("blocks.0.attn.qkv_proj") || has("token_refiner.blocks.0.attn")) return { base: "MiniMax H3" };
  if (has("blocks.0.attn.wq") && (has("blocks.0.attn.gate") || has("blocks.0.mlp.gate"))) return { base: "Krea 2" };
  if (has("audio_adaln_single")) return { base: "LTX", note: "AV" };
  if (has("adaln_single.emb.timestep_embedder")) return { base: "LTX" };
  if (has("txt_in.individual_token_refiner")) return { base: "Hunyuan" };
  if (has("cap_embedder.1") && has("noise_refiner.0")) {
    // the NextDiTs: Z-Image reads Qwen3 4B (2560 wide), Lumina Image 2.0 reads Gemma 2 2B (2304 wide), in the input of cap_embedder.1
    return inWidth("cap_embedder.1") === 2304 ? { base: "Lumina 2" } : { base: "Z-Image" };
  }

  if (has("double_blocks.0.img_attn") || has("double_blocks.0.img_mod")) {
    if (has("double_stream_modulation_img")) {
      // FLUX.2: Klein is the small one (hidden 3072 for 4B, 4096 for 9B); the big model is wider
      const hidden = shapeOf("img_in")?.[0] ?? shapeOf("double_blocks.0.img_attn.qkv")?.[0];
      const klein = hidden === undefined ? true : hidden <= 4096;
      return klein ? { base: "FLUX.2 Klein" } : { base: "FLUX.2" };
    }
    if (has("distilled_guidance_layer")) return { base: "Chroma" };
    return { base: "FLUX.1" };
  }

  // the diffusers names of FLUX.1: single_transformer_blocks beside transformer_blocks (Qwen has no single ones)
  if (has("single_transformer_blocks.0.attn") && has("transformer_blocks.0.attn")) return { base: "FLUX.1" };
  if (has("txt_in.text_norm") && has("transformer_blocks.0.attn.norm_q") && has("modulation.1")) return { base: "Qwen Image 2.1" };
  if (has("transformer_blocks.0.attn.add_q_proj") && (has("txt_norm") || has("txt_in") || has("time_text_embed"))) return { base: "Qwen Image" };

  if (has("blocks.0.cross_attn.k") && (has("blocks.0.ffn") || has("blocks.0.self_attn") || has("patch_embedding") || has("text_embedding.0") || has("head.modulation"))) {
    // Wan: the 5B TI2V model (2.2 only) is 3072 wide; the 14B models are 5120 and 2.1 / 2.2 share one architecture
    const hidden = inWidth("blocks.0.cross_attn.k") ?? inWidth("blocks.0.self_attn.q");
    const i2v = has("img_emb") || has("blocks.0.cross_attn.k_img");
    return hidden === 3072 ? { base: "Wan 2.2", note: "5B" } : { base: "Wan", ...(i2v ? { note: "I2V" } : {}) };
  }

  const unet = has("input_blocks.0.0") || has("input_blocks.1.1") || has("input_blocks.4.1.transformer_blocks") || has("output_blocks.0.1.transformer_blocks");
  // the same UNets under the diffusers names (down_blocks / up_blocks / mid_block), as some trainers write them
  const diffusers = has("down_blocks.*.attentions.*.transformer_blocks") || has("up_blocks.*.attentions.*.transformer_blocks") || has("mid_block.attentions.0.transformer_blocks");
  if (unet || diffusers) {
    // the UNets: SD 1.5, SD 2 and SDXL differ in the width of the text they read (the input of attn2.to_k)
    const context =
      inWidth("input_blocks.*.1.transformer_blocks.0.attn2.to_k") ?? inWidth("output_blocks.*.1.transformer_blocks.0.attn2.to_k") ?? inWidth("middle_block.1.transformer_blocks.0.attn2.to_k")
      ?? inWidth("down_blocks.*.attentions.*.transformer_blocks.0.attn2.to_k") ?? inWidth("up_blocks.*.attentions.*.transformer_blocks.0.attn2.to_k") ?? inWidth("mid_block.attentions.0.transformer_blocks.0.attn2.to_k");
    if (context === 2048) return { base: "SDXL" };
    if (context === 1280) return { base: "SDXL", note: "refiner" };
    if (context === 1024) return { base: "SD 2" };
    if (context === 768) return { base: "SD 1.5" };
    // no attn2 width to read: SDXL has two transformer blocks per level and a second text encoder, SD 1.5 one of each
    if (has("input_blocks.4.1.transformer_blocks.1") || has("output_blocks.0.1.transformer_blocks.1") || has("down_blocks.1.attentions.0.transformer_blocks.1") || names.some((n) => n.startsWith("lora_te2") || n.startsWith("te2"))) return { base: "SDXL" };
    return { base: "SD 1.5" };
  }
  return null;
}
