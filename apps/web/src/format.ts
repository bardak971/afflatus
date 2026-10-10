import type { RecipeStatus } from "./api";
import { missingNodesSaid } from "@afflatus/core";

/** "42 s", "3 min 05 s". */
/** A length to a tenth of a second: "4.5 s". */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A time that was measured, said plainly: "48 s", "2 min 10 s", "1 h 05 min". */
export function spell(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** "about 40 s", "about 2 min": an estimate, said as one. */
export function about(seconds: number): string {
  if (seconds <= 0) return "";
  return seconds < 90 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left` : `about ${Math.round(seconds / 60)} min left`;
}

/**
 * A length or a moment as minutes and seconds: "0:05", "1:12". With `decimals`, a moment to the tenth
 * ("0:03.4") or the hundredth ("0:04.20") of a second, the seconds floored so that a frame never reads
 * as the next second.
 */
export function clock(ms: number, opts: { decimals?: 0 | 1 | 2 } = {}): string {
  const decimals = opts.decimals ?? 0;
  const total = Math.max(0, ms);
  const whole = decimals ? Math.floor(total / 1000) : Math.round(total / 1000);
  const base = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  if (!decimals) return base;
  // counted in milliseconds: 3300 ms is ".3", never ".2" through a floating point remainder
  const part = Math.floor((total % 1000) / 10 ** (3 - decimals));
  return `${base}.${String(part).padStart(decimals, "0")}`;
}

/**
 * What is left of a running job, ComfyUI's own estimate from its steps: "1:05 left". The one way it is said, wherever
 * it shows (status bar, Queue, tab, draft stage, inspector); a job not yet started keeps its "about" (`aboutMs`).
 */
export const timeLeft = (seconds: number) => `${clock(seconds * 1000)} left`;

/** How long something has been going, to the second below: "0:59", "12:05" (minutes past the hour go on counting). */
export function elapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A long time: "42 s" (under a minute and a half), "48 min", "6 h 12 min". */
export function long(ms: number): string {
  const min = Math.round(ms / 60_000);
  return ms < 90_000 ? took(ms) : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** The same as `long`, short enough for the scale of a chart: "42s", "3m 05s", "4m", "1h 05m". */
export function brief(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s / 60}m`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Seconds per step, as ComfyUI says it (s/it): two decimals under ten seconds, one above. "—" when not known. */
export const pace = (stepMs: number | null): string => (stepMs === null ? "—" : (stepMs / 1000).toFixed(stepMs < 10_000 ? 2 : 1));

/** What is left of a countdown: "going to the bin" once over, else "12 min left" (never under 1), "5 h left". */
export function left(ms: number, over = "going to the bin"): string {
  return ms <= 0 ? over : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min left` : `${Math.round(ms / 3_600_000)} h left`;
}

/** A time that is a guess, said as one: "about 40 s", "about 2 min". Empty when there is nothing to go on. */
export function aboutMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = ms / 1000;
  return s < 90 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s` : `about ${Math.round(s / 60)} min`;
}

const REPO = "https://github.com/bardak971/afflatus";
/** Where the source of a release is: its tag ("v0.2.1", "0.2.1"); the repository itself for "dev" or nothing known. */
export const sourceOf = (version: string | undefined) => (version && /^v?\d+\.\d+\.\d+/.test(version) ? `${REPO}/tree/${version}` : REPO);

/** A size on disk: "340 MB", "38.2 GB". */
export const size = (bytes: number) =>
  bytes < 2 ** 20 ? `${Math.round(bytes / 1024)} KB` : bytes < 2 ** 30 ? `${Math.round(bytes / 2 ** 20)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`;

export const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const PHASES: Record<string, string> = {
  waiting: "Queued on ComfyUI", loading: "Loading model", sampling: "Sampling", upscaling: "Upscale",
  refining: "Refine pass", restoring: "SeedVR2 restore", detailing: "Detailer", processing: "Processing", decoding: "VAE decode", interpolating: "Frame interpolation", encoding: "Encoding",
  exporting: "Exporting", cutting: "Cutting",
};
export const phaseLabel = (phase: string) => PHASES[phase] ?? phase;

/** A model file as a name: no folder, no extension. */
export const fileLabel = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, "");

/** A recipe under its model's name, without saying the name twice when the title already starts with it. */
export const recipeLabel = (family: string | undefined, title: string) => (!family || title.toLowerCase().startsWith(family.toLowerCase()) ? title : `${family} · ${title}`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as words: "3 Oct", with the year when it is not this one. Never "03/10": which is the day and which the month is not the same everywhere. */
export function dayOf(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** How long ago, short: "just now", "12 min ago", "4 h ago", "3 d ago" within the week, then the day ("3 Oct"). */
export function when(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return dayOf(iso, now);
}

/** The graph checker's words, said plainly: `49:43 KSampler: "beta57" is not a choice of "scheduler"`. */
export function problemSaid(problem: string): string {
  const choice = /^(\S+) (.+?): "(.*)" is not a choice of "(.+)"$/.exec(problem);
  if (choice) return `It asks for "${choice[3]}" as ${choice[4]!.replace(/_/g, " ")} (${choice[2]}), which your ComfyUI does not offer.`;
  return `ComfyUI would refuse it: ${problem}.`;
}

/**
 * The Civitai site a find is on, as it is named to the user: "Civitai" for civitai.com, its own name for another of
 * Civitai's sites (civitai.red), and "Civitai" again for a stand-in address set in its place (the demo's, a proxy's):
 * a bare host and port says nothing about where the file is.
 */
export function siteName(site: string): string {
  if (/^civitai\.[a-z]+$/i.test(site) && site.toLowerCase() !== "civitai.com") return site;
  return "Civitai";
}

/** A model slot of a family, as the setup check reports it: enough to name the file it lacks. */
export interface SlotSaid {
  id: string;
  label: string;
  folder: string;
  get?: { file: string };
}

/**
 * The model files a family lacks, named: the file it is usually filled with when its author gave one, else the slot
 * and the folder it is looked for in. "krea2_turbo_fp8_scaled.safetensors (Diffusion model)", "VAE in vae".
 */
export function slotsSaid(ids: string[], slots: SlotSaid[]): string[] {
  return ids.map((id) => {
    const s = slots.find((x) => x.id === id);
    if (!s) return id;
    return s.get ? `${s.get.file} (${s.label})` : `${s.label} in ${s.folder}`;
  });
}

/**
 * Why a recipe cannot run on this ComfyUI, in one sentence. With its family's slots, a missing model file is named, as a
 * workflow's missing file is; without them it is only said that one is missing.
 */
export function notReady(status: RecipeStatus | undefined, comfyOnline: boolean, slots?: SlotSaid[]): string | null {
  if (!comfyOnline) return "ComfyUI is not answering.";
  if (!status || status.ready) return null;
  if (status.missingNodes.length) return missingNodesSaid(status.missingNodes);
  if (status.missingSlots.length) return slots ? `ComfyUI does not have ${slotsSaid(status.missingSlots, slots).join(", ")}.` : "A model file it needs was not found.";
  if (status.emptyInputs.length) return "There is no model to pick on your ComfyUI.";
  if (status.missingFiles.length) return `ComfyUI does not have ${status.missingFiles.join(", ")}.`;
  if (status.problems?.length) return problemSaid(status.problems[0]!);
  return "Not ready.";
}
