/** Models and recipes: what ComfyUI has, what each recipe needs, imported workflows, and where a missing file can be had. */
import type { Chapter, InputSpec, VideoTraits } from "@afflatus/core";
import type { Bindings, Wiring, WorkflowDef } from "@afflatus/workflows";
import type { PresetFile } from "./designer";

export interface RecipeInfo {
  id: string;
  family: string;
  /** Made from a workflow the user imported (Workflows), not built in. */
  imported?: true;
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  /** Chapters the recipe arranges itself (an imported workflow's sections), in order. */
  chapters?: Chapter[];
  /** Of a video recipe: what it can do on a timeline. */
  traits: VideoTraits | null;
  /** The model files it names itself (an imported workflow's). */
  models?: string[];
  /** What a model file starts on the first time it is used, by its name (its line's recommended settings). */
  presets?: Array<{ match: string; values: Record<string, unknown>; note?: string }>;
}
export interface FamilyInfo {
  id: string;
  name: string;
  summary: string;
  /** The family of workflows the user imported under one model name, not a built-in one. */
  imported?: true;
  /** Patterns that tell which LoRAs were made for this family. */
  loraMatch?: string[];
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
}
export interface Scan {
  at: string;
  comfy:
    | { online: true; url: string; version: string; device: string; vramTotal: number; vramFree: number; nodes: number }
    | { online: false; url: string; error: string };
  families: Array<{ id: string; slots: Array<{ id: string; label: string; folder: string; file: string | null; choices: string[]; auto: string | null; chosen: boolean; optional: boolean; hint: string; get?: { file: string; url: string } }> }>;
  recipes: RecipeStatus[];
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
  presets: Array<{ id: string; name: string; files: PresetFile[]; bytes: number }>;
  families: Array<{ id: string; name: string; files: Array<{ file: string; folder: string; url: string }> }>;
  files: Array<{ file: string; folder: string; size?: number }>;
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
  civitai?: { version: number; pick?: string; page?: string };
  via: FileVia | null;
  /** Bytes, when known. */
  size: number | null;
}

/** The Deploy dialog's Models part: the waiting jobs' files, the picked set's, and what earlier deploys measured. */
export interface DeployModels {
  jobs: { count: number; files: Array<DeployFile & { jobs: number; first: boolean }> };
  set: Array<DeployFile & { preset?: { id: string; name: string }; off: boolean }> | null;
  licences: Array<{ id: string; name: string; licence: string }>;
  speeds: Record<FileVia, MeasuredRange | null>;
  boot: MeasuredRange | null;
}
