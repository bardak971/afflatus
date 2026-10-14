/** The settings, the language models they name, and the start-up checks. */
import type { BarSettings } from "./bar";
import type { PresetFile } from "./designer";

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
export type SettingsPatch = Partial<Omit<Settings, "llm" | "llms" | "hasCivitaiKey" | "hasRunpodKey" | "machines">> & {
  /** The machines as the page has them, without what it is only told (a token's end). A token left out stays as it is. */
  machines?: Array<Omit<Machine, "tokenEnd"> & { token?: string }>;
  civitaiKey?: string;
  runpodKey?: string;
  /** The server's own list of secrets to delete once their pods are gone: the page never sends it. */
  leftSecrets?: Array<{ secret: string; pod: string }>;
  llms?: LlmPatch[];
  llm?: Partial<Omit<LlmPatch, "id">>;
};
/** One ComfyUI the queue sends work to (a GPU of this computer, another computer, a rented instance). */
export interface Machine {
  /** Stays when its address changes: what was learned of it stays with it. */
  id: string;
  /** What the user calls it; empty: its address is shown. */
  name: string;
  url: string;
  /** Its ComfyUI folder on Afflatus's computer, when they share a disk; empty otherwise. */
  dir: string;
  /** What the queue gives it. */
  takes: "all" | "image" | "video";
  /** Families switched on or off on this machine by hand, over the switch of every machine (Settings › Models, its tab). */
  families: Record<string, boolean>;
  /** The last four characters of its token when its ComfyUI is locked (the token itself stays on the server); empty without one. */
  tokenEnd: string;
  /** A rented pod: its provider and id, and what happens when it sits idle. Absent for a ComfyUI of its own. */
  rented?: RentedMachine;
}
/** A machine that is a rented pod. Afflatus never starts one on its own. */
export interface RentedMachine {
  provider: "runpod";
  pod: string;
  /** Minutes idle, then `idleDo`; 0: never. */
  idleMinutes: number;
  idleDo: "stop" | "terminate";
  /** Minutes this PC may be silent before the pod stops itself; 0: no watchdog. */
  watchdogMinutes: number;
  /** Its other public ports (FileBrowser, JupyterLab, SSH) kept open at its start; off: closed at each Start. */
  openPorts: boolean;
  /** The ports Afflatus closed on it: put back at a Start once they are to be kept open. */
  closedPorts: string[];
  /** The RunPod secret its token is kept in, when Afflatus named it; empty: "afflatus-<pod>". */
  secret: string;
  /** Deployed from Afflatus: its first start pulls its image, which may take long. */
  deployed: boolean;
  /** When it was deployed, until its ComfyUI first answered; empty after. */
  deployedAt: string;
  /** RunPod's cloud it was deployed on, when Afflatus deployed it. */
  cloud?: "SECURE" | "COMMUNITY";
  /** The files its deploy asked for, until its first answer hands them to it. */
  files: PresetFile[];
  /** The files its deploy left out, until its first answer. */
  leaveOut: Array<{ file: string; folder: string }>;
}

/** What a GPU is deployed with: the Deploy dialog's choices, kept as the next deploy's (Settings.lastDeploy). */
export interface DeployAsk {
  /** RunPod's id of the GPU ("NVIDIA A40"). */
  gpu: string;
  cloud: "SECURE" | "COMMUNITY";
  /** afflatus: ComfyUI with the node pack, locked from its first second; runpod: RunPod's own ComfyUI, without the pack. */
  template: "afflatus" | "runpod";
  /** A network volume's id; empty: none. */
  volume: string;
  /** Its container disk, GB. */
  disk: number;
  idleMinutes: number;
  idleDo: "stop" | "terminate";
  watchdogMinutes: number;
  /** The Model set picked (its id); empty: none. */
  set: string;
  /** The model files ticked, fetched onto the pod once it is up (empty in lastDeploy). */
  files: PresetFile[];
  /** The waiting jobs' files unticked: those jobs stay elsewhere (empty in lastDeploy). */
  leaveOut: Array<{ file: string; folder: string }>;
  /** The set's presets whose licence was accepted in the dialog (empty in lastDeploy). */
  accept: string[];
}
/** A ComfyUI asked now (GET /api/machines): whether it answers (and why not), its version, its GPU and the Afflatus node pack it loaded. */
export interface MachineProbe {
  id: string;
  online: boolean;
  error: string | null;
  version: string | null;
  device: string | null;
  vramTotal: number | null;
  vramFree: number | null;
  pack: string | null;
  /** Its lock (Afflatus's node pack): asked now with the rest. */
  access: MachineAccess;
  /** The last four characters of the token Afflatus has for it; empty without one. */
  tokenEnd: string;
}
/** A ComfyUI's access, as its card's Access line says it. */
export interface MachineAccess {
  /** open: no lock; locked: locked, and Afflatus's token works; wrong: locked against the token Afflatus has (or has none); unknown: it does not answer. */
  state: "open" | "locked" | "wrong" | "unknown";
  /** Its node pack can lock it. */
  canLock: boolean;
  /** Calls made on its own computer get in without the token. */
  local: boolean;
  /** Locked by its start settings (AFFLATUS_TOKEN): not changed from here. */
  fixed: boolean;
  /** Started with AFFLATUS_LOCK=off. */
  off: boolean;
  /** ComfyUI-Manager's version when it has one, and whether it is older than the one that closed the way in. */
  manager: string | null;
  managerOld: boolean;
}
export interface Settings {
  /** The ComfyUIs, the first first (the one the setup, downloads and node packs talk to); `comfyUrl` and `comfyDir` are the first one's. */
  machines: Machine[];
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
  /** A RunPod API key is set (rented machines). */
  hasRunpodKey: boolean;
  /** What the rented GPUs may cost, in USD, today and this month; 0: no cap. */
  rentCaps: { day: number; month: number };
  /** The last deploy's choices: the Deploy dialog opens with them, "Deploy again" repeats them. */
  lastDeploy: DeployAsk | null;
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
  /** Once a day, GitHub is asked whether a newer Afflatus is out (Settings → About); nothing about the user is sent. */
  afflatusUpdateChecks: boolean;
  /** The command bar's shortcut and its optional parts. */
  bar: BarSettings;
  /** The projects pinned to the rail under the one worked in, in their order there (four at most). */
  pinnedProjects: string[];
}
