/** The settings, the language models they name, and the start-up checks. */
import type { BarSettings } from "./bar";
import type { PresetFile } from "./designer";

/** Alive, the version, and the start-up checks: what this computer has of what Afflatus needs. */
export interface Health {
  ok: true;
  version: string;
  database: string;
  checks: HealthCheck[];
  checkedAt: string | null;
}
/** One of the start-up checks (preflight.ts). */
export interface HealthCheck {
  id: "node" | "ffmpeg" | "ffprobe" | "data";
  label: string;
  ok: boolean;
  detail: string;
  without: string;
  fix: string;
  /** Said though it passed: another ffmpeg than the PATH's is used, and why. */
  note?: string;
  /** What the page offers to put it right: Get ffmpeg's download, or Homebrew's line to copy. */
  get?: "download" | "brew";
}
/** Get ffmpeg (ffmpegGet.ts): how it is going. */
export interface FfmpegGetView {
  phase: "idle" | "downloading" | "unpacking" | "checking" | "done" | "failed";
  bytes: number;
  total: number;
  error: string | null;
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
/** A finish of clips finished already: skipped (false), all redone (true), or only those finished with other settings. */
export type FinishRedo = boolean | "changed";

export interface FinishSettings {
  route: "seedvr" | "latent" | "rtx" | "model" | "face";
  factor: number;
  colour: "lab" | "wavelet" | "adain" | "none";
  upscaleModel: string;
  latentDenoise: number;
  latentSteps: number;
  /** Face refine's denoise on the smallest faces. */
  faceDenoise?: number;
  seedvrFrames?: number;
  /** RCAS after a pixel route, 0 to 1; 0 = off. */
  sharpen?: number;
  /** Face refine with the latent re-sample, in the same job, on the clips whose model offers it. */
  face?: boolean;
}
/** A model the designer can write with, as Settings sends it back: its key only when one was typed (else the saved one is kept). */
export type LlmPatch = Omit<LlmInfo, "hasApiKey"> & { apiKey?: string };
/**
 * What PUT /api/settings takes: some of the settings, by key, merged by the server into the rest (a key it does not know is
 * refused). As the answer says them, but for what the answer hides: the Civitai key itself, the models with their keys,
 * and `llm`, the model in use changed the short way. Held to the server's schema by test/apiTypes.test.ts.
 */
export type SettingsPatch = Partial<Omit<Settings, "llm" | "llms" | "hasCivitaiKey" | "hasHuggingFaceToken" | "hasRunpodKey" | "hasRunpodS3Secret" | "machines" | "machinesSetAside" | "notify" | "access">> & {
  /** Some of the password's settings; the password itself has its own routes (api.setPassword), never this. */
  /** Refused from the page: the Access settings go through api.accessSettings, which asks for the password. */
  access?: Partial<Omit<AccessSettings, "hasPassword" | "passwordSetAt" | "hasMetricsToken">> & {
    password?: { hash: string; setAt: string } | null;
    metricsToken?: string;
    telegramChangedAt?: string;
  };
  /** Some of the notices' settings: what is sent is put over what is saved. The token and the webhook only when typed ("" takes one off). */
  notify?: { telegramToken?: string; telegramChat?: string; discordWebhook?: string; picture?: boolean; events?: Partial<Record<NotifyKind, { telegram?: boolean; discord?: boolean }>> };
  /**
   * The machines as the page has them, without what it is only told (a token's end). A token left out stays as it is.
   * `dirCleared` (the address a folder was emptied at by hand) is the server's own: the page never sends it. `clearDir`: this
   * machine's folder is emptied on purpose; any other empty folder may be a list read before the server found it, and is kept.
   */
  machines?: Array<Omit<Machine, "tokenEnd" | "local"> & { token?: string; dirCleared?: string; clearDir?: true }>;
  civitaiKey?: string;
  huggingFaceToken?: string;
  runpodKey?: string;
  runpodS3Secret?: string;
  /** The server's own list of secrets to delete once their pods are gone: the page never sends it. */
  leftSecrets?: Array<{ secret: string; pod: string }>;
  /** The server's own list of deploys whose machine is not saved yet: the page never sends it. */
  pendingDeploys?: Array<{ name: string; secret: string; at: string }>;
  llms?: LlmPatch[];
  llm?: Partial<Omit<LlmPatch, "id">>;
};
/** What Afflatus tells about (the server's notify.ts); `newDevice`: a sign-in from a device never seen (access.ts). */
export type NotifyKind = "renderDone" | "renderFailed" | "queueEmpty" | "renderStuck" | "podStopped" | "capReached" | "balanceLow" | "comfyGone" | "gpuFound" | "huntGaveUp" | "newDevice";
/** The optional password's settings (Settings › Interface › Access). The password itself never comes back: only whether there is one. */
export interface AccessSettings {
  hasPassword: boolean;
  /** When it was set (ISO); null without one. */
  passwordSetAt: string | null;
  /** A request from the computer Afflatus runs on needs no password. */
  localNoPassword: boolean;
  /** How long a remembered device stays signed in. */
  stayDays: 1 | 7 | 30 | 90;
  /** Reset codes may go to Telegram (when it is set up). */
  resetTelegram: boolean;
  /** A metrics token is set (for Prometheus while a password is set); the token itself is shown once, when made. */
  hasMetricsToken: boolean;
}
/** Where the notices go and which kinds go there. The bot's token and the webhook never come back: only whether one is saved. */
export interface NotifySettings {
  hasTelegramToken: boolean;
  telegramChat: string;
  hasDiscordWebhook: boolean;
  /** A small picture of what a render made goes with its message. */
  picture: boolean;
  events: Record<NotifyKind, { telegram: boolean; discord: boolean }>;
}
/** A notice as the server pushes it to the open pages ("notice"). */
export interface NoticeEvent {
  kind: NotifyKind;
  title: string;
  body: string;
}
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
  /** A node pack a render asks for that its ComfyUI lacks: the job waits for a click (Ask), or it is installed (Always). Rented pods always install. */
  packs: "ask" | "always";
  /** Families switched on or off on this machine by hand, over the switch of every machine (Settings › Models, its tab). */
  families: Record<string, boolean>;
  /** The last four characters of its token when its ComfyUI is locked (the token itself stays on the server); empty without one. */
  tokenEnd: string;
  /** Its ComfyUI runs on Afflatus's computer, as the server tells from its address (never a pod); absent on one the page made. */
  local?: boolean;
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
  /** The user stopped it, until it is started again. */
  userStopped: boolean;
  /** The network volume it was deployed on, by id ("" for none). */
  volume: string;
  /** Deployed only to fill its volume: it takes no render, and is terminated once its files are in. */
  fill: boolean;
  /** The image it was deployed with, when Afflatus deployed it ("" otherwise). */
  image: string;
  /** RunPod's cloud it was deployed on, when Afflatus deployed it. */
  cloud?: "SECURE" | "COMMUNITY";
  /** The files its deploy asked for, until its first answer hands them to it. */
  files: PresetFile[];
  /** The files its deploy left out, until its first answer. */
  leaveOut: Array<{ file: string; folder: string }>;
  /** Make room: the models Afflatus fetched there that no waiting job needs are deleted when a needed file does not fit. */
  makeRoom: boolean;
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
  /** The presets whose licence was accepted in the dialog (empty in lastDeploy). */
  accept: string[];
  /** Deploy again: nothing ticked, the remembered set's files come (false in lastDeploy). */
  again: boolean;
  /** The Afflatus image's CUDA build: 13.0 only (the default), 12.8, or either (13.0 first). The Hunt takes it too. */
  cuda: "13.0" | "12.8" | "either";
  /** This deploy alone on 12.8, as the dialog asked: the remembered pick stays (false in lastDeploy). */
  cudaOnce: boolean;
  /** Make room on its disk by deleting the models it fetched that no waiting job needs. */
  makeRoom: boolean;
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
  /**
   * The stored machines the server could not read whole (a hand edit, a setting it no longer takes): `mended`, only `fields`
   * took their default (`now`: each as it is meanwhile) and it is in `machines`; otherwise it is left out, its row kept, and
   * its pod (`pod`) stopped. `key`: what forgetSetAside names it by.
   */
  machinesSetAside: Array<{ key: string; label: string; mended: boolean; fields: string[]; now: string[]; pod: boolean; why: string }>;
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
  /** Model families switched on or off by hand; one that is not named follows its files, or is on with `allFamilies`. */
  families: Record<string, boolean>;
  /** A family not named in `families` is on whatever files are found (a new install's rule; "Turn them all on"). */
  allFamilies: boolean;
  /** The first launch's page: "pending" until it is done or skipped. */
  firstLaunch: "pending" | "done";
  hasCivitaiKey: boolean;
  /** A Hugging Face token is set (gated models). */
  hasHuggingFaceToken: boolean;
  /** A RunPod API key is set (rented machines). */
  hasRunpodKey: boolean;
  /** RunPod's S3 API key for the volume viewer: its access key (the user's id), and whether its secret is set. */
  runpodS3User: string;
  hasRunpodS3Secret: boolean;
  /** What the rented GPUs may cost, in USD, today and this month; 0: no cap. */
  rentCaps: { day: number; month: number };
  /** This PC's electricity, for the Costs tab: a kWh's price in the user's money (null: not said) and its symbol. */
  costs: { kwhPrice: number | null; currency: string };
  /** The last deploy's choices: the Deploy dialog opens with them, "Deploy again" repeats them. */
  lastDeploy: DeployAsk | null;
  /** A network volume no pod ran on for this many days is flagged; 0: never. */
  volumeUnusedDays: number;
  /** A deployed pod's boot log is kept with its run for this many days (Queue › Costs); 0: none is kept. */
  bootLogDays: number;
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
  /** How many days a finished job nothing still names stays in the Queue's history; 0 for good. */
  jobHistoryDays: number;
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
  /** The settings pinned to the top of the model forms, per model family (the H3 forms share "h3"): input ids, in their order. */
  pinnedFields: Record<string, string[]>;
  /** Notices on Telegram and Discord. */
  notify: NotifySettings;
  /** The optional password. */
  access: AccessSettings;
}

/** GET /api/session: what the page asks before anything else (access-api.ts). */
export interface SessionState {
  /** A password is set. */
  locked: boolean;
  /** This browser may use the app: no password, signed in, or this computer and it needs none. */
  signedIn: boolean;
  /** The request came from the computer Afflatus runs on: said only to a browser that is in. */
  local?: boolean;
  /** This computer gets in without the password now: said only to a browser that is in. */
  localNoPassword?: boolean;
  /** This browser holds a session (not only the computer's own pass). */
  session: boolean;
  stayDays: number;
  /** A reset code can go to Telegram. */
  telegram: boolean;
  /** Minutes before Telegram is a way again, after its bot or chat changed (0: not held). */
  telegramHeld: number;
  /** Seconds this address waits before its next try. */
  wait: number;
  /** Seconds before another reset code may be sent. */
  sendAgain: number;
}
/** A device signed in (Settings › Access). */
export interface SignedDevice {
  id: string;
  /** "Chrome on Windows": from its browser's own words. */
  name: string;
  firstSeen: string;
  ip: string;
  lastSeen: string;
  remember: boolean;
  /** The device asking. */
  here: boolean;
}
/** GET /api/session/devices: where Afflatus listens, and who is signed in. */
export interface SignedDevices {
  listen: { host: string; port: number; reach: "computer" | "network" | "address" };
  /** "From this computer" may be turned on: Afflatus listens beyond loopback. */
  canBypass: boolean;
  /** The last time sign-ins were being refused (within a day), as the owner was told. */
  alarm: { at: string; said: string } | null;
  devices: SignedDevice[];
}
