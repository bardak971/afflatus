/** Models and recipes: what ComfyUI has, what each recipe needs, imported workflows, and where a missing file can be had. */
import type { Chapter, ComfyTooOld, InputSpec, ModelLine, StartRule, VideoTraits } from "@afflatus/core";
import type { Bindings, Wiring, WorkflowDef } from "@afflatus/workflows";
import type { PresetFile } from "./designer";

export interface RecipeInfo {
  id: string;
  family: string;
  /** The input that is the prompt as sent, written from the form's parts while it is left empty (POST /form/prompt). */
  partsInto?: string;
  /** Texts that field may hold that the form started on, not typed (a swap's LoRA caption): read as empty (core's typedInto). */
  partsStartOn?: string[];
  /** Made from a workflow the user imported (Workflows), not built in. */
  imported?: true;
  /** Not offered for now (core's Recipe.hidden): what was made with it still opens. */
  hidden?: true;
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  /** Chapters the recipe arranges itself (an imported workflow's sections), in order. */
  chapters?: Chapter[];
  /** The form's cards drawn first, in this order, by id. */
  first?: string[];
  /** Of a video recipe: what it can do on a timeline. */
  traits: VideoTraits | null;
  /** The model files it names itself (an imported workflow's). */
  models?: string[];
  /** What a model file starts on the first time it is used, by its name (its line's recommended settings). */
  presets?: Array<{ match: string; values: Record<string, unknown>; note?: string }>;
  /** Settings whose start depends on the family's files as well as on the form (core's StartRule). */
  starts?: StartRule[];
  /** The family's optional files (slot ids) it cannot run without, as Edit needs FLUX.1's Kontext model. */
  needs?: string[];
}
export interface FamilyInfo {
  id: string;
  name: string;
  summary: string;
  /** What its "?" says: what it makes, what it is best and weak at (built-in families). */
  help?: { what: string; best: string; weak: string };
  /** The family of workflows the user imported under one model name, not a built-in one. */
  imported?: true;
  /** Patterns that tell which LoRAs were made for this family. */
  loraMatch?: string[];
  /** Its versions, whose LoRAs do not carry over (LTX-2, 2.3, 2.5): a LoRA of another one is listed with the other models. */
  line?: ModelLine;
  /** Its files (the server's ModelSlot): where each goes and, for the official ones, where it is had (`get`). */
  slots?: FamilySlot[];
}

/** One of a family's files, as the recipes describe it: its folder, and its official download when there is one. */
export interface FamilySlot {
  id: string;
  label?: string;
  folder: string;
  optional?: boolean;
  get?: { file: string; url: string };
  /** The recipes that alone use it: while every one of them is hidden, it is not offered. */
  onlyFor?: string[];
}
export interface RecipeStatus {
  id: string;
  ready: boolean;
  missingNodes: string[];
  missingSlots: string[];
  emptyInputs: string[];
  missingFiles: string[];
  /** The same files with the folder each belongs in and, when its author gave one, where it can be had. */
  missing: Array<{ file: string; folder: string | null; url?: string }>;
  /** What ComfyUI would refuse in it, in the checker's words. */
  problems: string[];
  limitedBy: string[];
  options: Record<string, string[]>;
  /** The files its family's slots use here (slot id → file), for the settings that start by them. */
  slots?: Record<string, string>;
}
/** A ComfyUI asked at an address without saving it (the server's /api/setup/probe). */
export interface ComfyProbe {
  url: string;
  online: boolean;
  version: string | null;
  /** What it says of itself beyond its version (the server's comfyFacts): its PyTorch, the families it is too old for, and how to update it. */
  pytorch: string | null;
  tooOld: ComfyTooOld | null;
  update: string | null;
  device: string | null;
  /** It answered, but refused Afflatus: locked by a token to paste once it is added. */
  locked: boolean;
  error: string | null;
  /** Its folder, when it runs on this machine: Afflatus writes its node pack in by itself once it is added. */
  dir: string | null;
  /** It runs on this machine (its folder found or not). */
  local: boolean;
}

export interface Scan {
  at: string;
  comfy:
    | { online: true; url: string; version: string; pytorch?: string; device: string; vramTotal: number; vramFree: number; nodes: number }
    // `planned`: no ComfyUI answers and none of the user's own is expected: what a pod would offer (the server's plannedScan)
    | { online: false; url: string; error: string; locked?: boolean; planned?: true };
  families: Array<{ id: string; slots: Array<{ id: string; label: string; folder: string; file: string | null; choices: string[]; auto: string | null; chosen: boolean; optional: boolean; hint: string; get?: { file: string; url: string };
    /** Only hidden recipes use it: not shown in Settings › Models (the scan keeps it, for jobs). */
    onlyHidden?: true }> }>;
  recipes: RecipeStatus[];
  /** Where each file is across the machines (every machine together only; the server's filePlaces.ts). */
  places?: FilePlaces;
}
/** A file a pod holds or fetches that no answering ComfyUI lists: offered greyed, picked as any other. */
export interface OfferedFile {
  file: string;
  /** The pod's machine id. */
  pod: string;
  /** On its network volume as last listed, or in the model set it was deployed with (fetched by the pod). */
  via: "volume" | "set";
  set?: string;
  bytes?: number;
}
/** Where each model file is: by folder and file, the machines listing it now (only with a pod in the settings); what pods hold beyond that; the pods not up. */
export interface FilePlaces {
  on?: Record<string, Record<string, string[]>>;
  offered: Record<string, OfferedFile[]>;
  down: Record<string, string>;
}
/** A model file and its Civitai version; `newer` when Civitai has a later one. */
export interface UpdateRow {
  folder: string;
  file: string;
  modelId: number;
  modelName: string;
  versionId: number;
  versionName: string;
  newer: { id: number; name: string; publishedAt: string | null; file: string | null; page: string } | null;
  checkedAt: string;
}
export interface UpdateReport {
  items: UpdateRow[];
  unmatched: number;
  hashesLeft: number;
  checkedAt: string | null;
  lookups: boolean;
  /** Why the last check did not go through; null once one has. */
  error?: string | null;
}
/** Where ComfyUI shows a workflow Afflatus put there: straight from the address, or from its Workflows sidebar. */
export interface Opened {
  url: string;
  direct: boolean;
  path?: string;
  restart?: boolean;
}
/** The words that call a model file up beyond what the file says: the user's own, and the ones its page gave. */
export interface ModelWords {
  own: string | null;
  found: string | null;
}
export interface ModelSettings {
  family: string;
  file: string;
  /** Input id → the value this model file starts with. */
  values: Record<string, unknown>;
}
/** An imported workflow, as the list shows it. */
export interface WorkflowBrief {
  id: string;
  title: string;
  model: string;
  source: string;
  output: "image" | "video" | "audio";
  nodes: number;
  /** Why it is not offered as a form: it could not be built (a newer node's format, say). Still listed, so it can be fixed or removed. */
  problem?: string;
  /** An agent imported it (MCP) and it waits for the user's Approve before it renders: the token's name, and what it reaches. */
  waiting?: { by: string; reaches: WorkflowReach[] };
}
/** A node of a workflow that reads or writes a path or fetches an address (server workflowReach.ts), with the inputs that do. */
export interface WorkflowReach {
  node: string;
  type: string;
  title?: string;
  inputs: Array<{ input: string; value?: string; from?: string; onForm?: true }>;
}
/** What is saved for a workflow: the workflow itself and which of its parts Afflatus fills in. */
export interface WorkflowBody {
  title: string;
  model: string;
  source: string;
  graph: WorkflowDef["graph"];
  wiring?: Wiring;
  /** The editor's own file, when the workflow came from one. */
  editor?: unknown;
  bindings: Bindings;
}
/** What a pasted link to a model leads to. */
export interface LinkFound {
  source: "civitai" | "huggingface" | "address";
  title: string;
  about: string;
  page: string;
  version?: number;
  versions?: Array<{ id: number; name: string }>;
  url?: string;
  files: Array<{ name: string; bytes: number; note: string }>;
  folder: string | null;
  why?: string;
  /** ComfyUI's model folders. */
  folders: string[];
  /** Files ComfyUI already has under the same name: file name to the folder it is in. */
  have: Record<string, string>;
}
/** The page of a model file on the site it came from. */
export interface ModelPage {
  url: string;
  title: string;
}
export interface PageCandidate extends ModelPage {
  site: string;
  about: string;
}
/** What a dropped file carries about how it was made. */
export interface Embedded {
  settings: null | {
    recipe: string;
    input: Record<string, unknown>;
    source: "a1111" | "comfyui";
    notes: string[];
    /** Its model and LoRAs that this ComfyUI does not have. */
    missing: Array<{ file: string; folder: string; civitai?: number }>;
    model: { name: string; found: boolean } | null;
    loras: Array<{ name: string; weight: number; found: boolean }>;
    /** The forms these settings can fill, the likeliest first, with why when there is a reason. */
    targets: Array<{ id: string; why?: string }>;
  };
  /** A ComfyUI workflow, when the file has one. */
  workflow: unknown | null;
  why: string | null;
}
/** A model file being fetched into ComfyUI. */
export interface Download {
  id: string;
  file: string;
  folder: string;
  title: string;
  bytes: number;
  total: number;
  status: "starting" | "downloading" | "saving" | "done" | "error" | "stopped";
  error?: string;
  /** While starting: what it waits for (Afflatus downloads two files at a time, ComfyUI-Manager one). */
  waiting?: string;
  /** Who downloads it: Afflatus itself, the Afflatus node pack, or ComfyUI-Manager. */
  via?: DownloadVia;
  /** The directory it is written into, when Afflatus or the node pack writes it. */
  into?: string;
  /** What to know while it runs: it was cut and picked up again, or ComfyUI-Manager may not cope with its size. */
  note?: string;
  /** Its failure was read (its banner dismissed): a page opened later does not announce it again. */
  seen?: boolean;
  /** The ComfyUI it goes to, by id, when one was asked for (several ComfyUIs). */
  machine?: string;
  /** Failed or stopped, and askable again as it was asked through a page (across restarts too): `api.downloadAgain`. */
  again?: true;
  /** Waiting or under way: its place in its ComfyUI's line, those under way counted first (1 and 2 run, 3 is next). */
  turn?: number;
  /** Where it goes (under way) or went (done), in a few words: "models\loras" under ComfyUI's folder, else the whole path. */
  shown?: string;
  /** How fast it comes now, in bytes a second (evened out by the server); absent while nothing is measured. */
  rate?: number;
  /** When it ended, in ms since 1970. */
  at?: number;
  /** Taken from the line, though still "starting" (a node pack whose line is full): no longer waiting its turn, nor moved. */
  begun?: boolean;
}
/** Where a model file is on disk (card #64): each place it is, when ComfyUI runs on Afflatus's machine. */
export interface FileWhere {
  /** Its places can be known: ComfyUI runs on the machine Afflatus runs on. */
  known: boolean;
  /** Each place it is, ComfyUI's own models/<folder> first; several are copies of it. */
  places: Array<{ path: string; kind: "own" | "older" | "other" }>;
  /** Show in folder is offered: this page is open on that same computer. */
  reveal: boolean;
}
/** Where a list of model files is on disk (card #74): FileWhere's of each, its places in the order the files were named. */
export interface FilesWhere {
  known: boolean;
  places: Array<FileWhere["places"]>;
  reveal: boolean;
}
/** One of the paths ComfyUI reads a model folder from (card #59). */
export interface DownloadPlace {
  path: string;
  /** ComfyUI's own models/<folder>, its folder's other name there (unet, clip), or another folder ComfyUI reads (extra_model_paths.yaml). */
  kind: "own" | "older" | "other";
  /** In a few words: "models\loras" under ComfyUI's folder, the whole path for any other. */
  shown: string;
  /** Whether Afflatus can write it (ComfyUI on this machine); absent for a ComfyUI elsewhere, whose node pack checks. */
  ok?: boolean;
}
/** Where a model folder's downloads go on a ComfyUI: its places, the one chosen (Settings), and where a download goes now. */
export interface FolderPlaces {
  places: DownloadPlace[];
  chosen?: string;
  goes?: string;
  /** Downloads here go a way that cannot be told a place (ComfyUI-Manager, an older node pack): `goes` only, no choice. */
  fixed?: true;
}
/** Who downloads model files into this ComfyUI ("none": nothing can). */
export type DownloadVia = "afflatus" | "pack" | "manager";
/** A file of exactly the name that is missing, found in a repository on Hugging Face. */
export interface HuggingFaceFind {
  repo: string;
  path: string;
  url: string;
  page: string;
  downloads: number;
  gated: boolean;
}
/** A model found on Civitai for a file that is missing. */
export interface CivitaiFind {
  name: string;
  kind: string;
  url: string;
  version: string;
  base: string;
  words: string[];
  exact: boolean;
  /** What a download of it fetches: the version, the file's own name, and how large it is (0 when Civitai does not say). */
  versionId: number | null;
  file: string;
  bytes: number;
  /** That file's SHA-256 and Civitai's id for it, when the search gives them: the download asks for it by these (card #80). */
  sha256?: string;
  fileId?: number;
  /** The site that has it: civitai.com, or civitai.red. */
  site: string;
  /** It is the kind of model the folder holds (a workflow found by the same words is not). */
  fits: boolean;
  /** The words of the name asked for that are in its own names, and how many words that name has. */
  hits: string[];
  of: number;
  /** This ComfyUI already has the file a download of it would fetch: in which kind of folder, under which name. */
  have?: { folder: string; file: string };
}

/** Where a model file comes from onto a rented pod: Hugging Face, Civitai, another address, or this computer (an upload). */
export type FileVia = "hf" | "civitai" | "url" | "upload";

/** A Model set (Settings › Models): a named list of model files, presets by reference and files of its own. */
export interface ModelSet {
  id: string;
  name: string;
  presets: Array<{ id: string; name: string; licence?: { name: string }; accepted: boolean; gone?: boolean }>;
  files: PresetFile[];
  /** Files of its presets left out of it ("folder|name"). */
  off: string[];
  /** The files it brings and their bytes, as far as known. */
  count: number;
  bytes: number;
  updatedAt: string;
}

/** One file of a set, as listed: where it comes from and which machines have it. */
export interface SetFile extends PresetFile {
  preset?: { id: string; name: string };
  off: boolean;
  via: FileVia | null;
  /** Machine id → whether its ComfyUI lists it (a machine that did not answer is left out). */
  on: Record<string, boolean>;
}

/** What can be added to a set or a deploy, found by words. */
export interface SetSearch {
  presets: Array<{ id: string; name: string; files: Array<PresetFile & { via: FileVia | null }>; bytes: number }>;
  families: Array<{ id: string; name: string; files: Array<{ file: string; folder: string; url: string; via: FileVia | null }> }>;
  files: Array<{ file: string; folder: string; size?: number; via: FileVia | null }>;
}

/** The slowest and fastest of what earlier deploys measured: bytes a second for a source, ms for a boot. */
export interface MeasuredRange {
  low: number;
  high: number;
  count: number;
}

/** A model file a deploy may bring onto its pod. */
export interface DeployFile {
  file: string;
  folder: string;
  url?: string;
  civitai?: { version: number; pick?: string; page?: string; sha256?: string; fileId?: number };
  via: FileVia | null;
  /** Bytes, when known. */
  size: number | null;
}

/** The Deploy dialog's Models part: the waiting jobs' files, the picked set's, and what earlier deploys measured. */
export interface DeployModels {
  jobs: { count: number; files: Array<DeployFile & { jobs: number; first: boolean }> };
  set: Array<DeployFile & { preset?: { id: string; name: string }; off: boolean }> | null;
  /** Presets under a licence not accepted yet, with their files (fileKey): a deploy bringing one asks for it. */
  licences: Array<{ id: string; name: string; licence: string; keys: string[] }>;
  speeds: Record<FileVia, MeasuredRange | null>;
  boot: MeasuredRange | null;
}

/** Find models (the server's browse.ts): where a browsed file comes from. */
/** A Civitai file by its name as listed, and by its SHA-256 and Civitai's id when known (its version page may name it otherwise). */
export type BrowseSource = { kind: "civitai"; version: number; pick: string; fileId?: number; sha256?: string } | { kind: "url"; url: string };
/** What the user has of a browsed file already: this PC's file (same SHA-256, or name), a Model set holding it. */
export type BrowseHave = { kind: "pc"; folder: string; file: string } | { kind: "set"; name: string };

export interface BrowseFile {
  name: string;
  bytes: number;
  /** What tells it apart from its version's others ("fp8 · pruned"), or its place in a Hugging Face repository. */
  note: string;
  sha256: string | null;
  /** The ComfyUI folder it goes in; null when not known (the user picks it). */
  folder: string | null;
  why?: string;
  source: BrowseSource;
  have: BrowseHave[];
}

export interface BrowseVersion {
  id: string;
  name: string;
  base: string;
  publishedAt: string | null;
  trainedWords: string[];
  files: BrowseFile[];
}

/** A model of Civitai or a repository of Hugging Face, as the browser shows it. */
export interface BrowseCard {
  site: "civitai" | "huggingface";
  id: string;
  name: string;
  type: string;
  base: string;
  creator: string;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  thumb: string | null;
  page: string;
  licence: { commercial: boolean | null; credit: boolean; derivatives: boolean | null };
  fits: string | null;
  have: boolean;
  update: { have: string; latest: string } | null;
  gated: boolean;
  versions: BrowseVersion[];
  modelFiles?: number;
}

export interface BrowsePage {
  items: BrowseCard[];
  next: string | null;
}

/** The browser's filters: the user's families with their base models (Civitai's names, Hugging Face's repositories), the types and sorts. */
export interface BrowseBases {
  families: Array<{ id: string; name: string; on: boolean; bases: string[]; hf: string[] }>;
  types: string[];
  sorts: string[];
  periods: string[];
}

/** How far the hashing of this PC's model files is, and what the sites said of them (the server's modelHashes.ts). */
export interface HashStatus {
  files: number;
  hashed: number;
  hashing: { folder: string; file: string; bytes: number; total: number } | null;
  paused: boolean;
  civitai: number;
  huggingFace: number;
  nowhere: number;
  noFolder: boolean;
  /** A pass looked at the folders (before, nothing is known yet). */
  looked: boolean;
  error: string | null;
}
