/** The settings, the language models they name, and the start-up checks. */
import type { BarSettings } from "./bar";

/** Alive, the version, and the start-up checks: what this computer has of what Afflatus needs. */
export interface Health {
  ok: true;
  version: string;
  database: string;
  checks: Array<{ id: "node" | "ffmpeg" | "ffprobe" | "data"; label: string; ok: boolean; detail: string; without: string; fix: string }>;
  checkedAt: string | null;
}
/** One language model the designer can write with. Its key never comes back: only whether one is saved. */
export interface LlmInfo {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  vision: boolean;
  /** How much it can read at once, in tokens. */
  contextSize: number;
  /** The longest answer it may write, in tokens. */
  maxOutputTokens: number;
  /** Asked not to think before it answers. */
  noThinking: boolean;
}
export interface FinishSettings {
  route: "seedvr" | "latent" | "rtx" | "model";
  factor: number;
  colour: "lab" | "wavelet" | "adain" | "none";
  upscaleModel: string;
  latentDenoise: number;
  latentSteps: number;
  seedvrFrames?: number;
  /** RCAS after a pixel route, 0 to 1; 0 = off. */
  sharpen?: number;
}
/** A model the designer can write with, as Settings sends it back: its key only when one was typed (else the saved one is kept). */
export type LlmPatch = Omit<LlmInfo, "hasApiKey"> & { apiKey?: string };
/**
 * What PUT /api/settings takes: some of the settings, by key, merged by the server into the rest (a key it does not know is
 * refused). As the answer says them, but for what the answer hides: the Civitai key itself, the models with their keys,
 * and `llm`, the model in use changed the short way. Held to the server's schema by test/apiTypes.test.ts.
 */
export type SettingsPatch = Partial<Omit<Settings, "llm" | "llms" | "hasCivitaiKey">> & {
  civitaiKey?: string;
  llms?: LlmPatch[];
  llm?: Partial<Omit<LlmPatch, "id">>;
};
export interface Settings {
  comfyUrl: string;
  /** ComfyUI's folder on Afflatus's computer, when they share one; empty otherwise. */
  comfyDir: string;
  /** ComfyUI's models are unloaded after this many minutes without a render; 0 for never. */
  unloadAfterMinutes: number;
  /** The model in use, the short way. */
  llm: { baseUrl: string; model: string; hasApiKey: boolean; vision: boolean };
  llms: LlmInfo[];
  /** The one the designer writes with. */
  designerLlm: string;
  /** The user's own instructions for the designer, each under a name. */
  designerInstructions: Array<{ id: string; name: string; text: string }>;
  /** The user's own prompting guide per model family (family id → text); a family not named uses the built-in. */
  designerGuides: Record<string, string>;
  /** The ones in use; empty for none. */
  designerInstruction: string;
  /** Tags written for an anime model are compared with danbooru's list. */
  tagCheck: boolean;
  /** Model families switched on or off by hand; one that is not named follows its files. */
  families: Record<string, boolean>;
  hasCivitaiKey: boolean;
  /** The user's defaults for "Finish all clips" on a timeline. */
  finish: FinishSettings;
  /** A family's file chosen by hand where several fit: family id → slot id → file. */
  slotFiles: Record<string, Record<string, string>>;
  /** The presets whose files' licence was accepted. */
  acceptedPresets: string[];
  /** Missing model files may be looked for on Civitai. */
  civitaiLookups: boolean;
  /** Missing model files may be fetched into ComfyUI's model folders (by Afflatus, its node pack, or ComfyUI-Manager). */
  downloadModels: boolean;
  /** How many days the time of each render is kept one by one; 0 for good. Older ones become daily figures. */
  renderHistoryDays: number;
  /** The days a result nobody kept has before it goes to the bin by itself: 1, 3 or 7; 0 for never. */
  unkeptDays: 0 | 1 | 3 | 7;
  /** The days the bin keeps what is in it before it is erased: 7 or 30; 0 until it is emptied by hand. */
  binDays: 0 | 7 | 30;
  /** Once a day, Civitai is asked for newer versions of the models here (lookups on; hashes are sent). */
  updateChecks: boolean;
  /** The command bar's shortcut and its optional parts. */
  bar: BarSettings;
  /** The projects pinned to the rail under the one worked in, in their order there (four at most). */
  pinnedProjects: string[];
}
