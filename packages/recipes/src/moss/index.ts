import { defineFamily, type PromptLine, QUALITY_WORDS, WEIGHT_SYNTAX, wordCount } from "@afflatus/core";
import { flowRecipes, type FlowSpec } from "../flow/recipes";
import { noGuide, noReferences } from "../shared/pictureForm";
import { detectorSlots } from "../shared/detector";

/**
 * Comfy-Org's repack, pinned to the commit read on 2026-11-04 (the hashes are Hugging Face's own). Sizes: the SFT model 10.2 GB
 * in bf16, 5.4 GB in int8; the Qwen3.5-9B text encoder 7.3 GB (w4a8), 9.7 GB (int8), 19.3 GB (bf16); the VAE 250 MB.
 */
const HF = "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54";

/**
 * lodestones' 8-step DMD LoRA (Apache-2.0, 1.2 GB), its "latest" file, renamed as MATLOWAI's DeBand presets name it. Its own
 * 8-step use needs a sampler of its own (the rapid-moss nodes); with ComfyUI's KSampler it is a speed-up at 0.35 in 10 steps
 * at the usual CFG, MATLOWAI's "Fast" preset.
 */
const TURBO = "lodestones_moss_sft_8step_dmd_lora_latest.safetensors";
/** MATLOWAI's main banding fix (Apache-2.0, 1.1 GB): SFT's last five layers turned back into Base's, against its vertical stripes. */
const DEBAND = "moss_image_sft_banding_fix_L37-41_bf16.safetensors";

/**
 * MOSS-Image (OpenMOSS, 2026-10-16, Apache-2.0): a 5B single-stream DiT read through Qwen3.5-9B, in FLUX.2's latent space. Its
 * headline is placement: a JSON layout of boxes, each an object or a text drawn word for word, which the Regions row writes
 * (card #271). Native in ComfyUI since 0.42. The graph is ComfyUI's own template (`image_moss_image_t2i`, and
 * `image_moss_image_t2i_bboxes` for the layout): SFT at 25 steps, CFG 2.5, er_sde, the model's own shift (5); the layout
 * template turns on skip-layer guidance on block 22 for the first half of the steps. The templates' prompt enhancer (the same
 * Qwen3.5 asked to rewrite the prompt) is left to the Designer. No template does img2img, inpaint, outpaint or upscale with
 * it: txt2img only, until one does.
 */
export const moss = defineFamily({
  id: "moss",
  name: "MOSS-Image",
  summary: "txt2img with placement: boxes on the Stage, each an object or a text drawn word for word, read as MOSS-Image's JSON layout; long text in English and Chinese.",
  help: {
    what: "Pictures placed by boxes (a layout of objects and texts), with long, legible text.",
    best: "posters, signs, title cards; things where they should be",
    weak: "slow at its own settings (Turbo shortens it); faint vertical banding on smooth areas (DeBand); txt2img only, no reference pictures",
  },
  promptStyle: "sentences",
  slots: [
    {
      // SFT first (the model to generate with), then any fine-tune of it; Base is made for training, taken when it alone is there
      id: "unet", label: "Diffusion model", folder: "diffusion_models",
      detect: ["^(?!.*(base|edit|control)).*moss[ ._-]?image", "^(?!.*(edit|control)).*moss[ ._-]?image", "(^|[^a-z])moss([^a-z]|$)"],
      hint: "Put a MOSS-Image model (moss_image_sft_int8_convrot.safetensors, or moss_image_sft_bf16.safetensors) in ComfyUI's models/diffusion_models folder.",
      get: { file: "moss_image_sft_int8_convrot.safetensors", url: `${HF}/diffusion_models/moss_image_sft_int8_convrot.safetensors`, sha256: "b4d1475bc7eeffd7b809e82ea13a1fba1fb85c4e18365af3813722faa5c0fe4f" },
    },
    {
      // Qwen3.5 9B, the w4a8 file the templates load first; never Krea 2's Qwen3-VL 4B nor Klein's Qwen3 4B
      id: "clip", label: "Text encoder (Qwen3.5 9B)", folder: "text_encoders", detect: ["qwen_?3[._]?5_?9b"],
      hint: "Put qwen3.5_9b_w4a8_gptq.safetensors (or its int8_convrot or bf16 file) in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen3.5_9b_w4a8_gptq.safetensors", url: `${HF}/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors`, sha256: "4cc6a1543ad2061806da46f35f90cadb4801dcba246c44782cf42ec0feb6407c" },
    },
    {
      // FLUX.2's VAE, the small-decoder file the templates use: Klein's full one fits too
      id: "vae", label: "VAE", folder: "vae", detect: ["flux-?2.*vae.*small", "flux-?2.*vae", "full_encoder_small_decoder"],
      hint: "Put flux2-vae_small.safetensors (or Klein's flux2-vae.safetensors) in ComfyUI's models/vae folder.",
      get: { file: "flux2-vae_small.safetensors", url: `${HF}/vae/flux2-vae_small.safetensors`, sha256: "d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b" },
    },
    {
      id: "turbo", label: "Turbo LoRA (8-step DMD)", folder: "loras", detect: ["moss.*(dmd|8.?step)", "lodestones.*moss"], optional: true,
      hint: `Optional: Turbo puts ${TURBO} (lodestones' 8-step DMD LoRA) on the model at 0.35 and samples in 10 steps.`,
      get: { file: TURBO, url: "https://huggingface.co/lodestones/MOSS-Image-SFT-8-steps-dmd/resolve/f95df83b5e90ae91ea412434b3f9b7f1c8c6314f/lora_latest.safetensors", sha256: "be82ab2bef78194651815bb6de443cec67553e01c14559f2ad365449445f0452" },
    },
    {
      id: "deband", label: "DeBand LoRA", folder: "loras", detect: ["moss.*band"], optional: true,
      hint: `Optional: DeBand puts ${DEBAND} on the model, against SFT's faint vertical stripes in skies and walls.`,
      get: { file: DEBAND, url: `https://huggingface.co/MATLOWAI/MOSS-Image-SFT-DeBand/resolve/6d6b6179727a5c39c01082b6a4893a2d338d8f62/${DEBAND}`, sha256: "01329abd340dd9cf55677381a11558fe5307c7fd648f1988b441172fbbd86fd5" },
    },
    // txt2img's Detail rows find faces, hands and people with these (shared/adetail.ts)
    ...detectorSlots(["moss.text-to-picture"]),
  ],
  // ("moss" as a word of its own: a "mossy forest" style LoRA is not MOSS-Image's)
  loraMatch: ["moss[ ._-]?image", "(^|[^a-z])moss([^a-z]|$)"],
  guide: `MOSS-Image reads plain prose or booru-style tags through Qwen3.5, prompts up to about 4000 tokens; its captions were mostly English, Chinese works too. Where things go is said by the Regions boxes, not by the prompt: the prompt describes the whole picture.
RULES
- The medium and the subject first ("Editorial studio photograph of…", "Anime-style digital illustration of…"); a medium the user named stays.
- Then who or what, clothing, pose; the place, the light, the palette, the camera; one flowing paragraph, or tags, never both.
- Text that must appear: double quotes, word for word, with where it sits and how its letters look ("a marquee whose bulbs spell "MOSS" in tall capital letters"). Long texts hold; the Regions text boxes place them exactly.
- Only what IS in the picture: say the wanted state, never a ban.
- No (word:1.2) weights and no quality tags ("masterpiece, 8k"): this model does not read them.
- Faithful to the user's idea: detail, not new subjects. A LoRA's trigger words stay.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
Cinematic night street photograph: a model in an exaggerated balloon-sleeve white wool coat walking toward the camera under a huge illuminated theatre marquee, the marquee bulbs spelling "MOSS" in tall capital letters, wet asphalt with long reflections, warm tungsten glow against cold blue night, 35mm film grain, low angle.`,
  /** What the designer wrote, against MOSS-Image's guide: no weights, no quality words. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    const n = wordCount(text);
    if (n > 600) out.push({ part: main, text: `${n} words: MOSS-Image reads long prompts, but past a few hundred words the picture's own details get lost.` });
    if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: MOSS-Image does not read weights." });
    if (QUALITY_WORDS.test(text)) out.push({ part: main, text: "Quality words (masterpiece, 8k…): MOSS-Image ignores them." });
    return out;
  },
});

const spec: FlowSpec = {
  family: "moss",
  model: {
    id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["^(?!.*(edit|control)).*moss[ ._-]?image", "(^|[^a-z])moss([^a-z]|$)"],
    note: "MOSS-Image SFT, or a fine-tune of it",
  },
  encoder: {
    nodes: ["CLIPLoader"],
    load: (g, slots) => g.out("CLIPLoader", { clip_name: slots.clip, type: "moss_image", device: "default" }),
    files: (slots) => [`text_encoders/${slots.clip}`],
  },
  latent: "EmptyFlux2LatentImage",
  // the templates set none: ComfyUI's MOSS-Image samples at its own shift, 5, the authors' setting
  shift: { node: "ModelSamplingAuraFlow", default: 0, note: "0 leaves the model's own, 5 (the authors' and ComfyUI's templates')", own: { shift: 5 } },
  negative: { default: "worst quality, bad anatomy, watermark, jpeg artifact", note: "the templates' negative prompt, without their \"nsfw\"", empty: "encode" },
  sampling: {
    steps: 25, stepsNote: "25 as ComfyUI's templates; the authors' own setting is 50 at CFG 3",
    cfg: 2.5, cfgNote: "2.5 as ComfyUI's templates; the authors use 3", sampler: "er_sde", scheduler: "simple",
  },
  turbo: {
    slot: "turbo", steps: 10, weight: 0.35, cfg: "form", named: /(turbo|dmd|[2-8].?steps?)/i,
    note: `lodestones' 8-step DMD LoRA (${TURBO}, Settings › Models) at 0.35, in 10 steps at the form's CFG: MATLOWAI's "Fast" preset. Its 4 to 8 steps at CFG 1 need the rapid-moss sampler, a node pack Afflatus does not use`,
    stepsNote: "10 at 0.35, as MATLOWAI's Fast preset; 14 at 0.28 changes less of the picture",
  },
  extras: [{
    toggle: { id: "deband", label: "DeBand", note: `MATLOWAI's banding fix (${DEBAND}, Settings › Models) at 1: SFT's faint vertical stripes in skies, fog and walls go, the picture stays close to SFT's` },
    row: {
      label: "DeBand", toggle: "deband",
      note: "The banding fix: DeBand puts it on the model, at the weight set here. Its file is the one of Settings › Models unless another is picked. Removing the row turns DeBand off",
      file: { id: "debandLora", label: "DeBand LoRA", slot: "deband", match: ["moss.*band", "destripe"], note: "the banding fix. Left as it is, the one of Settings › Models" },
      weight: { id: "debandWeight", label: "DeBand weight", default: 1, note: "its strength_model: 1 is what its authors made it for" },
    },
  }],
  layout: {
    how: "MOSS-Image reads them natively, as one JSON layout of boxes (ComfyUI's Create Bounding Boxes and MOSS-Image Layout Prompt): an object box is described by its prompt, a text box draws its text word for word in the look its prompt says, a cast person's box is labelled a character. Its authors measure the layout right about 80 % of the time.",
    guidance: { single: "22", end: 0.5 },
  },
  drops: {
    ...noReferences("MOSS-Image reads no reference image: its edit LoRA is experimental (ComfyUI ≥ 0.43) and not offered yet"),
    ...noGuide("MOSS-Image has no ControlNet: its colour and depth control LoRA is not offered yet"),
  },
  shapes: [
    { id: "tall", label: "Portrait", width: 896, height: 1152 },
    { id: "square", label: "Square", width: 1024, height: 1024 },
    { id: "wide", label: "Landscape", width: 1152, height: 896 },
    { id: "tall-9-16", label: "Portrait 9:16", width: 768, height: 1344 },
    { id: "wide-16-9", label: "Landscape 16:9", width: 1344, height: 768 },
  ],
  megapixels: 1,
  // the authors recommend 1 to 2 MP; 4 MP is as far as they say it extrapolates
  maxPixels: 4.2e6,
  presets: [
    {
      // Base is made for training: no post-training, the authors' own sampling
      match: "moss.?image.?base",
      values: { steps: 50, cfg: 3, sampler: "euler" },
      note: "MOSS-Image Base: not post-trained (made to train on), the authors' 50 steps at CFG 3",
    },
  ],
  placeholder: "Dark fantasy editorial poster: a knight in moss-covered plate armour kneeling in an overgrown ruin, a bouquet of daisies growing out of his open helmet, soft light from above, deep green palette.",
  files: { unet: "moss_image_sft_int8_convrot.safetensors", clip: "qwen3.5_9b_w4a8_gptq.safetensors", vae: "flux2-vae_small.safetensors" },
  fineTune: "MOSS\\someone_moss_image_v1.safetensors",
};

// txt2img alone: no template does img2img, inpaint, outpaint or upscale with MOSS-Image yet (the family's `weak` says so)
// CLIPLoader reads MOSS-Image's text encoder (type moss_image) from ComfyUI 0.42.0 on, the release that brought the model
export const mossPicture = { ...flowRecipes(spec).picture, comfy: "0.42.0" };
