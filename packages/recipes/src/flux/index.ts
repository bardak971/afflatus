import { defineFamily, defineRecipe, GraphBuilder, type InputSpec } from "@afflatus/core";
import { flowKit, flowRecipes, type FlowBase, type FlowSpec } from "../flow/recipes";

/**
 * FLUX.1: pictures from plain sentences. Written blind from ComfyUI's own templates
 * (`flux_dev_full_text_to_image`, `flux_schnell_full_text_to_image`, `flux1_krea_dev`,
 * `flux_kontext_dev_basic`): it has never been rendered here. The models are FLUX.1 dev, Krea dev and
 * schnell and their fine-tunes, in a file of their own; FLUX.1 Kontext is the model that edits a picture.
 * (FLUX.2 Klein is another family, with its own text encoder and VAE.)
 */
export const flux = defineFamily({
  id: "flux",
  name: "FLUX.1",
  summary: "txt2img from natural-language prompts: FLUX.1 dev, Krea dev, schnell and their fine-tunes. Kontext is the edit model: instruction-based image editing.",
  promptStyle: "sentences",
  slots: [
    {
      // dev before the others, and never the models that do something else (Kontext, Fill, the control ones)
      id: "unet", label: "Diffusion model", folder: "diffusion_models",
      detect: ["^(?!.*(kontext|fill|canny|depth|redux)).*flux.?1[._-]?dev", "^(?!.*(kontext|fill|canny|depth|redux)).*flux.?1"],
      hint: "Put a FLUX.1 model (flux1-dev.safetensors, flux1-krea-dev, flux1-schnell, or a fine-tune) in ComfyUI's models/diffusion_models folder.",
      get: { file: "flux1-dev.safetensors", url: "https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev.safetensors" },
    },
    {
      id: "clipL", label: "Text encoder (CLIP-L)", folder: "text_encoders", detect: ["(^|[\\\\/])clip_l", "clip.?l(?!.*vision)"],
      hint: "Put clip_l.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "clip_l.safetensors", url: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors" },
    },
    {
      // T5-XXL itself: not UMT5-XXL, which is Wan's text encoder and another model
      id: "t5", label: "Text encoder (T5-XXL)", folder: "text_encoders", detect: ["(^|[^a-z])t5.?xxl", "(^|[^a-z])t5.*xxl"],
      hint: "Put t5xxl_fp8_e4m3fn_scaled.safetensors (or t5xxl_fp16) in ComfyUI's models/text_encoders folder.",
      get: { file: "t5xxl_fp8_e4m3fn_scaled.safetensors", url: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors" },
    },
    {
      // FLUX.1's own VAE, named "ae": never the VAE of FLUX.2
      id: "vae", label: "VAE", folder: "vae", detect: ["(^|[\\\\/])ae\\.(safetensors|sft)$", "flux.?1.*(vae|ae)"],
      hint: "Put ae.safetensors (FLUX.1's VAE) in ComfyUI's models/vae folder.",
      get: { file: "ae.safetensors", url: "https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors" },
    },
    {
      id: "kontext", label: "Kontext model", folder: "diffusion_models", detect: ["flux.?1.*kontext", "kontext"], optional: true,
      hint: "Without it there is no Edit. Put flux1-dev-kontext_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "flux1-dev-kontext_fp8_scaled.safetensors", url: "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors" },
    },
    {
      id: "redux", label: "Redux (look from a picture)", folder: "style_models", detect: ["redux"], optional: true,
      hint: "Optional: with flux1-redux-dev.safetensors in ComfyUI's models/style_models folder, txt2img can take the look of a picture. It is on Black Forest Labs' FLUX.1-Redux-dev page on Hugging Face (accept its licence there first).",
    },
    {
      id: "vision", label: "Vision model for Redux (SigCLIP)", folder: "clip_vision", detect: ["sigclip"], optional: true,
      hint: "Optional, with Redux: sigclip_vision_patch14_384.safetensors in ComfyUI's models/clip_vision folder.",
      get: { file: "sigclip_vision_patch14_384.safetensors", url: "https://huggingface.co/Comfy-Org/sigclip_vision_384/resolve/main/sigclip_vision_patch14_384.safetensors" },
    },
  ],
  loraMatch: ["flux[ ._-]?1", "flux(?![ ._-]?2)"],
  guide: `FLUX.1 reads plain sentences, not tags: subject first, then action, setting, light, camera and style. 30 to 60 words is the sweet spot; past 75 the details get lost. It has no negative prompt and ignores weights.
RULES FOR A NEW PICTURE
- The medium and the subject first ("A photograph of…", "An oil painting of…"), then who or what with look, clothing, pose and expression, then the place.
- The light as behaviour: where it comes from, its colour, what it does.
- A camera body, lens and aperture only for a photographic look, and chosen for this picture, not the same every time.
- Text that must appear: double quotes, word for word, where it sits and in what style; the case is reproduced.
- Only what IS in the picture: "no hat" tends to add a hat; say the wanted state ("bare-headed").
- Faithful to the user's idea: detail, not new subjects. A LoRA's trigger words stay.
RULES FOR AN INSTRUCTION (the part is called "Instruction": a change to a picture)
- One imperative edit, 1 to 3 sentences: what changes, then what is kept ("while keeping everything else the same", "exact same position, scale and pose", "the same facial features, hairstyle and expression").
- People and things by description ("the woman with short black hair"), never "him", "her" or "it".
- "Change", "replace", "add", "remove" keep the picture's identity; "transform" means a restyle, so say what to keep.
- Text in the picture: "Replace 'joy' with 'BFL' while maintaining the same font style".
- A complex change is several passes: background first, then the pose.
EXAMPLES, for the form only (their subjects, places, lenses and words are not to be reused):
A new picture: A photograph of a matte black ceramic mug on a light oak table, steam rising from fresh coffee, morning sunlight streaming in from the right and pooling on the wood, a clean, nearly empty background. Shot on a medium-format camera with a 120 mm macro lens at f/8.
An instruction: Change the mug to a white enamel one with a chipped rim, keeping the table, the steam, the light and the exact same framing.`,
});

const spec: FlowSpec = {
  family: "flux",
  look: true,
  model: {
    id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["^(?!.*(kontext|fill|canny|depth|redux)).*flux.?1", "flux(?!.?2)"],
    note: "FLUX.1 dev, Krea dev, schnell, or a fine-tune",
  },
  encoder: {
    nodes: ["DualCLIPLoader"],
    load: (g, slots) => g.out("DualCLIPLoader", { clip_name1: slots.clipL, clip_name2: slots.t5, type: "flux", device: "default" }),
    files: (slots) => [`text_encoders/${slots.clipL}`, `text_encoders/${slots.t5}`],
  },
  shift: { node: "ModelSamplingFlux", default: 0, note: "0 is the model's own (1.15 at one megapixel, more for larger pictures, as FLUX.1 was trained). Otherwise the largest shift: higher gives the first steps more weight" },
  guidance: { default: 3.5, note: "how closely the prompt is followed: 3.5 is the usual one, 4.5 for Krea dev (its authors' setting), 2 to 2.5 looks more like a photograph. Schnell ignores it" },
  negative: { default: "", note: "only acts with a CFG scale above 1, which FLUX.1 is not made for", empty: "zero" },
  sampling: { steps: 20, stepsNote: "20 for dev and Krea dev, 4 for schnell", cfg: 1, cfgNote: "1 is what FLUX.1 is made for: its Guidance does that job. Above 1 the negative prompt acts and every step takes twice as long", sampler: "euler", scheduler: "simple" },
  shapes: [
    { id: "tall", label: "Portrait", width: 896, height: 1152 },
    { id: "square", label: "Square", width: 1024, height: 1024 },
    { id: "wide", label: "Landscape", width: 1152, height: 896 },
  ],
  megapixels: 1.6,
  // FLUX.1 draws from 0.1 to 2 megapixels
  maxPixels: 2.1e6,
  presets: [
    { match: "krea", values: { guidance: 4.5 }, note: "Krea dev: guidance 4.5, as its authors give it" },
    { match: "schnell", values: { steps: 4 }, note: "schnell: 4 steps" },
  ],
  placeholder: "A photograph of a woman in a linen shirt drinking coffee on a terrace at sunrise, soft warm light from the left, waist up.",
  files: { unet: "flux1-dev.safetensors", clipL: "clip_l.safetensors", t5: "t5xxl_fp16.safetensors", vae: "ae.safetensors" },
  fineTune: "Flux\\someone_flux1_v2.safetensors",
};

const made = flowRecipes(spec);
export const fluxPicture = made.picture;
export const fluxRedraw = made.redraw;
export const fluxPaintOver = made.paintOver;
export const fluxOutpaint = made.outpaint;
export const fluxSharper = made.sharper;
export const fluxFixFace = made.fixFace;

// ---------------------------------------------------------------- edit (Kontext)

export interface FluxEdit extends FlowBase {
  source: string;
  prompt: string;
}

const kit = flowKit(spec);
const kontextModel: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "kontext", match: ["kontext"],
  note: "FLUX.1 Kontext, or a fine-tune of it",
};

/**
 * A picture changed from an instruction, with FLUX.1 Kontext, as ComfyUI's template does it: the picture
 * is brought to a size Kontext was taught on and handed to it as a reference, next to the instruction.
 * What is not asked to change stays.
 */
export const fluxEdit = defineRecipe<FluxEdit>({
  id: "flux.edit",
  family: "flux",
  version: 1,
  title: "Edit",
  summary: "Instruction-based editing (\"make the jacket red\", \"turn it into a watercolour\") with FLUX.1 Kontext. The rest of the image is kept.",
  output: "image",
  needs: ["kontext"],
  inputs: [
    kontextModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Instruction", style: "sentences", placeholder: "Change the car to red, keep everything else the same." },
    ...kit.inputs.map((i) => (i.id === "guidance" ? { ...i, default: 2.5, note: "2.5 is Kontext's usual one" } : i) as InputSpec),
  ],
  nodes: (input) => [...kit.loadNodes(input), "LoadImage", "FluxKontextImageScale", "VAEEncode", "ReferenceLatent"],
  // the guidance is part of how Kontext is used: it is always there
  optionalNodes: kit.SOMETIMES,
  build(input, ctx) {
    if (!(input.model ?? ctx.slots.kontext)) throw new Error("Edit needs FLUX.1 Kontext: put flux1-dev-kontext_*.safetensors in ComfyUI's models/diffusion_models folder (it can be downloaded from Settings).");
    const g = new GraphBuilder();
    const k = kit.load(g, { ...input, model: input.model ?? ctx.slots.kontext }, ctx);
    const sized = g.out("FluxKontextImageScale", { image: g.out("LoadImage", { image: ctx.uploads.source }) });
    const latent = g.out("VAEEncode", { pixels: sized, vae: k.vae });
    const said = g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip });
    const positive = g.out("FluxGuidance", { conditioning: g.out("ReferenceLatent", { conditioning: said, latent }), guidance: input.guidance ?? 2.5 });
    const negative = input.negative.trim() ? g.out("CLIPTextEncode", { text: input.negative, clip: k.clip }) : g.out("ConditioningZeroOut", { conditioning: said });
    // Kontext works at about a megapixel (FluxKontextImageScale brings the picture there): the shift goes with that size, not the picture's own
    const size = kit.sizeOf(ctx.media.source, 1.05, 0.9);
    g.phase("sampling");
    const { latent: done, pass } = kit.sample(g, k, input, kit.shifted(g, k.model, input, size), { positive, negative }, latent, ctx.seed);
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: done, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    { name: "from an instruction", input: { source: "p", prompt: "a" }, slots: { ...spec.files, kontext: "flux1-dev-kontext.safetensors" }, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
    {
      name: "a fine-tune, a LoRA, a negative prompt and a shift",
      input: { source: "p", prompt: "a", model: "someone_kontext.safetensors", negative: "blurry", cfg: 2, shift: 1.5, loras: [{ file: "l.safetensors", weight: 0.8 }] },
      slots: { ...spec.files, kontext: "flux1-dev-kontext.safetensors" }, uploads: { source: "s.png" }, media: { source: { width: 1536, height: 2048 } },
    },
  ],
});
