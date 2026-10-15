import type { QueryKey } from "@tanstack/react-query";
import type { Clip, Timeline } from "./api";

/**
 * Every query key of the page, in one place. A key is a path: invalidating a key reads again every query whose key
 * starts with it, so what sits under what is what a change reads again ("timelines" holds the list and each timeline; an
 * item's details are under "assets", so a "library" event reads them too). The test (queryKeys.test.ts) holds each key
 * to the array it is, so that a change of one here is seen as a change of what refetches.
 */
export const queryKeys = {
  recipes: () => ["recipes"] as const,
  /** What ComfyUI can do: every machine together, or one machine's (under it, so a "setup" event reads both again). */
  setup: (machine?: string) => (machine ? (["setup", machine] as const) : (["setup"] as const)),
  /** The queue alone: the history is not under it (see history). */
  queue: () => ["queue"] as const,
  settings: () => ["settings"] as const,
  health: () => ["health"] as const,
  /** Whether a password is set and this browser is in (the gate, Access.tsx), and the devices signed in (Settings › Access). */
  session: () => ["session"] as const,
  signedDevices: () => ["session", "devices"] as const,
  /** Afflatus's own updates (Settings → About, the rail's dot): read again on an "updates" event that changes the phase. */
  updates: () => ["updates"] as const,
  entities: () => ["entities"] as const,
  workflows: () => ["workflows"] as const,
  /** A saved workflow opened again in the editor, read once. */
  workflowEdit: (id: string) => ["workflow-edit", id] as const,
  folders: () => ["folders"] as const,
  storage: () => ["storage"] as const,
  /** The downloads, and who would download into the first ComfyUI or the one named (under it: read again together). */
  downloads: (machine?: string) => (machine ? (["downloads", machine] as const) : (["downloads"] as const)),
  presetFiles: () => ["preset-files"] as const,
  backupPlan: () => ["backup-plan"] as const,
  /** The ComfyUI log, of the first machine or of the one named. */
  comfyLog: (machine?: string) => (machine ? (["comfy-log", machine] as const) : (["comfy-log"] as const)),
  /** Each ComfyUI asked now (Settings › ComfyUI's cards). */
  machines: () => ["machines"] as const,
  /** The user's pods on RunPod (adding one), and what the rented GPUs cost. */
  runpodPods: () => ["runpod-pods"] as const,
  rentedSpending: () => ["rented-spending"] as const,
  /** The GPUs RunPod has free now, by cloud, and the account's network volumes (Deploy a GPU). */
  runpodGpus: (cloud: string) => ["runpod-gpus", cloud] as const,
  runpodVolumes: () => ["runpod-volumes"] as const,
  /** The GPU hunt under way (read again with the queue, as its events come), and the Deploy dialog's ranking for its choices. */
  hunt: () => ["hunt"] as const,
  huntRank: (ask: unknown) => ["hunt-rank", ask] as const,
  /** What Make a volume… says first (data centers in stock, sizes, savings), by the sets weighed (null: all). */
  volumePlan: (sets: string[] | null) => ["volume-plan", sets ?? "all"] as const,
  /** What Fill from a set… says first, by volume and set. */
  fillPlan: (volume: string, set: string) => ["fill-plan", volume, set] as const,
  runpodImages: () => ["runpod-images"] as const,
  /** The Deploy dialog's Models part, by cloud (the speeds measured on it) and picked set. */
  deployModels: (cloud: string, set: string) => ["deploy-models", cloud, set] as const,
  /** How far the hashing of this PC's model files is (Settings › Models › Your models online). */
  modelHashes: () => ["model-hashes"] as const,
  /** Find models: the filters' choices, a search's pages, a repository's files. */
  browse: {
    bases: () => ["browse", "bases"] as const,
    civitai: (q: object) => ["browse", "civitai", q] as const,
    huggingFace: (q: object) => ["browse", "huggingface", q] as const,
    repo: (repo: string) => ["browse", "repo", repo] as const,
  },
  /** The Model sets, a set's files, and what can be added to one. */
  modelSets: {
    all: () => ["model-sets"] as const,
    files: (id: string) => ["model-sets", id, "files"] as const,
    search: (q: string) => ["model-sets-search", q] as const,
  },
  nodePack: (comfyDir: string | undefined) => ["node-pack", comfyDir] as const,
  packs: {
    all: () => ["packs"] as const,
    status: (ids: readonly string[]) => ["packs", ids] as const,
  },
  /**
   * The queue's history, a page at a time. Not under "queue": every queue event would read each loaded page again.
   */
  history: {
    all: () => ["history"] as const,
    list: <F>(filter: F) => ["history", filter] as const,
  },
  /** The list's key and each timeline's start with "timelines": both are read again on a "timeline" event. */
  timelines: {
    all: () => ["timelines"] as const,
    lists: () => ["timelines", "list"] as const,
    list: (project: string) => ["timelines", "list", project] as const,
    one: (id: string | undefined) => ["timelines", id] as const,
  },
  /** Each draft is ["drafts", id]; the lists, whatever project they are for, are under ["drafts", "list"]. */
  drafts: {
    all: () => ["drafts"] as const,
    lists: () => ["drafts", "list"] as const,
    list: (project: string) => ["drafts", "list", project] as const,
    /** The Projects panel's drafts of one group: under the lists, so a change of the drafts reads them too. */
    tree: (group: string) => ["drafts", "list", "tree", group] as const,
    one: (id: string | null | undefined) => ["drafts", id] as const,
  },
  /** The Projects panel's tree is under "projects": what reads the projects again reads it too. */
  projects: {
    all: () => ["projects"] as const,
    trees: () => ["projects", "tree"] as const,
    tree: (q: string, kind: string | null) => ["projects", "tree", q, kind] as const,
  },
  /**
   * The library: its lists, the Projects panel's items of an open folder, each item's details and the count of the
   * expiring, all under "assets". Where each part sits is read back by libraryReads and assetCache.ts (assetsPart).
   */
  assets: {
    all: () => ["assets"] as const,
    lists: () => ["assets", "list"] as const,
    /** The cap in the key: a capped and an uncapped list of the same filter do not share pages. */
    list: <F>(project: string, filter: F, capped: boolean) => ["assets", "list", project, filter, capped] as const,
    tree: (folder: string | null, kind: string | null, pages: number, by: string, desc: boolean) => ["assets", "tree", folder, kind, pages, by, desc] as const,
    one: (id: string | null) => ["assets", "one", id] as const,
    unkept: (project: string) => ["assets", "unkept", "all", project] as const,
  },
  /** The models and families the library's filters offer. */
  facets: {
    all: () => ["facets"] as const,
    families: () => ["facets", "families"] as const,
    models: () => ["facets", "models"] as const,
  },
  /** The record of render times, and what is read from it. */
  renders: {
    all: () => ["renders"] as const,
    /** With several ComfyUIs, `machine` names the one the figures are of (left out: every machine). */
    summary: (range: string, machine?: string | null) => (machine ? (["renders", "summary", range, machine] as const) : (["renders", "summary", range] as const)),
    list: (model: string | null, only: string, window: string, machine?: string | null) => (machine ? (["renders", "list", model, only, window, machine] as const) : (["renders", "list", model, only, window] as const)),
    lanes: (window: string, machine?: string | null) => (machine ? (["renders", "lanes", window, machine] as const) : (["renders", "lanes", window] as const)),
    size: () => ["renders", "size"] as const,
  },
  /** The Costs tab: by its window's preset (or its own window's ends). */
  costs: {
    all: () => ["costs"] as const,
    of: (window: string) => ["costs", window] as const,
  },
  modelUpdates: () => ["model-updates"] as const,
  modelSettings: () => ["model-settings"] as const,
  modelInfo: {
    all: () => ["model-info"] as const,
    of: (folder: string | undefined) => ["model-info", folder] as const,
  },
  modelPages: (folder: string) => ["model-pages", folder] as const,
  modelWords: (folder: string) => ["model-words", folder] as const,
  /** A file's motion and loudness, measured once. */
  motion: (asset: string | null | undefined) => ["motion", asset] as const,
  scenes: (asset: string) => ["scenes", asset] as const,
  /** What a form would take, from the record of render times: under "advice", read again when a render ends. */
  advice: {
    all: () => ["advice"] as const,
    form: (recipe: string | undefined, values: string, held: string | null) => ["advice", recipe, values, held] as const,
  },
  /** A form's look and cast worked in; "compose" alone is what is read fresh each time. */
  compose: {
    all: () => ["compose"] as const,
    form: <V, N>(recipe: string | undefined, values: V, now: N) => ["compose", recipe, values, now] as const,
    pictures: <C, O>(recipe: string, cast: C, own: O) => ["compose", "pictures", recipe, cast, own] as const,
  },
  designerSystem: (key: string) => ["designer-system", key] as const,
  designerKnows: (recipe: string, media: string) => ["designer-knows", recipe, media] as const,
  designerGuides: () => ["designer-guides"] as const,
  /** What ComfyUI holds of what a form would load. */
  loaded: (asked: string, jobs: string) => ["loaded", asked, jobs] as const,
  /** The command bar's index; its search of the library's items is under the same key. */
  commandIndex: {
    all: () => ["command-index"] as const,
    items: (q: string) => ["command-index", "items", q] as const,
  },
  barEstimate: <E>(of: E) => ["bar-estimate", of] as const,
  promptHistory: {
    all: () => ["prompt-history"] as const,
    search: (q: string) => ["prompt-history", q] as const,
  },
  timelineEstimate: (id: string, toRender: number | undefined, updatedAt: string) => ["timeline-estimate", id, toRender, updatedAt] as const,
  finishForecast: {
    all: () => ["finishForecast"] as const,
    of: <V>(timeline: string, v: V, redo: boolean, takes: string) => ["finishForecast", timeline, v, redo, takes] as const,
  },
  forecasts: <A>(asked: A) => ["forecasts", asked] as const,
  /**
   * How a clip's takes meet the clips around it. Two readings share the ["joins", clip] start: every take of the clip
   * against its neighbours (the inspector, the clip's figures), and the take it plays (Needs attention).
   */
  joins: {
    around: (clip: Pick<Clip, "id" | "takes">, before: Pick<Clip, "take" | "still"> | undefined, after: Pick<Clip, "take" | "still"> | undefined) =>
      ["joins", clip.id, clip.takes.map((t) => `${t.id}:${t.startMs}:${t.endMs}`).join(","), before?.take?.id ?? before?.still?.id ?? "-", after?.take?.id ?? after?.still?.id ?? "-"] as const,
    ofTake: (clip: string, take: string, startMs: number, endMs: number) => ["joins", clip, take, startMs, endMs] as const,
  },
  /** Each clip's colour nudge toward the clip before: asked again when what plays changes. */
  match: (timeline: string | undefined, clips: Pick<Clip, "take" | "still">[]) =>
    ["match", timeline, clips.map((c) => `${c.take?.id ?? c.still?.id ?? "-"}:${c.take?.startMs ?? 0}:${c.take?.endMs ?? 0}`).join(",")] as const,
  /** The music ducked under speech: asked again when what plays or the music changes. */
  duck: (timeline: string | undefined, music: Timeline["music"] | undefined, clips: Pick<Clip, "id" | "take" | "atMs" | "lengthMs" | "volume" | "sound" | "music">[]) =>
    ["duck", timeline, music?.asset.id, music?.duck, music?.duckDb, music?.startClip, clips.map((c) => `${c.id}:${c.take?.id}:${c.atMs}:${c.lengthMs}:${c.volume}:${c.sound}:${c.music?.duck ?? ""}`).join(",")] as const,
};

/** Whether a key is under another (starts with it), as invalidating the other would find it. */
export const isUnder = (key: QueryKey, prefix: QueryKey): boolean => prefix.every((part, i) => key[i] === part);

/** Whether a key is one of the library's of this part ("list", "tree", "one", "unkept"): see queryKeys.assets. */
export const isAssets = (key: QueryKey, part: "list" | "tree" | "one" | "unkept"): boolean => key[0] === "assets" && key[1] === part;

/**
 * What a "library" event reads again besides the lists and the items under "assets": the folders (their
 * counts), the disk use, the projects (their counts, sizes and tree), and the models and families the library's filters offer. Each has a key of its
 * own, so that a change to one item does not read them all again through the "assets" prefix.
 */
export const LIBRARY_KEYS = [queryKeys.assets.all(), queryKeys.folders(), queryKeys.storage(), queryKeys.projects.all(), queryKeys.facets.all()] as const;
/** What a render that ended changes: the record of render times, and what a form and the Finish dialog forecast from it (live.ts). */
export const RENDER_KEYS = [queryKeys.renders.all(), queryKeys.advice.all(), queryKeys.finishForecast.all()] as const;

/**
 * A change to items of the library made on screen before the server says it is done (keep, unkeep, bin, put back,
 * move, rename): every copy the screens read is changed at once (the library's lists, the Projects panel's folder
 * lists, the item itself, the expiring count of the status bar, the folders' counts), and what each copy was is kept,
 * so that a refusal puts every one back as it was. Applied by assetCache.ts; the hook that sends the change and says
 * what happened is assetChange.tsx. Here, beside the keys, because a change a "library" event says in full is one too
 * (libraryInPlace), and assetCache.ts reads the keys.
 */
export type AssetChange =
  | { kind: "keep"; ids: string[]; kept: boolean }
  | { kind: "bin"; ids: string[] }
  | { kind: "restore"; ids: string[] }
  | { kind: "move"; ids: string[]; folder: string | null }
  | { kind: "rename"; ids: string[]; name: string };

/**
 * What a "library" event says changed, when its sender knows (the server's LibraryChange, events.ts, says what each is);
 * nothing said, or a change this page does not know (a newer server): anything may have.
 */
export interface LibraryChange {
  change?: "fields" | "kept" | "places" | "added" | "moved" | "binned" | "erased";
  items?: string[];
  folders?: Array<string | null>;
  kept?: boolean;
  name?: string;
}
const CHANGES = new Set(["fields", "kept", "places", "added", "moved", "binned", "erased"]);
const LIBRARY_ROOTS = new Set<unknown>(LIBRARY_KEYS.map((k) => k[0]));

/**
 * The part of a change the event says in full, written into what the page holds rather than read again: a rename with its
 * name, kept or not with which. An empty name is not: the name shown then is the server's to work out.
 */
export function libraryInPlace(c: LibraryChange | null | undefined): AssetChange | null {
  if (!c?.items?.length) return null;
  if (c.change === "fields" && c.name) return { kind: "rename", ids: c.items, name: c.name };
  if (c.change === "kept" && typeof c.kept === "boolean") return { kind: "keep", ids: c.items, kept: c.kept };
  return null;
}

/** Whether one change can touch what is under this key. The places read here are the ones queryKeys.assets puts them in. */
function touches(c: LibraryChange | null | undefined, key: QueryKey): boolean {
  const [root, part] = key;
  if (!c?.change || !CHANGES.has(c.change)) return LIBRARY_ROOTS.has(root);
  const assets = root === "assets";
  const inFolders = (f: unknown) => !c.folders || c.folders.includes(f as string | null);
  // a list of one folder ("none": of no folder) only when the change touched that folder; the others whatever it touched
  const filter = (assets && part === "list" ? (key[3] as { folder?: string; q?: string; kept?: boolean; unkept?: boolean; bin?: boolean } | undefined) : undefined) ?? {};
  const list = assets && part === "list" && (!filter.folder || inFolders(filter.folder === "none" ? null : filter.folder));
  // the Projects panel's items of one open folder (its id third)
  const tree = assets && part === "tree" && inFolders(key[2]);
  const one = assets && part === "one" && (!c.items || c.items.includes(key[2] as string));
  const unkept = assets && part === "unkept";
  // the folders' counts are of what is in a folder: a change to items in none leaves them
  const counts = root === "folders" && (!c.folders || c.folders.some((f) => f !== null));
  const storage = root === "storage";
  const projects = root === "projects";
  const facets = root === "facets";
  switch (c.change) {
    case "fields":
      // written in place: only what is found or ordered by the name can change (a search, the panel sorted by name)
      return libraryInPlace(c) ? (list && Boolean(filter.q)) || (tree && key[5] === "name") : list || tree || one;
    case "kept":
      // written in place: what comes into or leaves a list of the kept or the unkept, the expiring count, the disk use's split
      return (libraryInPlace(c) ? list && Boolean(filter.kept || filter.unkept) : list || tree || one) || unkept || storage;
    case "places": return root === "folders" || projects;
    case "added": return list || tree || unkept || counts || storage || projects || facets;
    // a move changes no size; filing in a folder keeps what was not (`kept` left out: it may have)
    case "moved": return list || tree || one || unkept || counts || projects || (c.kept !== false && storage);
    case "binned": return list || tree || one || unkept || counts || storage || projects || facets;
    // out of the bin for good: it was in no count but the bin's and the disk use
    case "erased": return (list && Boolean(filter.bin)) || one || storage;
  }
  return false;
}

/**
 * What the "library" events gathered until a read touch: whether the queries under a key are read again. Only what each
 * change can touch: a rename reads no folder counts, a render no item's details, a move no disk use. An event with
 * nothing said reads every list (LIBRARY_KEYS), as one from an older server does.
 */
export const libraryReads = (changes: ReadonlyArray<LibraryChange | null | undefined>) => (key: QueryKey): boolean => changes.some((c) => touches(c, key));
