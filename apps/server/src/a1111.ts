import { formModelInput, type InputSpec, type Recipe } from "@afflatus/core";

/**
 * What A1111's "parameters" text and a form have in common, said once for the writer (pngInfo.ts, a render's picture going
 * out) and the reader (embedded.ts and fromPicture.ts, a picture coming in): the sampler and schedule names, and which input
 * of a form holds each of A1111's settings. Written twice, a rule changed on one side broke the round trip without a word.
 */

/** ComfyUI's sampler names → A1111's. One A1111 has no name for keeps ComfyUI's, which A1111's own readers pass on and the reader takes back. */
export const SAMPLER_NAMES: Record<string, string> = {
  euler: "Euler", euler_ancestral: "Euler a", euler_cfg_pp: "Euler CFG++", euler_ancestral_cfg_pp: "Euler a CFG++", lms: "LMS", heun: "Heun",
  dpm_2: "DPM2", dpm_2_ancestral: "DPM2 a", dpmpp_2s_ancestral: "DPM++ 2S a", dpmpp_2m: "DPM++ 2M", dpmpp_sde: "DPM++ SDE", dpmpp_2m_sde: "DPM++ 2M SDE",
  dpmpp_3m_sde: "DPM++ 3M SDE", dpm_fast: "DPM fast", dpm_adaptive: "DPM adaptive", ddim: "DDIM", uni_pc: "UniPC", lcm: "LCM", restart: "Restart", ddpm: "DDPM",
};
/** ComfyUI's schedulers → A1111's "Schedule type" (A1111 1.9 and later, Forge). */
export const SCHEDULE_NAMES: Record<string, string> = {
  normal: "Normal", karras: "Karras", exponential: "Exponential", sgm_uniform: "SGM Uniform", simple: "Simple", ddim_uniform: "DDIM", beta: "Beta", kl_optimal: "KL Optimal",
};

/** The tables the other way, by A1111's name in lower case, with the names A1111 has that ComfyUI's nearest stands for. */
const reverse = (names: Record<string, string>, also: Record<string, string>): Record<string, string> =>
  ({ ...Object.fromEntries(Object.entries(names).map(([comfy, a1111]) => [a1111.toLowerCase(), comfy])), ...also });
/** A1111's sampler names → ComfyUI's. */
export const SAMPLERS = reverse(SAMPLER_NAMES, { "dpm++ 2m sde heun": "dpmpp_2m_sde", "ddim cfg++": "ddim", plms: "euler" });
/** A1111's schedule types → ComfyUI's. */
export const SCHEDULES = reverse(SCHEDULE_NAMES, { uniform: "normal", "align your steps": "normal", automatic: "normal", polyexponential: "exponential" });

/** The inputs that hold a picture, a sound or a clip of the library: their values are its ids, meaningless elsewhere. */
export const MEDIA_TYPES = new Set(["image", "audio", "clip", "references", "cues", "video"]);
/** A file a form names (a model, an upscaler) without the folders it sits in under ComfyUI's models. */
export const bare = (v: string) => v.replace(/^.*[\\/]/, "");

/** A form that starts from a picture of its own (img2img, inpaint, upscale, a face pass): it takes A1111's img2img strength, not a size. */
export const takesPicture = (r: Recipe<any>) => r.output === "image" && r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional);

type Of<T extends InputSpec["type"]> = Extract<InputSpec, { type: T }>;
const named = (i: InputSpec, id: string, label: RegExp) => i.id === id || label.test(i.label);

/**
 * The inputs of a form that hold A1111's settings: by their id in a built-in form, by their label in an imported one (its
 * first pass's, "Steps · first pass"). `strength` only on a form that takes a picture: a txt2img's hires denoise has the label.
 */
export function a1111Slots(recipe: Recipe<any>) {
  const inputs = recipe.inputs as InputSpec[];
  const prompts = inputs.filter((i): i is Of<"prompt"> => i.type === "prompt");
  const prompt = prompts.find((i) => i.id === "prompt") ?? prompts.find((i) => !i.optional) ?? prompts[0];
  const numbers = inputs.filter((i): i is Of<"number"> => i.type === "number");
  const choices = inputs.filter((i): i is Of<"choice"> => i.type === "choice");
  return {
    prompt,
    negative: prompts.find((i) => i !== prompt && named(i, "negative", /negative/i)),
    /** The SDXL forms' quality tags, sent in front of the prompt. */
    quality: prompts.find((i) => i.id === "quality"),
    model: formModelInput(recipe),
    loras: inputs.find((i): i is Of<"loras"> => i.type === "loras"),
    size: inputs.find((i): i is Of<"size"> => i.type === "size"),
    seed: inputs.find((i) => i.type === "seed"),
    steps: numbers.find((i) => named(i, "steps", /^steps( · first pass)?$/i)),
    cfg: numbers.find((i) => named(i, "cfg", /^cfg( scale)?( · first pass)?$/i)),
    sampler: choices.find((i) => named(i, "sampler", /^sampler( name)?( · first pass)?$/i)),
    scheduler: choices.find((i) => named(i, "scheduler", /^scheduler( · first pass)?$/i)),
    strength: takesPicture(recipe) ? numbers.find((i) => !i.id.startsWith("hires") && named(i, "strength", /^denois(e|ing strength)$/i)) : undefined,
    clipSkip: numbers.find((i) => i.id === "clipSkip"),
    /** A1111's own hires fix: the built-in txt2img's switch, its scale, steps, denoise and upscaler under their ids. */
    hires: inputs.some((i) => i.id === "hires" && i.type === "toggle")
      ? { scale: numbers.find((i) => i.id === "hiresScale"), steps: numbers.find((i) => i.id === "hiresSteps"), denoise: numbers.find((i) => i.id === "hiresDenoise"), upscaler: inputs.find((i) => i.id === "hiresUpscaler") }
      : undefined,
  };
}
