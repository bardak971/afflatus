import type { InputSpec, ModelInfo, VideoTraits } from "@studai/core";

export type { ModelInfo };
import type { Bindings, Inspection, Wiring, WorkflowDef } from "@studai/workflows";

/** Shapes of the server's answers. Kept next to the calls so a change on one side is noticed on the other. */

export interface RecipeInfo {
  id: string;
  family: string;
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  /** Of a video recipe: what it can do on a timeline. */
  traits: VideoTraits | null;
}
export interface FamilyInfo {
  id: string;
  name: string;
  summary: string;
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
  limitedBy: string[];
  options: Record<string, string[]>;
}
export interface Scan {
  at: string;
  comfy:
    | { online: true; url: string; version: string; device: string; vramTotal: number; vramFree: number; nodes: number }
    | { online: false; url: string; error: string };
  families: Array<{ id: string; slots: Array<{ id: string; label: string; file: string | null; optional: boolean; hint: string }> }>;
  recipes: RecipeStatus[];
}

export interface SystemLoad {
  source: "dasiwa" | "crystools" | "comfyui";
  cpu?: number;
  ram?: { used: number; total: number; percent: number };
  swap?: number;
  disks: Array<{ path: string; percent: number; readMbS?: number; writeMbS?: number }>;
  gpus: Array<{ name: string; load?: number; temperature?: number; vramUsed: number; vramTotal: number; vramPercent: number }>;
}

export interface Job {
  id: string;
  recipe: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  generationId: string | null;
  /** The timeline clip it renders a take of, when it is one. */
  clipId: string | null;
  /** "export": it puts a timeline together as one video instead of rendering. */
  kind: "render" | "export";
  /** Of a waiting job: about how long it will take, from past renders. */
  estimateMs: number | null;
  /** Of a failed job: what it was asked, so that a retry can change it. */
  input: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunningJob extends Job {
  progress: number;
  eta: number;
  phase: string;
  step: number;
  steps: number;
  previewSeq: number;
}
export interface QueueStatus {
  paused: boolean;
  online: boolean;
  offlineForMs: number;
  running: RunningJob | null;
  waiting: Job[];
  recent: Job[];
}

export interface Asset {
  id: string;
  kind: "image" | "video" | "audio";
  origin: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  hasSound: boolean;
  kept: boolean;
  inBin: boolean;
  folderId: string | null;
  generationId: string | null;
  createdAt: string;
}
export interface AssetDetail extends Asset {
  generation: null | {
    id: string;
    recipe: string;
    family: string;
    inputs: Record<string, unknown>;
    /** What was settled when it rendered: the seed that was drawn, the model files that were loaded. */
    resolved: { seed?: number; loads?: string[]; overlap?: { headMs: number; tailMs: number } };
    tookMs: number;
  };
  /** The pictures it was made from, and what each was for. */
  sources: Array<{ role: string; asset: Asset }>;
  /** What was made from it. */
  usedIn: Asset[];
}
export interface DraftBrief {
  id: string;
  recipe: string;
  title: string;
  target: string;
  updatedAt: string;
}
export interface Draft extends DraftBrief {
  /** Recipe id → the values of its form. */
  forms: Record<string, Record<string, unknown>>;
  count: number;
  /** Who is in it and how it looks. */
  look: Look | null;
  /** The conversation with the designer about it. */
  chat: unknown[];
}

/** What the designer answers: the full new text of the boxes it changes, or one question, or a plan of clips. */
export interface DesignerReply {
  kind: "proposal" | "question" | "plan";
  note: string;
  changes: Record<string, string>;
  question: string;
  options: string[];
  clips: Array<Record<string, string>>;
  /** Whether the language model was shown the picture the form opens on. */
  sawPicture?: boolean;
}

/** Who is in it and how it looks: people and places (a person with the outfit picked), and one style. */
export interface Look {
  cast: Array<{ id: string; outfit?: string | null }>;
  style?: string | null;
}
export interface Outfit {
  id: string;
  name: string;
  tags: string;
  sentence: string;
  picture: string | null;
}
export interface PersonDef {
  pictures: string[];
  voice: string | null;
  tags: string;
  sentence: string;
  /** Per model family: this person's LoRA, its strength, the word that calls it up. */
  models: Record<string, { lora: string | null; weight: number; trigger: string }>;
  outfits: Outfit[];
}
export interface PlaceDef {
  pictures: string[];
  tags: string;
  sentence: string;
}
export interface StyleDef {
  models: Record<string, { loras: Array<{ file: string; weight: number }>; words: string }>;
}
export interface PresetDef {
  recipe: string;
  inputs: Record<string, unknown>;
  look?: Look | null;
}
export type Entity =
  | { id: string; kind: "person"; name: string; def: PersonDef; updatedAt: string }
  | { id: string; kind: "place"; name: string; def: PlaceDef; updatedAt: string }
  | { id: string; kind: "style"; name: string; def: StyleDef; updatedAt: string }
  | { id: string; kind: "preset"; name: string; def: PresetDef; updatedAt: string }
  | { id: string; kind: "snippet"; name: string; def: { text: string }; updatedAt: string };
/** What a form becomes once its cast and style are worked in. */
export interface Composed {
  input: Record<string, unknown>;
  added: { words: Array<{ from: string; text: string }>; loras: Array<{ from: string; file: string }>; references: number; voice: string | null; skipped: string[] };
}
export interface ModelSettings {
  family: string;
  file: string;
  /** Input id → the value this model file starts with. */
  values: Record<string, unknown>;
}
export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
}
/** An imported workflow, as the list shows it. */
export interface WorkflowBrief {
  id: string;
  title: string;
  model: string;
  source: string;
  output: "image" | "video" | "audio";
  nodes: number;
}
/** What is saved for a workflow: the workflow itself and which of its parts studai fills in. */
export interface WorkflowBody {
  title: string;
  model: string;
  source: string;
  graph: WorkflowDef["graph"];
  wiring?: Wiring;
  bindings: Bindings;
}
/** One render of a clip. `startMs` to `endMs` is the part of its video that plays. */
export interface Take {
  id: string;
  asset: Asset;
  headMs: number;
  tailMs: number;
  trimStartMs: number;
  trimEndMs: number;
  startMs: number;
  endMs: number;
  createdAt: string;
}
export interface Clip {
  id: string;
  /** "still": a picture held on screen instead of a video. */
  kind: "video" | "still";
  still: Asset | null;
  /** What is heard while it plays, and how loud (0 to 100). */
  sound: "own" | "muted" | "file";
  soundAsset: Asset | null;
  volume: number;
  /** Of another shape than the timeline: true = it fills the frame, false = shown whole with bars. */
  fill: boolean;
  /** Its own cast and style; null = the timeline's. */
  look: Look | null;
  /** The conversation with the designer about this clip. */
  chat: unknown[];
  /** How it starts: carrying on from the clip before, or on its own. */
  joined: "continue" | "cut";
  /** Whether it still follows the clip before: null when there is nothing to compare yet. */
  join: "fresh" | "stale" | "cut" | null;
  recipe: string | null;
  inputs: Record<string, unknown>;
  take: Take | null;
  takes: Take[];
  atMs: number;
  lengthMs: number;
  job: { id: string; status: "queued" | "running" } | null;
  failed: string | null;
}
export interface Timeline {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
  durationMs: number;
  clips: Clip[];
  /** Who is in the video and how it looks, for every clip that has no cast of its own. */
  look: Look | null;
  /** The look and mood of the whole video, in words: added to what happens in every clip. */
  mood: string;
  /** The sound under the whole video. */
  music: { asset: Asset; volume: number; fadeInMs: number; fadeOutMs: number; duck: boolean } | null;
  /** What Undo would take back, in a few words. */
  undo: string | null;
  exporting: { id: string; status: "queued" | "running" } | null;
  exported: Asset | null;
  exportFailed: string | null;
}
export interface TimelineBrief {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
  clips: number;
  durationMs: number;
  cover: string | null;
}
export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: "continue" | "cut";
  take?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  after?: string | null;
  sound?: "own" | "muted" | "file";
  soundAsset?: string | null;
  volume?: number;
  fill?: boolean;
  stillMs?: number;
  animate?: boolean;
  look?: Look | null;
  chat?: unknown[];
}
export interface TimelinePatch {
  name?: string;
  width?: number | null;
  height?: number | null;
  music?: { asset?: string | null; volume?: number; fadeInMs?: number; fadeOutMs?: number; duck?: boolean };
  look?: Look | null;
  mood?: string;
}
/** How long a recipe usually takes on this machine, from what was rendered before. */
export interface Rate {
  perJobMs: number;
  perSecondMs: number | null;
  samples: number;
}
/** Where the space goes. */
export interface Storage {
  total: number;
  pictures: number;
  videos: number;
  sounds: number;
  idleTakes: { count: number; bytes: number };
  bin: { count: number; bytes: number };
  unkept: { count: number; bytes: number };
}
export interface Settings {
  comfyUrl: string;
  llm: { baseUrl: string; model: string; hasApiKey: boolean; vision: boolean };
  hasCivitaiKey: boolean;
  /** Missing model files may be looked for on Civitai. */
  civitaiLookups: boolean;
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. */
  downloadModels: boolean;
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
  status: "starting" | "downloading" | "saving" | "done" | "error";
  error?: string;
}
/** A word about one choice of a form: slow, or probably too much, on the card it will run on. */
export interface Advice {
  input: string;
  level: "slow" | "heavy";
  text: string;
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
  /** What a download of it fetches: the version, and how large its file is (0 when Civitai does not say). */
  versionId: number | null;
  bytes: number;
}

/** The server always answers errors as { error }, written for a person to read. */
export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
  return data as T;
}

export const api = {
  recipes: () => call<{ families: FamilyInfo[]; recipes: RecipeInfo[] }>("GET", "/recipes"),
  setup: (fresh = false) => call<Scan>("GET", `/setup${fresh ? "?fresh=1" : ""}`),
  settings: () => call<Settings>("GET", "/settings"),
  saveSettings: (patch: Record<string, unknown>) => call<Settings>("PUT", "/settings", patch),
  queue: () => call<QueueStatus>("GET", "/queue"),
  pause: () => call<QueueStatus>("POST", "/queue/pause"),
  resume: () => call<QueueStatus>("POST", "/queue/resume"),
  enqueue: (recipe: string, input: Record<string, unknown>, count: number, look?: Look | null) =>
    call<{ ids: string[] }>("POST", "/jobs", { recipe, input, count, ...(look && (look.cast.length || look.style) ? { look } : {}) }),
  entities: () => call<{ items: Entity[] }>("GET", "/entities"),
  createEntity: (kind: Entity["kind"], name: string, def?: unknown) => call<Entity>("POST", "/entities", def === undefined ? { kind, name } : { kind, name, def }),
  saveEntity: (id: string, patch: { name?: string; def?: unknown }) => call<Entity>("PUT", `/entities/${id}`, patch),
  deleteEntity: (id: string) => call<{ ok: true }>("DELETE", `/entities/${id}`),
  /** What the form becomes with its cast and style worked in. Nothing is queued. */
  compose: (recipe: string, input: Record<string, unknown>, look: Look) => call<Composed>("POST", "/compose", { recipe, input, look }),
  cancel: (id: string) => call<{ ok: true }>("POST", `/jobs/${id}/cancel`),
  /** The waiting jobs, in the order they should run. */
  queueOrder: (ids: string[]) => call<QueueStatus>("POST", "/queue/order", { ids }),
  /** A finished job again; `input` changes some of what it was asked. */
  retryJob: (id: string, input?: Record<string, unknown>) => call<{ id: string }>("POST", `/jobs/${id}/retry`, input ? { input } : {}),
  dismissJob: (id: string) => call<{ ok: true }>("DELETE", `/jobs/${id}`),
  estimates: () => call<{ rates: Record<string, Rate> }>("GET", "/estimates"),
  advice: (recipe: string, input: Record<string, unknown>) => call<{ items: Advice[] }>("POST", "/advice", { recipe, input }),
  civitaiFind: (file: string) => call<{ items: CivitaiFind[] }>("GET", `/civitai/find?${new URLSearchParams({ file })}`),
  /** What a file from the computer says about how it was made. The file is the request body; nothing is stored. */
  embedded: async (file: File) => {
    const res = await fetch("/api/embedded", { method: "POST", headers: { "Content-Type": /^(image|video|audio)\//.test(file.type) ? file.type : "application/octet-stream" }, body: file });
    const data = (await res.json().catch(() => ({}))) as Embedded & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
    return data;
  },
  downloads: () => call<{ on: boolean; items: Download[]; manager: { found: boolean; version?: string } }>("GET", "/downloads"),
  startDownload: (body: { file: string; folder: string } & ({ civitai: number } | { url: string })) => call<Download>("POST", "/downloads", body),
  storage: () => call<Storage>("GET", "/storage"),
  binIdleTakes: () => call<{ moved: number }>("POST", "/storage/bin-idle-takes"),
  emptyBin: () => call<{ erased: number }>("POST", "/storage/empty-bin"),
  assetFamilies: () => call<{ items: string[] }>("GET", "/assets/families"),
  /** The sound of a video, as a sound of its own in the library. */
  takeSound: (video: string) => call<Asset>("POST", `/assets/${video}/sound`),
  assets: (opts: { kind?: string; bin?: boolean; folder?: string; after?: string; q?: string; family?: string; kept?: boolean }) => {
    const q = new URLSearchParams({ limit: "40" });
    if (opts.kind) q.set("kind", opts.kind);
    if (opts.bin) q.set("bin", "1");
    if (opts.folder) q.set("folder", opts.folder);
    if (opts.after) q.set("after", opts.after);
    if (opts.q?.trim()) q.set("q", opts.q.trim());
    if (opts.family) q.set("family", opts.family);
    if (opts.kept) q.set("kept", "1");
    return call<{ items: Asset[]; next: string | null }>("GET", `/assets?${q}`);
  },
  asset: (id: string) => call<AssetDetail>("GET", `/assets/${id}`),
  keep: (id: string, kept: boolean) => call<Asset>("POST", `/assets/${id}/keep`, { kept }),
  bin: (id: string) => call<{ ok: true }>("DELETE", `/assets/${id}`),
  restore: (id: string) => call<Asset>("POST", `/assets/${id}/restore`),
  drafts: () => call<{ items: DraftBrief[] }>("GET", "/drafts"),
  draft: (id: string) => call<Draft>("GET", `/drafts/${id}`),
  createDraft: (body: { recipe: string; forms?: Draft["forms"]; count?: number; look?: Look | null }) => call<Draft>("POST", "/drafts", body),
  saveDraft: (id: string, patch: { recipe?: string; forms?: Draft["forms"]; count?: number; look?: Look | null; chat?: unknown[] }) => call<Draft>("PUT", `/drafts/${id}`, patch),
  /** One turn of the conversation with the designer about a form. */
  designer: (body: { recipe: string; values: Record<string, unknown>; messages: Array<{ role: "user" | "assistant"; content: string }>; mode: "chat" | "enhance"; previous?: string; story?: { clips: string[]; index: number }; look?: Look | null; mood?: string }) =>
    call<DesignerReply>("POST", "/designer", body),
  /** A scene written as several clips: the text of each. */
  designerPlan: (body: { recipe: string; idea: string; clips: number; values?: Record<string, unknown>; look?: Look | null; mood?: string }) =>
    call<{ note: string; clips: Array<Record<string, string>> }>("POST", "/designer/plan", body),
  designerTest: () => call<{ ok: true; model: string; answer: string }>("POST", "/designer/test"),
  /** New clips at the end of a timeline, one per planned text, each flowing on from the one before. */
  planTimeline: (id: string, recipe: string, clips: Array<Record<string, string>>) => call<{ clips: string[]; timeline: Timeline }>("POST", `/timelines/${id}/plan`, { recipe, clips }),
  deleteDraft: (id: string) => call<{ ok: true }>("DELETE", `/drafts/${id}`),
  modelSettings: () => call<{ items: ModelSettings[] }>("GET", "/model-settings"),
  saveModelSettings: (body: ModelSettings) => call<ModelSettings>("PUT", "/model-settings", body),
  forgetModelSettings: (family: string, file: string) => call<{ ok: true }>("DELETE", `/model-settings?${new URLSearchParams({ family, file })}`),
  /** What the files of one model folder say about themselves; `pending` are still being read. */
  modelInfo: (folder: string) => call<{ items: Record<string, ModelInfo>; pending: number }>("GET", `/models/${folder}/info`),
  folders: () => call<{ items: Folder[] }>("GET", "/folders"),
  createFolder: (name: string, parentId: string | null) => call<Folder>("POST", "/folders", { name, parentId }),
  editFolder: (id: string, patch: { name?: string; parentId?: string | null }) => call<{ ok: true }>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => call<{ ok: true }>("DELETE", `/folders/${id}`),
  moveAssets: (ids: string[], folderId: string | null) => call<{ moved: number }>("POST", "/assets/move", { ids, folderId }),
  /** A picture, a video or a sound from this computer, into the library. The file is the request body. */
  upload: async (file: File, opts: { /** The painted part of a picture: kept, but not shown in the library. */ mask?: boolean } = {}) => {
    if (!/^(image|video|audio)\//.test(file.type)) throw new ApiError("This file is not a picture, a video or a sound.");
    const res = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}${opts.mask ? "&as=mask" : ""}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const data = (await res.json().catch(() => ({}))) as Asset & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
    return data as Asset;
  },
  workflows: () => call<{ items: WorkflowBrief[] }>("GET", "/workflows"),
  workflow: (id: string) => call<WorkflowDef>("GET", `/workflows/${id}`),
  /** Takes the file as it is (ComfyUI's own save, an export) or a workflow studai holds; answers with it in the form studai keeps. */
  inspectWorkflow: (file: unknown) => call<Inspection & { graph: WorkflowDef["graph"]; wiring?: Wiring }>("POST", "/workflows/inspect", file),
  createWorkflow: (body: WorkflowBody) => call<WorkflowBrief>("POST", "/workflows", body),
  saveWorkflow: (id: string, body: WorkflowBody) => call<WorkflowBrief>("PUT", `/workflows/${id}`, body),
  deleteWorkflow: (id: string) => call<{ ok: true }>("DELETE", `/workflows/${id}`),
  timelines: () => call<{ items: TimelineBrief[] }>("GET", "/timelines"),
  timeline: (id: string) => call<Timeline>("GET", `/timelines/${id}`),
  createTimeline: (name?: string) => call<Timeline>("POST", "/timelines", name ? { name } : {}),
  editTimeline: (id: string, patch: TimelinePatch) => call<Timeline>("PATCH", `/timelines/${id}`, patch),
  undoTimeline: (id: string) => call<{ undone: string }>("POST", `/timelines/${id}/undo`),
  deleteTimeline: (id: string) => call<{ ok: true }>("DELETE", `/timelines/${id}`),
  /** A new clip: empty, or from a video or a picture of the library. After `after`, first when null, last when left out. */
  addClip: (timeline: string, body: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip" }) => call<{ clip: string; timeline: Timeline }>("POST", `/timelines/${timeline}/clips`, body),
  editClip: (id: string, patch: ClipPatch) => call<{ ok: true }>("PATCH", `/clips/${id}`, patch),
  deleteClip: (id: string) => call<{ ok: true }>("DELETE", `/clips/${id}`),
  deleteTake: (id: string) => call<{ ok: true }>("DELETE", `/takes/${id}`),
  renderClips: (timeline: string, clips: Array<{ id: string; input: Record<string, unknown>; fit?: boolean }>) => call<{ ids: string[] }>("POST", `/timelines/${timeline}/render`, { clips }),
  /** Asks for the export: it runs in the queue, and the timeline says when it is there. */
  exportTimeline: (id: string, opts: { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean }) => call<{ id: string }>("POST", `/timelines/${id}/export`, opts),
  /** One frame of a video, saved as a picture in the library. */
  frame: (video: string, atMs: number) => call<Asset>("POST", `/assets/${video}/frame`, { atMs }),
};

export const fileUrl = (id: string) => `/api/assets/${id}/file`;
export const thumbUrl = (id: string) => `/api/assets/${id}/thumb`;
/** Twelve frames of a video side by side, spread over its length. */
export const stripUrl = (id: string) => `/api/assets/${id}/strip`;
export const STRIP_FRAMES = 12;
export const previewUrl = (jobId: string, seq: number) => `/api/jobs/${jobId}/preview?s=${seq}`;
