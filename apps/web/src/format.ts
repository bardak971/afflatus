import type { RecipeStatus } from "./api";

/** "42 s", "3 min 05 s". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** "about 40 s", "about 2 min": an estimate, said as one. */
export function about(seconds: number): string {
  if (seconds <= 0) return "";
  return seconds < 90 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left` : `about ${Math.round(seconds / 60)} min left`;
}

/** The length of a clip: "0:05", "1:12". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A time that is a guess, said as one: "about 40 s", "about 2 min". Empty when there is nothing to go on. */
export function aboutMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = ms / 1000;
  return s < 90 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s` : `about ${Math.round(s / 60)} min`;
}

/** A size on disk: "340 MB", "38.2 GB". */
export const size = (bytes: number) =>
  bytes < 2 ** 20 ? `${Math.round(bytes / 1024)} KB` : bytes < 2 ** 30 ? `${Math.round(bytes / 2 ** 20)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`;

export const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const PHASES: Record<string, string> = {
  waiting: "Queued on ComfyUI", loading: "Loading model", sampling: "Sampling", upscaling: "Latent upscale",
  refining: "Refine pass", detailing: "Detailer", decoding: "VAE decode", interpolating: "Frame interpolation", encoding: "Encoding",
  exporting: "Exporting",
};
export const phaseLabel = (phase: string) => PHASES[phase] ?? phase;

/** A model file as a name: no folder, no extension. */
export const fileLabel = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, "");

/** A recipe under its model's name, without saying the name twice when the title already starts with it. */
export const recipeLabel = (family: string | undefined, title: string) => (!family || title.toLowerCase().startsWith(family.toLowerCase()) ? title : `${family} · ${title}`);

export function when(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Why a recipe cannot run on this ComfyUI, in one sentence. */
/** The graph checker's words, said plainly: `49:43 KSampler: "beta57" is not a choice of "scheduler"`. */
export function problemSaid(problem: string): string {
  const choice = /^(\S+) (.+?): "(.*)" is not a choice of "(.+)"$/.exec(problem);
  if (choice) return `It asks for "${choice[3]}" as ${choice[4]!.replace(/_/g, " ")} (${choice[2]}), which your ComfyUI does not offer.`;
  return `ComfyUI would refuse it: ${problem}.`;
}

export function notReady(status: RecipeStatus | undefined, comfyOnline: boolean): string | null {
  if (!comfyOnline) return "ComfyUI is not answering.";
  if (!status || status.ready) return null;
  if (status.missingNodes.length) return `ComfyUI is missing nodes: ${status.missingNodes.join(", ")}.`;
  if (status.missingSlots.length) return "A model file it needs was not found.";
  if (status.emptyInputs.length) return "There is no model to pick on your ComfyUI.";
  if (status.missingFiles.length) return `ComfyUI does not have ${status.missingFiles.join(", ")}.`;
  if (status.problems?.length) return problemSaid(status.problems[0]!);
  return "Not ready.";
}
