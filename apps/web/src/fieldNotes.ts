import type { InputSpec } from "@afflatus/core";

/**
 * What a setting is for, when its recipe says nothing (most of an imported workflow's settings, and the ones
 * every model shares): looked up by the input's id, then by its name as ComfyUI or the recipe writes it. Shown
 * behind the setting's ?. A fixed list, in the words of A1111 and ComfyUI; nothing is guessed.
 */
const NOTES: Record<string, string> = {
  seed: "The starting noise. The same seed, prompt and settings give the same result; another seed, another take.",
  noise_seed: "The starting noise. The same seed, prompt and settings give the same result; another seed, another take.",
  loras: "Small add-on models that steer the main one (a style, a person, a motion). The strength is how much each one pulls.",
  sampler: "How each step removes noise (sampler_name in ComfyUI). Euler is the safe default; ancestral samplers (_a) add noise back and vary more.",
  sampler_name: "How each step removes noise. Euler is the safe default; ancestral samplers (_a) add noise back and vary more.",
  scheduler: "How the noise level falls over the steps. Normal and simple suit most models; karras spends more steps on fine detail.",
  steps: "How many denoising steps. More is slower and only better up to a point; distilled and turbo models need few.",
  cfg: "How strictly the prompt is followed (CFG scale). Higher is more literal and more contrasted; distilled models want about 1.",
  "cfg scale": "How strictly the prompt is followed. Higher is more literal and more contrasted; distilled models want about 1.",
  denoise: "How much of the input picture is redrawn: 1 redraws everything, lower keeps more of the original.",
  "denoising strength": "How much of the input picture is redrawn: 1 redraws everything, lower keeps more of the original.",
  negative: "What the picture should not have. Tag models read it; distilled models (CFG 1) ignore it.",
  "negative prompt": "What the picture should not have. Tag models read it; distilled models (CFG 1) ignore it.",
  checkpoint: "The model file the picture is made with (models/checkpoints).",
  ckpt_name: "The model file the picture is made with (models/checkpoints).",
  "clip skip": "Leaves out the text encoder's last layers. 2 is what anime models were trained with; 1 for the rest.",
  shift: "Moves the sampling toward the coarse steps (model sampling shift). Higher keeps the composition steadier, lower adds detail.",
  "base shift": "The shift at small sizes; it grows with the picture's size up to the max shift.",
  "hires steps": "Steps of the second pass that redraws the enlarged picture.",
  "hires sampler": "The sampler of the second, enlarged pass.",
  "hires scheduler": "The scheduler of the second, enlarged pass.",
  "detail until": "Up to which share of the steps the detail pass works. Lower stops it sooner and keeps more of the first pass.",
  "guide until": "Up to which share of the steps the guide picture steers the render.",
  "extend left": "How many pixels are added on the left and painted to match.",
  "extend right": "How many pixels are added on the right and painted to match.",
  "extend up": "How many pixels are added at the top and painted to match.",
  "extend down": "How many pixels are added at the bottom and painted to match.",
  instruction: "What to change in the picture, as an instruction (\"make it night\").",
  "edge low threshold": "Canny: edges weaker than this are dropped. Lower keeps more lines.",
  "edge high threshold": "Canny: edges stronger than this are always kept. Lower keeps more lines.",
  "aspect ratio": "The shape of the output. The size follows it at the model's usual resolution.",
  "sound effects": "The sounds of the shot, as words (waves, footsteps). Left empty, the model picks.",
  music: "The music under the shot, as words. Left empty, there is none or the model picks.",
  "keyframe at": "When the keyframe picture is reached, in seconds from the start.",
  "voice sample: start": "Where the part of the voice sample that is used starts.",
  "voice sample: length": "How long the part of the voice sample that is used is.",
  "upscale tile overlap": "How much neighbouring tiles overlap when the picture is enlarged in pieces. More hides seams and is slower.",
  duration: "The clip's length in seconds.",
  "last frame strength": "How hard the clip is pulled to end on the last frame picture.",
  batch_size: "How many are made at once from one queued job.",
};

/** The setting with its note: its own, else the one of the list. */
export function withNote<T extends InputSpec>(spec: T): T {
  if (spec.note) return spec;
  const note = NOTES[spec.id] ?? NOTES[spec.label.toLowerCase()];
  return note ? { ...spec, note } : spec;
}
