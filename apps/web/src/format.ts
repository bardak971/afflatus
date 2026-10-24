import type { RecipeStatus, Scan } from "./api";
import { missingNodesSaid, modelStem, roughly } from "@afflatus/core";

/** A length to a tenth of a second: "4.5 s". */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A time that was measured, said plainly: "48 s", "2 min 10 s", "1 h 05 min". */
export function spell(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** "42 s", "3 min 05 s". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** What is left of a run, said as an estimate: "about 40 s left", "about 2 min left"; empty when nothing is. */
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

/**
 * How long until an item nobody kept goes to the bin, in a few words: "40 min" under the hour (never under 1), else
 * whole hours ("3 h"), rounded down unless `up`. The tile, its tip, the viewer and the expiring chip say it alike.
 */
export const leftWords = (ms: number, up = false) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(up ? Math.ceil : Math.floor)(ms / 3_600_000)} h`);

/** A time that is a guess, said as one: "about 40 s", "about 2 min". Empty when there is nothing to go on. */
export function aboutMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  // core's rounding, the one the server's forecast line is written with too
  return `about ${roughly(ms)}`;
}

/**
 * A number of minutes as the settings say it: "10 min", "1 h 30 min", "2 h"; 0 is "never" (an idle limit or a watchdog
 * off). One for the Deploy dialog, the rented pods' settings and the hunt: two of four said 90 minutes "1.5 h".
 */
export const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n / 60} h`);

/**
 * A render time that is a guess, short, as the editor, the queue and the timeline cards say it: "~5 s", "~7 min". Empty
 * when nothing was learned yet. A measured time is said without "~" (`spell`).
 */
export const est = (ms: number | null | undefined) => aboutMs(ms).replace(/^about /, "~");

const REPO = "https://github.com/bardak971/afflatus";
/** Where the source of a release is: its tag ("v0.2.1", "0.2.1"); the repository itself for "dev" or nothing known. */
export const sourceOf = (version: string | undefined) => (version && /^v?\d+\.\d+\.\d+/.test(version) ? `${REPO}/tree/${version}` : REPO);

/** A size on disk: "340 MB", "38.2 GB". */
export const size = (bytes: number) =>
  bytes < 2 ** 20 ? `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB` : bytes < 2 ** 30 ? `${Math.round(bytes / 2 ** 20)} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** What an item takes on the disk: its file and what it keeps beside it (an H3 clip's latents, the model's own frames), as the server sums it. */
export const spaceOf = (a: { bytes: number; keptBytes?: number }) => a.bytes + (a.keptBytes ?? 0);

/** An item's size split, for the tip over it: said only when it keeps something beside its file. */
export const spaceSaid = (a: { bytes: number; keptBytes?: number }) => (a.keptBytes ? `${size(a.bytes)} file + ${size(a.keptBytes)} kept for the clips that continue it` : undefined);

/** A place in a line as people say it: "1st", "2nd", "3rd", "11th", "21st", "112th". */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

export const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** A count with its word: "1 take", "3 settings", "2 people" (core's, shared with the server). */
export { plural } from "@afflatus/core";

const PHASES: Record<string, string> = {
  waiting: "Queued on ComfyUI",
  // sent, and waiting there behind work queued in that ComfyUI from elsewhere (its own page, another tool)
  behind: "Queued on ComfyUI · waiting behind work outside Afflatus",
  // before the first step with every model already in memory (tracking, encoding the references): nothing is loaded
  loading: "Loading model", preparing: "Preparing", sampling: "Sampling", upscaling: "Upscale",
  refining: "Refine pass", restoring: "SeedVR2 restore", detailing: "Face / hand refine", processing: "Processing", decoding: "VAE decode", interpolating: "Frame interpolation", encoding: "Encoding",
  exporting: "Exporting", cutting: "Cutting",
};
export const phaseLabel = (phase: string) => PHASES[phase] ?? phase;

/** A model file as a name: no folder, no extension. */
export const fileLabel = modelStem;

/** A recipe under its model's name, without saying the name twice when the title already starts with it. */
export const recipeLabel = (family: string | undefined, title: string) => (!family || title.toLowerCase().startsWith(family.toLowerCase()) ? title : `${family} · ${title}`);
/**
 * A draft's models, as its lists say them: its form's family, the other families it was tried on, then what its form does
 * ("Krea 2 · Z-Image · txt2img"); with no others, its recipeLabel.
 */
export function triedLabel(family: string | undefined, others: readonly string[], title: string): string {
  const own = recipeLabel(family, title);
  if (!others.length) return own;
  return family && own !== title ? [family, ...others, title].join(" · ") : [own, ...others].join(" · ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A day as words: "3 Oct", with the year when it is not this one. Never "03/10": which is the day and which the month is
 * not the same everywhere. The app's one way to write a date (with `when` for "5 d ago" under a week): the Queue's day
 * headings and its When column say the same day the same way.
 */
export function dayOf(at: string | Date, now = Date.now()): string {
  const d = new Date(at);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The UI is in English, with the day before the month and a 24 h clock, whatever the browser's own locale. */
export const UI_LOCALE = "en-GB";

/** A local day as a key, "2026-10-09": not the UTC one, so a render at 00:30 belongs to today. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How many calendar days a local day ("2026-10-09", or a moment's own day) is before `now`'s: 0 today, 1 yesterday. */
export function daysBack(day: string | Date, now = new Date()): number {
  const [y, m, d] = typeof day === "string" ? day.split("-").map(Number) : [day.getFullYear(), day.getMonth() + 1, day.getDate()];
  // midnight to midnight, rounded: a day the clocks change on is still one day
  const midnight = (year: number, month: number, date: number) => new Date(year, month, date).getTime();
  return Math.round((midnight(now.getFullYear(), now.getMonth(), now.getDate()) - midnight(y!, m! - 1, d!)) / 86_400_000);
}

/** The hour and minute of a moment: "14:32", "09:05". */
export const hourMinute = (at: string | number | Date) => new Date(at).toLocaleTimeString(UI_LOCALE, { hour: "2-digit", minute: "2-digit" });

/** A moment in full, as a tooltip or a "checked" line says it: "09/10/2026, 14:32:05". */
export const dateTime = (at: string | number | Date) => new Date(at).toLocaleString(UI_LOCALE);

/** A day of the month and the month, short, for a chart's or a table's figures: "6 Oct". */
export const dayMonth = (at: string | number | Date) => new Date(at).toLocaleDateString(UI_LOCALE, { day: "numeric", month: "short" });

/** A list's or a column's date, short: "14:32" today, "yesterday", "3 Oct" this year, "3 Oct 2025" before. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ago = daysBack(d, now);
  if (ago === 0) return hourMinute(d);
  if (ago === 1) return "yesterday";
  return dayOf(iso, now.getTime());
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
 * Whether the forms can queue work: a ComfyUI answers, or none of the user's own is expected and the setup is what a pod
 * would offer (the server's plannedScan: a rented-only start, or no machine yet), the jobs waiting for a GPU.
 */
export const formsCanQueue = (comfy: Scan["comfy"] | undefined): boolean => Boolean(comfy && (comfy.online || comfy.planned));

/** No ComfyUI answers and none of the user's own is expected: the forms offer what a pod would, and jobs wait for one. */
export const waitsForGpu = (comfy: Scan["comfy"] | undefined): boolean => Boolean(comfy && !comfy.online && comfy.planned);

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

/**
 * The colour role of why a render waits (notReady's sentence, or the form's own "Write … first."): red only for a graph
 * ComfyUI refuses, amber for ComfyUI not answering, and neutral for the rest, words to write, a picture to choose, files
 * or node packs to get: a to-do, not a failure.
 */
export function whyTone(why: string, status: RecipeStatus | undefined): "broken" | "attention" | "todo" {
  if (status?.problems?.[0] && why === problemSaid(status.problems[0])) return "broken";
  return why === notReady(undefined, false) ? "attention" : "todo";
}

/**
 * An amount in US dollars, as a rented GPU's cost is said: cents under $100 ("$0.69", "$12.40"), whole dollars past it.
 * `fine`: a cost that runs (a pod's, by the second), to a tenth of a cent under a dollar ("$0.012"), so that it is seen to move.
 */
export function usd(n: number, fine = false): string {
  if (fine && n > 0 && n < 1) return `$${n.toFixed(3)}`;
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

/** A count as a list says it short: "412k", "9.1k", "1.4M". */
export const compact = (n: number) => new Intl.NumberFormat(UI_LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(n).toLowerCase();
