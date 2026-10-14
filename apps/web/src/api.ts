import { projectForNew, projectParam } from "./project";
import { unlistOptions, type ListedOptions, type ModelInfo, type RankedGpu } from "@afflatus/core";
import type { Inspection, Wiring, WorkflowDef } from "@afflatus/workflows";
export type { ModelInfo };
import type { Advice, FillPlan, GpuOffer, HuntAsk, HuntView, HistoryPage, NetworkVolume, VolumePlan, QueueStatus, TimesPeriod, TimesWindow, TimesSummary, RenderItem, RentedSpending, RentedState, RunpodPod } from "./api/types/queue";
import type { Asset, AssetDetail, Folder, Project, ProjectsTree, Storage } from "./api/types/library";
import type { Timeline, RangeContext, TimelineBrief, ClipPatch, TimelinePatch } from "./api/types/timeline";
import { lookAdds, type DraftBrief, type Draft, type DraftPatch, type DesignerReply, type TagIssue, type Look, type Entity, type Composed, type PresetFilesView, type PresetFile } from "./api/types/designer";
import type { DeployAsk, Health, FinishSettings, MachineProbe, Settings, SettingsPatch } from "./api/types/settings";
import type { UpdatesView } from "./api/types/updates";
import type { CommandEntry, CommandEstimate, CommandIndex, PromptHistoryItem } from "./api/types/bar";
import type { RecipeInfo, RecipeStatus, FamilyInfo, Scan, ModelSettings, ModelWords, UpdateReport, Opened, WorkflowBrief, WorkflowBody, LinkFound, ModelPage, PageCandidate, Embedded, Download, DownloadVia, HuggingFaceFind, CivitaiFind, DeployModels, ModelSet, SetFile, SetSearch, BrowseBases, BrowseCard, BrowseFile, BrowsePage, HashStatus } from "./api/types/models";

/** Shapes of the server's answers. Kept next to the calls so a change on one side is noticed on the other. */
export * from "./api/types/queue";
export * from "./api/types/library";
export * from "./api/types/timeline";
export * from "./api/types/designer";
export * from "./api/types/settings";
export * from "./api/types/models";
export * from "./api/types/bar";
export * from "./api/types/updates";
/** The server always answers errors as { error }, written for a person to read. */
export class ApiError extends Error {
  /** The HTTP status the server answered with; absent when it did not answer. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** A request the network refused (the server stopped, the connection dropped): said as such, not as the browser's "Failed to fetch". */
export const NOT_ANSWERING = "Afflatus is not answering. Is it still running?";
async function send(input: string, init: RequestInit): Promise<Response> {
  try {
    // the server takes a change only with this header, JSON or a file: a plain form from another site has none of them
    return await fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Afflatus": "1" } });
  } catch (err) {
    // a request given up on (a query no longer needed) stays an abort, for React Query to tell apart
    if (err instanceof TypeError) throw new ApiError(NOT_ANSWERING);
    throw err;
  }
}

/**
 * A request whose answer the caller reads itself (a draft's 404 says it is gone), or that must outlive the page
 * (`keepalive`: a save made as the tab closes; the browser takes at most 64 KiB of body that way). Through `send`, so
 * the server being away reads NOT_ANSWERING; an answer that is not a success is the caller's (`failure` says it).
 */
export function raw(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<Response> {
  return send(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: opts.keepalive,
  });
}

/** What a request that did not succeed says, as `call` throws it: the server's own words, and its status. */
export async function failure(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(data.error ?? `the server answered ${res.status}`, res.status);
}

/** `signal`: a query's, so that a query that is cancelled (refetched, left) also stops its request. */
async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text().catch(() => "");
  let data: { error?: string } = {};
  try {
    if (text) data = JSON.parse(text) as { error?: string };
  } catch {
    // a success with a body that is not JSON is not Afflatus answering (a proxy's page, a login wall): said, never handed on
    // as an empty answer the screen would take for real. An empty body (a plain "done") stays {}.
    if (res.ok) throw new ApiError(`the server answered with something that is not Afflatus's (${res.headers.get("content-type") ?? "no type"})`, res.status);
  }
  if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`, res.status);
  return data as T;
}

export interface PacksStarted {
  jobs: Array<{ pack: string; id: string }>;
  /** Node types no pack is known for. */
  unknown: string[];
  /** Packs Manager's queue cannot install (a single file, a gist). */
  skipped: string[];
}
interface PackState { id: string; state: "pending" | "done" | "failed"; message?: string }

/** What a query hands its function: its signal (see call). `queryFn: api.queue` passes it as it is. */
type Asked = { signal?: AbortSignal };
/** A machine named in a query (`?machine=`), or nothing. */
const machineParam = (machine?: string) => (machine ? `?machine=${encodeURIComponent(machine)}` : "");

/** A list of the library: its filters, its page and its order. */
export type AssetFilter = { kind?: string; bin?: boolean; folder?: string; after?: string; before?: string; q?: string; family?: string; kept?: boolean; /** Only what was not kept (kept wins when both are said). */ unkept?: boolean; model?: string; lora?: string; draft?: string; since?: string; all?: boolean; /** A page's size: 40 when not said. */ limit?: number; /** The order (newest first when not said); `dir` turns name and size around. */ sort?: "new" | "old" | "name" | "size"; dir?: "asc" | "desc" };
/** The query of a list of the library (`api.assets`), and of what sums one up (`api.unkept`). */
function assetParams(opts: AssetFilter): URLSearchParams {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 40) });
  // within the project the app looks at, unless a folder, the bin or a draft says where to look, or `all` asks for everything
  if (!opts.folder && !opts.bin && !opts.draft && !opts.all && projectParam()) q.set("project", projectParam()!);
  if (opts.since) q.set("since", opts.since);
  if (opts.kind) q.set("kind", opts.kind);
  if (opts.bin) q.set("bin", "1");
  if (opts.folder) q.set("folder", opts.folder);
  if (opts.after) q.set("after", opts.after);
  if (opts.before) q.set("before", opts.before);
  if (opts.q?.trim()) q.set("q", opts.q.trim());
  if (opts.family) q.set("family", opts.family);
  if (opts.kept) q.set("kept", "1");
  else if (opts.unkept) q.set("kept", "0");
  if (opts.model) q.set("model", opts.model);
  if (opts.lora) q.set("lora", opts.lora);
  if (opts.draft) q.set("draft", opts.draft);
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.dir) q.set("dir", opts.dir);
  return q;
}

export const api = {
  recipes: (o?: Asked) => call<{ families: FamilyInfo[]; recipes: RecipeInfo[] }>("GET", "/recipes", undefined, o?.signal),
  /** What ComfyUI can do; each recipe's options come as places in a list of lists (core's listOptions), put back here. */
  /** `machine`: that ComfyUI's alone; without, what every machine together can do (the same with one). */
  setup: (o?: Asked, machine?: string) => call<ListedOptions<RecipeStatus> & Omit<Scan, "recipes">>("GET", `/setup${machineParam(machine)}`, undefined, o?.signal).then((sent): Scan => unlistOptions(sent)),
  /** ComfyUI asked again, now: its address, its files, its nodes. A POST, since it does work on the server. */
  rescanSetup: (machine?: string) => call<ListedOptions<RecipeStatus> & Omit<Scan, "recipes">>("POST", `/setup/rescan${machineParam(machine)}`).then((sent): Scan => unlistOptions(sent)),
  health: (o?: Asked) => call<Health>("GET", "/health", undefined, o?.signal),
  /** The tools Afflatus needs looked for again, now. */
  checkHealth: () => call<Health>("POST", "/health/check"),
  settings: (o?: Asked) => call<Settings>("GET", "/settings", undefined, o?.signal),
  saveSettings: (patch: SettingsPatch) => call<Settings>("PUT", "/settings", patch),
  /** "Afflatus: test" sent now to Telegram or Discord, with the saved settings: an error says why it did not go. */
  testNotify: (channel: "telegram" | "discord") => call<{ ok: true }>("POST", "/notify/test", { channel }),
  /** The chats that wrote to the saved bot lately (Telegram's getUpdates, read once). */
  telegramChats: () => call<{ chats: Array<{ id: string; name: string; type: string }> }>("POST", "/notify/telegram-chat"),
  /** Afflatus's own updates: where it stands (the latest release, an update under way, the previous version, the 0.3 move). */
  updates: (o?: Asked) => call<UpdatesView>("GET", "/updates", undefined, o?.signal),
  /** The rest only from the computer Afflatus runs on (403 from another): GitHub asked now. */
  checkUpdates: () => call<UpdatesView>("POST", "/updates/check"),
  /** Update to the latest release: it goes on in the background, its steps on the event stream. */
  startUpdate: () => call<UpdatesView>("POST", "/updates/update"),
  /** Not now / Cancel: the update stopped before it switches; a failed one forgotten. */
  cancelUpdate: () => call<UpdatesView>("POST", "/updates/cancel"),
  /** Back to the previous version, with the library as it was at the update; Afflatus restarts. */
  goBack: () => call<UpdatesView>("POST", "/updates/go-back"),
  /** The 0.3 library beside this bundle brought in (moved, not copied); Afflatus restarts. */
  moveLibrary: () => call<UpdatesView>("POST", "/updates/move"),
  presetFiles: (o?: Asked) => call<{ online: boolean; items: PresetFilesView[] }>("GET", "/presets/files", undefined, o?.signal),
  nodePack: (o?: Asked) => call<{ pack: string; path: string; written: boolean; loaded: boolean; canWrite: boolean }>("GET", "/comfy/node-pack", undefined, o?.signal),
  getPresetFiles: (id: string, body: { accept?: boolean; optional?: boolean } = {}) => call<{ started: Download[]; failed: Array<{ file: string; error: string }>; skipped: number }>("POST", `/presets/${encodeURIComponent(id)}/get`, body),
  queue: (o?: Asked) => call<QueueStatus>("GET", "/queue", undefined, o?.signal),
  /** `after`: the page after the one whose `next` it is; the first page without it. */
  jobs: (filter: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; after?: string; limit?: number }, o?: Asked) =>
    call<HistoryPage>("GET", `/jobs?${new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])))}`, undefined, o?.signal),
  /** Pause or go on: all of them, or one machine (a Machine's id), which finishes what it runs and takes nothing new. */
  pause: (machine?: string) => call<QueueStatus>("POST", "/queue/pause", machine ? { machine } : {}),
  resume: (machine?: string) => call<QueueStatus>("POST", "/queue/resume", machine ? { machine } : {}),
  /** Every other machine paused, this one going: everything waiting goes to it. */
  useOnly: (machine: string) => call<QueueStatus>("POST", "/queue/use-only", { machine }),
  /** A waiting job pinned to a machine, or back to whichever the queue picks (null). */
  pinJob: (id: string, machine: string | null) => call<QueueStatus>("POST", `/jobs/${id}/machine`, { machine }),
  /** Each ComfyUI asked now: whether it answers, its version, its GPU and the node pack it loaded. */
  machines: (o?: Asked) => call<MachineProbe[]>("GET", "/machines", undefined, o?.signal),
  /** Lock a ComfyUI to Afflatus (the node pack's lock), or change its lock: `renew` makes a new token, `local` lets calls from its own computer in. Checked before it counts. */
  lockMachine: (id: string, o: { local?: boolean; renew?: boolean } = {}) => call<{ ok: true; tokenEnd: string }>("POST", `/machines/${encodeURIComponent(id)}/lock`, o),
  unlockMachine: (id: string) => call<{ ok: true }>("POST", `/machines/${encodeURIComponent(id)}/unlock`, {}),
  /** A token made elsewhere, pasted: kept only when the ComfyUI lets it in. */
  machineToken: (id: string, token: string) => call<{ ok: true; tokenEnd: string }>("POST", `/machines/${encodeURIComponent(id)}/token`, { token }),
  /** The token itself, asked for on purpose (Copy token). */
  copyMachineToken: (id: string) => call<{ token: string }>("POST", `/machines/${encodeURIComponent(id)}/token/copy`, {}),
  /** The user's pods on RunPod, read with the key: which expose ComfyUI, which are added already. */
  runpodPods: (o?: Asked) => call<{ pods: RunpodPod[] }>("GET", "/runpod/pods", undefined, o?.signal),
  /** The GPUs a pod can be deployed on now, on that cloud: price, and where they are free. */
  runpodGpus: (cloud: DeployAsk["cloud"], o?: Asked) => call<{ gpus: GpuOffer[] }>("GET", `/runpod/gpus?cloud=${cloud}`, undefined, o?.signal),
  /** The RunPod account's network volumes. */
  runpodVolumes: (o?: Asked) => call<{ volumes: NetworkVolume[] }>("GET", "/runpod/volumes", undefined, o?.signal),
  volumePlan: (sets: string[] | null, o?: Asked) => call<VolumePlan>("GET", `/runpod/volumes/plan${sets ? `?sets=${encodeURIComponent(sets.join(","))}` : ""}`, undefined, o?.signal),
  makeVolume: (body: { name: string; size: number; dataCenter: string }) => call<{ volume: NetworkVolume }>("POST", "/runpod/volumes", body),
  growVolume: (id: string, size: number) => call<{ ok: true }>("PATCH", `/runpod/volumes/${encodeURIComponent(id)}`, { size }),
  deleteVolume: (id: string) => call<{ ok: true }>("DELETE", `/runpod/volumes/${encodeURIComponent(id)}`),
  fillPlan: (id: string, set: string, o?: Asked) => call<FillPlan>("GET", `/runpod/volumes/${encodeURIComponent(id)}/fill?set=${encodeURIComponent(set)}`, undefined, o?.signal),
  fillVolume: (id: string, set: string, accept: string[] = []) => call<{ id: string }>("POST", `/runpod/volumes/${encodeURIComponent(id)}/fill`, { set, accept }),
  /** A GPU deployed, as the dialog asked: billed from now. Its machine's id. */
  deployGpu: (ask: DeployAsk) => call<{ id: string }>("POST", "/runpod/deploy", ask),
  /** The GPU hunt under way (GET /api/hunt): its choices, its last ranking and when RunPod was last asked. */
  hunt: (o?: Asked) => call<HuntView>("GET", "/hunt", undefined, o?.signal),
  /** A hunt started with the Deploy dialog's choices but the GPU, which it picks; refused with words (a hunt or a deploy under way, no key, a cap). */
  startHunt: (ask: HuntAsk & { deploy: Omit<DeployAsk, "gpu"> }) => call<HuntView>("POST", "/hunt", ask),
  changeHunt: (change: Partial<HuntAsk>) => call<HuntView>("PATCH", "/hunt", change),
  cancelHunt: () => call<{ ok: true }>("DELETE", "/hunt"),
  /** The dialog's live ranking for these choices, and how many renders wait; RunPod is read again at most every 20 s. */
  huntRank: (ask: Omit<HuntAsk, "giveUpMinutes" | "hold"> & { cloud: DeployAsk["cloud"]; volume: string }, o?: Asked) => call<{ ranking: RankedGpu[]; held: number }>("POST", "/hunt/rank", ask, o?.signal),
  /** The Deploy dialog's Models part: the waiting jobs' files, the picked set's, and what earlier deploys measured. */
  deployModels: (cloud: DeployAsk["cloud"], set: string, o?: Asked) => call<DeployModels>("GET", `/runpod/deploy/models?${new URLSearchParams({ cloud, set })}`, undefined, o?.signal),
  /** The Model sets (Settings › Models). */
  modelSets: (o?: Asked) => call<{ items: ModelSet[] }>("GET", "/model-sets", undefined, o?.signal),
  /** A set made (no id) or changed. */
  saveModelSet: (id: string | null, body: { name: string; presets: string[]; files: PresetFile[]; off: string[] }) => call<ModelSet>(id ? "PUT" : "POST", id ? `/model-sets/${encodeURIComponent(id)}` : "/model-sets", body),
  deleteModelSet: (id: string) => call<{ ok: true }>("DELETE", `/model-sets/${encodeURIComponent(id)}`),
  duplicateModelSet: (id: string) => call<ModelSet>("POST", `/model-sets/${encodeURIComponent(id)}/duplicate`, {}),
  /** A set's files, with where each comes from and which machines have it. */
  modelSetFiles: (id: string, o?: Asked) => call<{ items: SetFile[] }>("GET", `/model-sets/${encodeURIComponent(id)}/files`, undefined, o?.signal),
  /** The set's files a machine lacks, fetched there (the first ComfyUI without one); a preset's licence accepted with `accept`. */
  getModelSetFiles: (id: string, body: { machine?: string; accept?: boolean } = {}) => call<{ sent: number; failed: Array<{ file: string; error: string }>; skipped: number }>("POST", `/model-sets/${encodeURIComponent(id)}/get`, body),
  /** A set file brought in (Import): a new set of its files. */
  importModelSet: (file: unknown) => call<ModelSet>("POST", "/model-sets/import", file),
  /** What can be added to a set or a deploy: presets, families, this computer's files. */
  searchModelSets: (q: string, o?: Asked & { many?: boolean }) => call<SetSearch>("GET", `/model-sets/search?q=${encodeURIComponent(q)}${o?.many ? "&many=1" : ""}`, undefined, o?.signal),
  /** A machine removed from Afflatus: a rented pod is left on RunPod as it is (its secret goes once the pod does). */
  removeMachine: (id: string) => call<{ ok: true }>("POST", `/machines/${encodeURIComponent(id)}/remove`, {}),
  /** Whether each image a deploy may run can be pulled now (null: its registry did not answer). */
  runpodImages: (o?: Asked) => call<{ afflatus: boolean | null; runpod: boolean | null }>("GET", "/runpod/images", undefined, o?.signal),
  /** A pod added as a machine, as it is: nothing is started. */
  addRunpodPod: (pod: string) => call<{ id: string }>("POST", "/runpod/add", { pod }),
  /** The user's Start of a rented machine: refused at a spending cap. */
  startMachine: (id: string) => call<RentedState>("POST", `/machines/${encodeURIComponent(id)}/start`, {}),
  /** The user's Stop (the disk goes on billing) or Terminate (the pod gone on RunPod, and from Afflatus). */
  stopMachine: (id: string, how: "stop" | "terminate") => call<RentedState | null>("POST", `/machines/${encodeURIComponent(id)}/stop`, { how }),
  /** What the rented GPUs cost today and this month, the caps, RunPod's balance; null without a rented machine. */
  rentedSpending: (o?: Asked) => call<{ spending: RentedSpending | null }>("GET", "/rented/spending", undefined, o?.signal),
  /** Where to open ComfyUI's own page: locked, its login with a one-time code. */
  openMachine: (id: string) => call<{ url: string }>("POST", `/machines/${encodeURIComponent(id)}/open`, {}),
  /** `into`: the draft it is sent from, the folder that is open (where its results are filed), and the machine it is pinned to. */
  enqueue: (recipe: string, input: Record<string, unknown>, count: number, look?: Look | null, into?: { draft?: string; folder?: string; seedMode?: "up" | "down"; machine?: string }) =>
    call<{ ids: string[] }>("POST", "/jobs", { recipe, input, count, ...(lookAdds(look) ? { look } : {}), ...(into?.draft ? { draft: into.draft } : {}), ...(into?.folder ? { folder: into.folder } : {}), ...(into?.seedMode ? { seedMode: into.seedMode } : {}), ...(into?.machine ? { machine: into.machine } : {}) }),
  /** Load the models this form would render with, ahead of the render. A job in the queue that makes nothing. */
  /** A form's models loaded ahead: on `machine` (a Machine's id), else where its render would run. */
  warm: (recipe: string, input: Record<string, unknown>, look?: Look | null, machine?: string) => call<{ id: string }>("POST", "/jobs/warm", { recipe, input, ...(lookAdds(look) ? { look } : {}), ...(machine ? { machine } : {}) }),
  /** Whether the models this form would render with are the ones ComfyUI was last asked to load. Null: it cannot be told. */
  loaded: (recipe: string, input: Record<string, unknown>, look?: Look | null) => call<{ loaded: boolean | null; on: string | null }>("POST", "/comfy/loaded", { recipe, input, ...(lookAdds(look) ? { look } : {}) }),
  entities: (o?: Asked) => call<{ items: Entity[] }>("GET", "/entities", undefined, o?.signal),
  createEntity: (kind: Entity["kind"], name: string, def?: unknown) => call<Entity>("POST", "/entities", def === undefined ? { kind, name } : { kind, name, def }),
  saveEntity: (id: string, patch: { name?: string; def?: unknown }) => call<Entity>("PUT", `/entities/${id}`, patch),
  deleteEntity: (id: string) => call<{ ok: true }>("DELETE", `/entities/${id}`),
  /** What the form becomes with its cast and style worked in. Nothing is queued. */
  compose: (recipe: string, input: Record<string, unknown>, look: Look) => call<Composed>("POST", "/compose", { recipe, input, look }),
  cancel: (id: string) => call<{ ok: true }>("POST", `/jobs/${id}/cancel`),
  /** Every waiting job cancelled in one request; with `ids`, only those of them that still wait. The running job goes on. */
  cancelWaiting: (ids?: string[]) => call<{ cancelled: number }>("POST", "/queue/cancel-waiting", ids ? { ids } : {}),
  /** The waiting jobs, in the order they should run. */
  queueOrder: (ids: string[]) => call<QueueStatus>("POST", "/queue/order", { ids }),
  /** A finished job again; `input` changes some of what it was asked. */
  retryJob: (id: string, input?: Record<string, unknown>) => call<{ id: string }>("POST", `/jobs/${id}/retry`, input ? { input } : {}),
  /** Finished jobs off the history, several in one request (a batch's row); what they made stays in the library. */
  dismissJobs: (ids: string[]) => call<{ dismissed: number }>("POST", "/jobs/dismiss", { ids }),
  /** Finished jobs again, several in one request ("Retry all"), in the order given; with `dismiss`, the ones queued again leave the history. */
  retryJobs: (ids: string[], dismiss = false) => call<{ ids: string[]; failed: number }>("POST", "/jobs/retry", { ids, dismiss }),
  /** The render times of a period or a window; of one machine (a Machine's id) when one is named. */
  renderTimes: (range: TimesPeriod | TimesWindow, o?: Asked & { machine?: string | null }) => call<TimesSummary>("GET", `${typeof range === "string" ? `/renders/summary?period=${range}` : `/renders/summary?from=${Math.round(range.from)}&to=${Math.round(range.to)}`}${o?.machine ? `&machine=${encodeURIComponent(o.machine)}` : ""}`, undefined, o?.signal),
  renders: (opts: { recipe?: string; trouble?: boolean; before?: string; limit?: number; from?: number; to?: number; machine?: string | null }, o?: Asked) =>
    call<{ total: number; more: boolean; items: RenderItem[] }>("GET", `/renders?${new URLSearchParams({ ...(opts.recipe ? { recipe: opts.recipe } : {}), ...(opts.trouble ? { only: "trouble" } : {}), ...(opts.before ? { before: opts.before } : {}), ...(opts.from ? { from: String(Math.round(opts.from)) } : {}), ...(opts.to ? { to: String(Math.round(opts.to)) } : {}), ...(opts.machine ? { machine: opts.machine } : {}), limit: String(opts.limit ?? 50) })}`, undefined, o?.signal),
  renderRecordSize: (o?: Asked) => call<{ renders: number; days: number; bytes: number }>("GET", "/renders/size", undefined, o?.signal),
  /** ComfyUI's terminal log, the last few hundred lines (`t`: when, `m`: the line). */
  /** ComfyUI's log; `since`: the stamp of the last line had, for the lines from then on only. */
  comfyLogs: (since?: string, o?: Asked & { machine?: string }) => call<{ lines: Array<{ t: string; m: string }> }>("GET", `/comfy/logs?${new URLSearchParams({ ...(since ? { since } : {}), ...(o?.machine ? { machine: o.machine } : {}) })}`, undefined, o?.signal),
  clearRenderRecord: () => call<{ ok: true }>("DELETE", "/renders"),
  /** Everything the command bar can find, in one answer. */
  /** `items`: the library's items to hold beside the newest few (those the bar used lately). */
  commandIndex: (items: readonly string[] = [], o?: Asked) => call<CommandIndex>("GET", `/command-index${items.length ? `?items=${items.map(encodeURIComponent).join(",")}` : ""}`, undefined, o?.signal),
  /** The library's items, the bin's too, whose name could match what is typed in the bar: the bar ranks them with its index. */
  commandItems: (q: string, o?: Asked) => call<{ entries: CommandEntry[] }>("GET", `/command-items?q=${encodeURIComponent(q)}`, undefined, o?.signal),
  /** What rendering would take: a timeline's clips (by number, 1 = the first; left out, those with nothing rendered yet) or a draft's next render. */
  commandEstimate: (of: { timeline: string; clips?: number[] } | { draft: string }, o?: Asked) =>
    call<CommandEstimate>("GET", `/command-estimate?${"draft" in of ? `draft=${encodeURIComponent(of.draft)}` : `timeline=${encodeURIComponent(of.timeline)}${of.clips?.length ? `&clips=${of.clips.join(",")}` : ""}`}`, undefined, o?.signal),
  /** What each form would take to render once, learned from this machine's renders (the same forecast as commandEstimate's); null where nothing like it was rendered yet. */
  forecasts: (forms: Array<{ recipe: string; input: Record<string, unknown> }>, o?: Asked) => call<{ ms: Array<number | null> }>("POST", "/forecasts", { forms }, o?.signal),
  /** The prompts that were rendered, each once, newest first; `q`: only those holding it. */
  promptHistory: (q?: string, limit?: number, o?: Asked) => {
    const params = new URLSearchParams();
    if (q?.trim()) params.set("q", q.trim());
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return call<{ items: PromptHistoryItem[] }>("GET", `/prompt-history${qs ? `?${qs}` : ""}`, undefined, o?.signal);
  },
  advice: (recipe: string, input: Record<string, unknown>) => call<{ estimate: Advice | null }>("POST", "/advice", { recipe, input }),
  civitaiFind: (file: string, folder: string | null, hints: string[] = []) =>
    call<{ items: CivitaiFind[]; exact: HuggingFaceFind[]; asked: string[]; silent: string[] }>(
      "GET", `/civitai/find?${new URLSearchParams({ file, ...(folder ? { folder } : {}), ...(hints.length ? { hints: hints.join("|") } : {}) })}`,
    ),
  /** What a file from the computer says about how it was made. The file is the request body; nothing is stored. */
  embedded: async (file: File, recipe?: string) => {
    const res = await send(`/api/embedded${recipe ? `?recipe=${encodeURIComponent(recipe)}` : ""}`, { method: "POST", headers: { "Content-Type": /^(image|video|audio)\//.test(file.type) ? file.type : "application/octet-stream" }, body: file });
    const data = (await res.json().catch(() => ({}))) as Embedded & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`, res.status);
    return data;
  },
  /** The same for a picture or a video already in the library. */
  assetEmbedded: (id: string, recipe?: string) => call<Embedded>("GET", `/assets/${id}/embedded${recipe ? `?recipe=${encodeURIComponent(recipe)}` : ""}`),
  /** `machine`: who would download into that ComfyUI; the first one otherwise. The list is every download's. */
  downloads: (o?: Asked, machine?: string) => call<{ on: boolean; items: Download[]; manager: { found: boolean; version?: string }; via: DownloadVia | "none" }>("GET", `/downloads${machineParam(machine)}`, undefined, o?.signal),
  stopDownload: (id: string) => call<{ ok: true }>("DELETE", `/downloads/${id}`),
  /** A failed download's banner was dismissed: not announced again, on any page or device. */
  downloadSeen: (id: string) => call<{ ok: true }>("POST", `/downloads/${id}/seen`),
  /** Find models: the filters' choices, Civitai's and Hugging Face's models a page at a time, a repository's files, a link read. */
  browseBases: (o?: Asked) => call<BrowseBases>("GET", "/browse/bases", undefined, o?.signal),
  browseCivitai: (q: { q: string; types: string[]; bases: string[]; sort: string; period: string; all: boolean; cursor?: string }, o?: Asked) => {
    const p = new URLSearchParams({ q: q.q, sort: q.sort, period: q.period, all: q.all ? "1" : "0" });
    for (const t of q.types) p.append("types", t);
    for (const b of q.bases) p.append("bases", b);
    if (q.cursor) p.set("cursor", q.cursor);
    return call<BrowsePage>("GET", `/browse/civitai?${p}`, undefined, o?.signal);
  },
  browseHuggingFace: (q: { q: string; base: string; kind: "comfyui" | "loras" | "all"; sort: string; cursor?: string }, o?: Asked) => {
    const p = new URLSearchParams({ q: q.q, sort: q.sort, kind: q.kind });
    if (q.base) p.set("base", q.base);
    if (q.cursor) p.set("cursor", q.cursor);
    return call<BrowsePage>("GET", `/browse/huggingface?${p}`, undefined, o?.signal);
  },
  browseRepoFiles: (repo: string, o?: Asked) => call<{ files: BrowseFile[] }>("GET", `/browse/huggingface/files?repo=${encodeURIComponent(repo)}`, undefined, o?.signal),
  /** How far the hashing of this PC's model files is, and which site has each; Hash now. */
  modelHashes: (o?: Asked) => call<HashStatus>("GET", "/models/hashes", undefined, o?.signal),
  hashModels: () => call<HashStatus>("POST", "/models/hashes/run", {}),
  browseLink: (link: string) => call<{ card: BrowseCard }>("POST", "/browse/link", { link }),
  startDownload: (body: { file: string; folder: string; page?: ModelPage; machine?: string } & ({ civitai: number; pick?: string } | { url: string })) => call<Download>("POST", "/downloads", body),
  /** What a pasted link leads to: its files, the folder it most likely belongs in, ComfyUI's folders, and what ComfyUI has already. */
  resolveLink: (link: string) => call<LinkFound>("POST", "/downloads/resolve", { link }),
  storage: (o?: Asked) => call<Storage>("GET", "/storage", undefined, o?.signal),
  /** What a backup would hold: the files and bytes, and whether the database comes with it (SQLite). */
  backupPlan: (o?: Asked) => call<{ available: boolean; files: number; bytes: number; database: boolean }>("GET", "/backup", undefined, o?.signal),
  binIdleTakes: () => call<{ moved: number }>("POST", "/storage/bin-idle-takes"),
  emptyBin: () => call<{ erased: number; inUse?: number }>("POST", "/storage/empty-bin"),
  /** Some items of the bin erased now, for good (the bin's Delete now). */
  eraseBinned: (ids: string[]) => call<{ erased: number; inUse?: number }>("POST", "/storage/empty-bin", { ids }),
  /** Everything in the bin back where it was. */
  restoreBin: () => call<{ restored: number }>("POST", "/storage/restore-bin"),
  assetFamilies: (o?: Asked) => call<{ items: string[] }>("GET", "/assets/families", undefined, o?.signal),
  /** The model files and the LoRAs things in the library were made with, the most used first. */
  assetModels: (o?: Asked) => call<{ models: Array<{ file: string; count: number }>; loras: Array<{ file: string; count: number }> }>("GET", "/assets/models", undefined, o?.signal),
  /** Which tags of a prompt danbooru does not have. */
  checkTags: (text: string, ignore: string[]) => call<{ issues: TagIssue[] }>("POST", "/tags/check", { text, ignore }),
  /** The words known for the files of a model folder beyond what the files say, by file name (lower case, without sub-folder). */
  modelWords: (folder: string, o?: Asked) => call<{ items: Record<string, ModelWords> }>("GET", `/models/${folder}/words`, undefined, o?.signal),
  /** The user's own words for a file; empty takes them away. */
  setModelWords: (folder: string, file: string, words: string | null) => call<{ items: Record<string, ModelWords> }>("PUT", `/models/${folder}/words`, { file, words }),
  /** Ask Civitai, by fingerprint, for the words of files that say none: once per file, and only when lookups are on. */
  findModelWords: (folder: string, files: string[]) => call<{ items: Record<string, ModelWords>; lookups: boolean }>("POST", `/models/${folder}/words/find`, { files }),
  /** The sound of a video, as a sound of its own in the library. */
  takeSound: (video: string) => call<Asset>("POST", `/assets/${video}/sound`),
  /** The video again without its sound, a new item beside it. */
  silence: (video: string) => call<Asset>("POST", `/assets/${video}/silent`),
  assets: (opts: AssetFilter, o?: Asked) =>
    call<{ items: Asset[]; next: string | null; prev: string | null }>("GET", `/assets?${assetParams(opts)}`, undefined, o?.signal),
  /** The items not kept of a list (its filters; the page and the order do not count): how many, when the countdown of the first and of the last started, their ids with `ids`. */
  unkept: (opts: AssetFilter, ids: boolean, o?: Asked) => {
    const q = assetParams(opts);
    if (ids) q.set("ids", "1");
    return call<{ count: number; from: string | null; to: string | null; ids?: string[] }>("GET", `/assets/unkept?${q}`, undefined, o?.signal);
  },
  asset: (id: string, o?: Asked) => call<AssetDetail>("GET", `/assets/${id}`, undefined, o?.signal),
  keep: (id: string, kept: boolean) => call<Asset>("POST", `/assets/${id}/keep`, { kept }),
  /** Several items at once: kept or not, to the bin, or back from it. */
  bulkAssets: (ids: string[], action: "keep" | "unkeep" | "bin" | "restore") => call<{ changed: number }>("POST", "/assets/bulk", { ids, action }),
  bin: (id: string) => call<{ ok: true }>("DELETE", `/assets/${id}`),
  restore: (id: string) => call<Asset>("POST", `/assets/${id}/restore`),
  /** The drafts of the project the app looks at (see project.ts). */
  drafts: (o?: Asked) => call<{ items: DraftBrief[]; unused: number }>("GET", `/drafts${projectParam() ? `?project=${encodeURIComponent(projectParam()!)}` : ""}`, undefined, o?.signal),
  /** The drafts with no prompt, no name and nothing made from them, deleted, but the open one. */
  clearUnusedDrafts: (keep?: string) => call<{ deleted: number }>("POST", "/drafts/clear-unused", { project: projectParam() ?? undefined, keep }),
  draft: (id: string, o?: Asked) => call<Draft>("GET", `/drafts/${id}`, undefined, o?.signal),
  /** A new draft, in the project the app looks at unless another is named. */
  createDraft: (body: { recipe: string; forms?: Draft["forms"]; count?: number; look?: Look | null; project?: string | null; name?: string }) => call<Draft>("POST", "/drafts", { ...body, project: body.project === undefined ? projectForNew() : body.project }),
  saveDraft: (id: string, patch: DraftPatch) => call<Draft>("PUT", `/drafts/${id}`, patch),
  /** One turn of the conversation with the designer about a form. */
  /** What the designer will know about a form before anything is said: the pictures whose story it has, and the clip it carries on from. */
  designerKnows: (recipe: string, values: Record<string, unknown>) =>
    call<{ pictures: Array<{ what: string; steps: Array<{ title: string; with: string | null; said: boolean }> }>; continues: boolean }>("POST", "/designer/knows", { recipe, values }),
  designer: (body: { recipe: string; values: Record<string, unknown>; messages: Array<{ role: "user" | "assistant"; content: string }>; mode: "chat" | "enhance"; llm?: string; instruction?: string; previous?: string; story?: { clips: string[]; index: number }; look?: Look | null; mood?: string }) =>
    call<DesignerReply>("POST", "/designer", body),
  /** A scene written as several clips: the text of each. */
  /** Every family's prompting guide: the built-in text and the user's own, when one is written. */
  designerGuides: () => call<{ items: Array<{ id: string; name: string; imported?: true; style: "tags" | "sentences" | "sections"; guide: string; own: string }> }>("GET", "/designer/guides"),
  /** The system prompt the designer would be given for this form, word for word. */
  designerSystem: (body: { recipe: string; values: Record<string, unknown>; mode?: "chat" | "enhance"; llm?: string; instruction?: string; previous?: string; story?: { clips: string[]; index: number }; look?: Look | null; mood?: string }) =>
    call<{ system: string; sees: boolean }>("POST", "/designer/system", body),
  designerPlan: (body: { recipe: string; idea: string; clips: number; values?: Record<string, unknown>; look?: Look | null; mood?: string }) =>
    call<{ note: string; clips: Array<Record<string, string>> }>("POST", "/designer/plan", body),
  /** The pages known for the files of a model folder, by file name (lower case, without sub-folder). */
  modelPages: (folder: string, o?: Asked) => call<{ items: Record<string, ModelPage> }>("GET", `/models/${folder}/pages`, undefined, o?.signal),
  /** The model files matched to their Civitai version, and the newer version when there is one. */
  modelUpdates: (o?: Asked) => call<UpdateReport>("GET", "/models/updates", undefined, o?.signal),
  checkModelUpdates: () => call<UpdateReport>("POST", "/models/updates/check"),
  /** Look for a file's page: the one known, or the one found for sure, or the ones it may be. */
  findModelPage: (folder: string, file: string) => call<{ page: ModelPage | null; candidates: PageCandidate[]; lookups: boolean }>("POST", `/models/${folder}/page`, { file }),
  /** Say which page is the file's; null forgets it. */
  setModelPage: (folder: string, file: string, url: string | null, title = "") => call<{ page: ModelPage | null }>("PUT", `/models/${folder}/page`, { file, url, title }),
  /** Unload the models now: on one machine, or on every one that is not rendering. */
  freeMemory: (machine?: string) => call<{ ok: true }>("POST", "/comfy/free", machine ? { machine } : {}),
  designerTest: (id?: string) => call<{ ok: true; model: string; answer: string; ms: number; thinks: boolean; vision: { ok: boolean; answer: string } | null }>("POST", "/designer/test", id ? { id } : {}),
  /** Every conversation with the designer, in drafts and on timelines, is forgotten. */
  forgetConversations: () => call<{ forgotten: number }>("DELETE", "/designer/conversations"),
  /** New clips at the end of a timeline, one per planned text, each flowing on from the one before. */
  planTimeline: (id: string, recipe: string, clips: Array<Record<string, string>>) => call<{ clips: string[]; timeline: Timeline }>("POST", `/timelines/${id}/plan`, { recipe, clips }),
  deleteDraft: (id: string) => call<{ ok: true }>("DELETE", `/drafts/${id}`),
  modelSettings: (o?: Asked) => call<{ items: ModelSettings[] }>("GET", "/model-settings", undefined, o?.signal),
  saveModelSettings: (body: ModelSettings) => call<ModelSettings>("PUT", "/model-settings", body),
  forgetModelSettings: (family: string, file: string) => call<{ ok: true }>("DELETE", `/model-settings?${new URLSearchParams({ family, file })}`),
  /** What the files of one model folder say about themselves; `pending` are still being read. */
  modelInfo: (folder: string, o?: Asked) => call<{ items: Record<string, ModelInfo>; pending: number }>("GET", `/models/${folder}/info`, undefined, o?.signal),
  folders: (o?: Asked) => call<{ items: Folder[] }>("GET", "/folders", undefined, o?.signal),
  /** A folder inside another, or at the top of a project (null: the Inbox). */
  createFolder: (name: string, parentId: string | null, project?: string | null) => call<Folder>("POST", "/folders", { name, parentId, ...(parentId ? {} : { project: project ?? null }) }),
  /** Link a directory of the disk the server runs on: it becomes a folder, read where it is. */
  /** `project`: the project it goes to the top of (null: the Inbox); left out, the Inbox too. `files`: what it holds, sub-folders included. */
  linkFolder: (path: string, name?: string, project?: string | null) => call<Folder & { files?: number }>("POST", "/folders/link", { path, ...(name ? { name } : {}), ...(project !== undefined ? { project } : {}) }),
  /** Read a linked folder's directory again. */
  relinkFolder: (id: string, path: string) => call<{ id: string; name: string; path: string }>("POST", `/folders/${id}/relink`, { path }),
  scanFolder: (id: string) => call<{ files: number; folders: number }>("POST", `/folders/${id}/scan`, {}),
  editFolder: (id: string, patch: { name?: string; parentId?: string | null; project?: string | null }) => call<{ ok: true }>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => call<{ ok: true }>("DELETE", `/folders/${id}`),
  moveAssets: (ids: string[], folderId: string | null) => call<{ moved: number }>("POST", "/assets/move", { ids, folderId }),
  renameAsset: (id: string, name: string) => call<Asset>("PATCH", `/assets/${id}`, { name }),
  /** A picture, a video or a sound from this computer, into the library. The file is the request body. */
  upload: async (file: File, opts: { /** The painted part of a picture: kept, but not shown in the library. */ mask?: boolean; /** A picture for a person or a place of the Prompt kit: kept with them, not shown in the library. */ kit?: boolean; /** The folder it goes into. */ folder?: string; /** Without a folder: the project whose root folder it goes into. */ project?: string | null } = {}) => {
    if (!/^(image|video|audio)\//.test(file.type)) throw new ApiError("This file is not a picture, a video or a sound.");
    const res = await send(`/api/assets?name=${encodeURIComponent(file.name)}${opts.mask ? "&as=mask" : opts.kit ? "&as=kit" : ""}${opts.folder ? `&folder=${encodeURIComponent(opts.folder)}` : ""}${opts.project ? `&project=${encodeURIComponent(opts.project)}` : ""}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const data = (await res.json().catch(() => ({}))) as Asset & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`, res.status);
    return data as Asset;
  },
  workflows: (o?: Asked) => call<{ items: WorkflowBrief[] }>("GET", "/workflows", undefined, o?.signal),
  workflow: (id: string, o?: Asked) => call<WorkflowDef>("GET", `/workflows/${id}`, undefined, o?.signal),
  /** Takes the file as it is (ComfyUI's own save, an export) or a workflow Afflatus holds; answers with it in the form Afflatus keeps. */
  inspectWorkflow: (file: unknown) => call<Inspection & { graph: WorkflowDef["graph"]; wiring?: Wiring; editor?: unknown }>("POST", "/workflows/inspect", file),
  /** Put the workflow in ComfyUI's own workflows folder; where ComfyUI is, and the file's path there. */
  openWorkflow: (id: string) => call<Opened>("POST", `/workflows/${id}/open`),
  /** Show a result's graph in ComfyUI's editor: built again from its generation parameters. */
  openRender: (assetId: string) => call<Opened>("POST", `/assets/${assetId}/open`),
  createWorkflow: (body: WorkflowBody) => call<WorkflowBrief>("POST", "/workflows", body),
  saveWorkflow: (id: string, body: WorkflowBody) => call<WorkflowBrief>("PUT", `/workflows/${id}`, body),
  /** Have ComfyUI-Manager install the packs the missing node types come from; `packs` is what the workflow says about them. */
  installPacks: (body: { classes: string[]; packs: Record<string, string> }) => call<PacksStarted>("POST", "/workflows/packs", body),
  /** Have ComfyUI-Manager restart ComfyUI (after a pack install); refused while a render runs. */
  restartComfy: (machine?: string) => call<{ ok: true }>("POST", "/comfy/restart", machine ? { machine } : {}),
  /** Where the queued installs stand. */
  packsStatus: (ids: string[]) => call<{ items: PackState[]; installed: number }>("GET", `/workflows/packs?ids=${encodeURIComponent(ids.join(","))}`),
  deleteWorkflow: (id: string) => call<{ ok: true }>("DELETE", `/workflows/${id}`),
  /** The timelines of the project the app looks at. */
  timelines: (o?: Asked) => call<{ items: TimelineBrief[] }>("GET", `/timelines${projectParam() ? `?project=${encodeURIComponent(projectParam()!)}` : ""}`, undefined, o?.signal),
  timeline: (id: string, o?: Asked) => call<Timeline>("GET", `/timelines/${id}`, undefined, o?.signal),
  /** A new timeline, in the project the app looks at unless another is named. */
  createTimeline: (name?: string, project?: string | null) => call<Timeline>("POST", "/timelines", { ...(name ? { name } : {}), project: project === undefined ? projectForNew() : project }),
  projects: (o?: Asked) => call<{ items: Project[]; inbox: { drafts: number; timelines: number; assets: number } }>("GET", "/projects", undefined, o?.signal),
  createProject: (name: string) => call<Project>("POST", "/projects", { name }),
  editProject: (id: string, patch: { name?: string; archived?: boolean }) => call<Project>("PATCH", `/projects/${id}`, patch),
  /** The project goes; its drafts, timelines and folders go to the Inbox. */
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/projects/${id}`),
  /** Every project with its folders, timelines and sizes; with `q`, only what matches (and the drafts that do). */
  /** `kind`: the folders' and projects' counts and sizes are of that kind of item only. */
  projectsTree: (q: string, kind?: "image" | "video" | "audio" | null, o?: Asked) => {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) });
    return call<ProjectsTree>("GET", `/projects/tree${p.size ? `?${p}` : ""}`, undefined, o?.signal);
  },
  /** Its root folder: that folder of it, or (without one) a new folder named after it. */
  setProjectRoot: (id: string, folderId?: string) => call<Project>("POST", `/projects/${id}/root`, folderId ? { folderId } : {}),
  /** The drafts of one project (null: the Inbox), whatever project the app looks at: all of them, not only the recent ones. */
  draftsOf: (project: string | null, o?: Asked) => call<{ items: DraftBrief[]; unused: number }>("GET", `/drafts?project=${encodeURIComponent(project ?? "none")}&limit=1000`, undefined, o?.signal),
  /** The unused drafts of one project (null: the Inbox) deleted, but the open one. */
  clearUnusedDraftsOf: (project: string | null, keep?: string) => call<{ deleted: number }>("POST", "/drafts/clear-unused", { project: project ?? "none", keep }),
  /** A draft taken to another project (null: the Inbox); nothing else moves with it. */
  moveDraft: (id: string, project: string | null) => call<Draft>("PUT", `/drafts/${id}`, { project }),
  editTimeline: (id: string, patch: TimelinePatch) => call<Timeline>("PATCH", `/timelines/${id}`, patch),
  /** The source lane's stretch made into clips, one a window: their ids (nothing is rendered yet). */
  makeFromSource: (id: string) => call<{ clips: string[] }>("POST", `/timelines/${id}/source/make`),
  /** The source split at a moment of it (its own time): the part before, a clip playing it as it is. */
  splitSource: (id: string, atMs: number) => call<{ clip: string }>("POST", `/timelines/${id}/source/split`, { atMs: Math.round(atMs) }),
  undoTimeline: (id: string) => call<{ undone: string }>("POST", `/timelines/${id}/undo`),
  redoTimeline: (id: string) => call<{ redone: string }>("POST", `/timelines/${id}/redo`),
  /** A copy of the clip right after it, with its takes. */
  duplicateClip: (id: string) => call<{ clip: string }>("POST", `/clips/${id}/duplicate`),
  deleteTimeline: (id: string) => call<{ ok: true }>("DELETE", `/timelines/${id}`),
  /** The timeline's takes no clip plays and nothing else needs go, their videos to the bin. */
  binUnusedTakes: (id: string) => call<{ binned: number; bytes: number }>("POST", `/timelines/${id}/unused-takes/bin`),
  /** A new clip: empty, or from a video or a picture of the library. After `after`, first when null, last when left out. */
  addClip: (timeline: string, body: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip"; stopAtMs?: number }) => call<{ clip: string; timeline: Timeline }>("POST", `/timelines/${timeline}/clips`, body),
  editClip: (id: string, patch: ClipPatch) => call<{ ok: true }>("PATCH", `/clips/${id}`, patch),
  deleteClip: (id: string) => call<{ ok: true }>("DELETE", `/clips/${id}`),
  /** One clip becomes two at a moment of its take (the video's own time). */
  splitClip: (id: string, atMs: number) => call<{ clip: string }>("POST", `/clips/${id}/split`, { atMs: Math.round(atMs) }),
  /**
   * The range between In and Out on the timeline's clock: split there, remove it, regenerate it as a new
   * clip (it comes back selected, not rendered; In = Out on a cut inserts a clip between), or copy it to the
   * library through the export queue.
   */
  timelineRange: (id: string, opts: { inMs: number; outMs: number; action: "split" | "remove" | "regenerate" | "loop" | "copy" | "slow"; scale?: number; factor?: 2 | 4 }) =>
    call<{ ok: true } | { clip: string; context: RangeContext; arrive?: string; widenedMs?: number; longerMs?: number } | { job: string } | { clips: string[]; jobs: string[]; engine: "rife" | "ffmpeg" }>("POST", `/timelines/${id}/range`, { ...opts, inMs: Math.round(opts.inMs), outMs: Math.round(opts.outMs) }),
  deleteTake: (id: string) => call<{ ok: true }>("DELETE", `/takes/${id}`),
  /** The designer writes a clip put between two others: what takes the action from the one to the other. `was` is what the form held when it was asked. */
  writeBetween: (clip: string, arrive?: string) => call<{ changes: Record<string, string>; note: string; was: Record<string, string> }>("POST", `/clips/${clip}/between`, arrive ? { arrive } : undefined),
  /** `machine`: every job pinned to that ComfyUI (a Machine's id); left out, whichever would end each first. */
  renderClips: (timeline: string, clips: Array<{ id: string; input: Record<string, unknown>; fit?: boolean; takes?: number; seedMode?: "up" | "down" }>, machine?: string) =>
    call<{ ids: string[] }>("POST", `/timelines/${timeline}/render`, { clips, ...(machine ? { machine } : {}) }),
  /** Asks for the export: it runs in the queue, and the timeline says when it is there. */
  exportTimeline: (id: string, opts: { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend?: boolean; match?: boolean; fit?: "timeline" | "largest"; webMb?: 10 | 25 }) => call<{ id: string }>("POST", `/timelines/${id}/export`, opts),
  /** Every clip's selected take brought to its final quality by an upscale route, as a new take each; the drafts stay. */
  finishTimeline: (id: string, opts: Partial<FinishSettings> & { route: FinishSettings["route"]; factor: number; redo?: boolean; clips?: string[] }) => call<{ jobs: string[]; skipped: Array<{ clip: number; why: string }> }>("POST", `/timelines/${id}/finish`, opts),
  /** What finishTimeline with these settings would take in all; null while one of its jobs has nothing learned yet. */
  finishForecast: (id: string, opts: Partial<FinishSettings> & { route: FinishSettings["route"]; factor: number; redo?: boolean; clips?: string[] }) => call<{ ms: number | null }>("POST", `/timelines/${id}/finish/forecast`, opts),
  /** One frame of a video, saved as a picture in the library. */
  frame: (video: string, atMs: number, timeline?: string) => call<Asset>("POST", `/assets/${video}/frame`, { atMs, ...(timeline ? { timeline } : {}) }),
  mirror: (picture: string, axis: "horizontal" | "vertical") => call<Asset>("POST", `/assets/${picture}/mirror`, { axis }),
  /** A range of a video as new videos, in the queue: copied, split out, or removed. */
  /** A range of a video: copied, split out, removed, or slowed down ("slow", ×2 or ×4: RIFE on the GPU when ComfyUI has it, else ffmpeg; `engine` says which). */
  range: (video: string, opts: { startMs: number; endMs: number; action: "copy" | "split" | "remove" | "slow"; crf?: number; factor?: 2 | 4; even?: boolean }) => call<{ id: string; engine?: "rife" | "ffmpeg" }>("POST", `/assets/${video}/range`, opts),
  /** How much moves along a video and how loud it is, `rate` samples a second (motion 0 = still; sound in dB, about -60 = silence): the curves on the track, the quiet moments and pauses a range snaps to. */
  /** Where a video cuts between shots, as moments in milliseconds (ffmpeg's scene change; one shot gives none). */
  scenes: (asset: string) => call<{ cuts: number[] }>("GET", `/assets/${asset}/scenes`),
  motion: (asset: string) => call<{ rate: number; values: number[]; sound: number[] | null; speech: number[] | null }>("GET", `/assets/${asset}/motion`),
  /** The music ducked under speech: its gain along the timeline, as the export applies it (null: no music, or not ducked). */
  duck: (timeline: string) => call<{ curve: { rate: number; gains: number[] } | null }>("GET", `/timelines/${timeline}/duck`),
  /** How smoothly each take of a clip meets its neighbours: ×1 = like the clip's own motion, higher = a catch; null where there is no neighbour. */
  joins: (clip: string) => call<{ items: Array<{ take: string; in: number | null; out: number | null }> }>("GET", `/clips/${clip}/joins`),
  /** The motion of several videos and sounds, and the joins of several clips, in one request each (null: not measured): the timeline editor's, through timeline/measures.ts. */
  motions: (ids: string[]) => call<{ items: Record<string, { rate: number; values: number[]; sound: number[] | null; speech: number[] | null } | null> }>("POST", "/measures/motion", { ids }),
  joinsOf: (ids: string[]) => call<{ items: Record<string, Array<{ take: string; in: number | null; out: number | null }> | null> }>("POST", "/measures/joins", { ids }),
  /** The colour nudge each clip gets in the player (luma and chroma steps of 255), the same the export applies at the joins. */
  matches: (timeline: string) => call<{ items: Array<{ clip: string; y: number; u: number; v: number }> }>("GET", `/timelines/${timeline}/match`),
};

export const fileUrl = (id: string) => `/api/assets/${id}/file`;
/** A timeline for a video editor, as a zip to download: its clips' files, the music as heard, and the project files. */
export const projectUrl = (timeline: string, o: { music: boolean; range?: { inMs: number; outMs: number } }) =>
  `/api/timelines/${timeline}/project.zip?music=${o.music ? 1 : 0}${o.range ? `&in=${Math.round(o.range.inMs)}&out=${Math.round(o.range.outMs)}` : ""}`;
export const thumbUrl = (id: string) => `/api/assets/${id}/thumb`;
/**
 * The thumbnail's two sizes for a srcset, of a thumbUrl: the 256 px one for a tile that small on a screen of one pixel
 * per point, the 512 px one for a larger tile or a denser screen. Undefined for any other address (a picture itself).
 */
export function thumbSrcSet(src: string): string | undefined {
  return /^\/api\/assets\/[^/?]+\/thumb$/.test(src) ? `${src}?w=256 256w, ${src} 512w` : undefined;
}
/**
 * The width a tile's thumbnail is picked for: the width it is laid out at ("auto", for a picture loaded lazily, in a
 * browser that knows it), else 320 px, the widest tile, so that a browser without it gets the 512 px one as before.
 */
export const THUMB_SIZES = "auto, 320px";
/** Twelve frames of a video side by side, spread over its length. */
export const stripUrl = (id: string) => `/api/assets/${id}/strip`;
export const STRIP_FRAMES = 12;
export const previewUrl = (jobId: string, seq: number) => `/api/jobs/${jobId}/preview?s=${seq}`;
/** One picture the running job showed on the way: stage n of its strip. */
export const stageUrl = (jobId: string, n: number) => `/api/jobs/${jobId}/stage/${n}`;
