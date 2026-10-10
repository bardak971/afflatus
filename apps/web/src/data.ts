import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { api, type HistoryPage, type Timeline, type TimesPeriod, type TimesWindow } from "./api";
import type { AssetChange } from "./assetCache";
import { withFreshHead } from "./screens/queue/historyHead";
import { useProject } from "./project";

/**
 * The queries the screens share. Live events (live.ts) decide when they refetch. The lists that follow
 * the project switcher (library, drafts, timelines) carry the project in their key, so a switch is a
 * new query rather than a refetch of the old one.
 */

export const useRecipes = () => useQuery({ queryKey: ["recipes"], queryFn: api.recipes, staleTime: Infinity });
export const useSetup = () => useQuery({ queryKey: ["setup"], queryFn: api.setup, staleTime: 60_000 });
export const useQueue = () => useQuery({ queryKey: ["queue"], queryFn: api.queue });
/**
 * The queue's history, a page at a time. Not under "queue": every queue event would read each loaded page
 * again. Its first page is read again when a job ends (live.ts, readHistoryHead), and every page after a change made to it here.
 */
export const HISTORY = ["history"] as const;
type JobsFilter = { status?: "done" | "failed" | "cancelled"; q?: string; model?: string };
const HISTORY_PAGE = 60;
export function useJobs(filter: JobsFilter) {
  return useInfiniteQuery({
    queryKey: [...HISTORY, filter],
    // by the cursor the page before ends on, not by a count: jobs that end meanwhile (put in front by readHistoryHead) or
    // that are dismissed do not move the pages after, so none is skipped or read twice
    queryFn: ({ pageParam, signal }) => api.jobs({ ...filter, after: pageParam ?? undefined, limit: HISTORY_PAGE }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.more && last.next ? last.next : undefined),
    placeholderData: keepPreviousData,
  });
}
/**
 * The history after a job ended: a list on screen reads its first page only, and the jobs that ended are put in front
 * of it (historyHead.ts); read again in full, a list scrolled far down read its forty pages one after another, seconds
 * of reads at each end of a render. A list not on screen is only marked old (read again when it is shown).
 */
export async function readHistoryHead(client: QueryClient): Promise<void> {
  for (const q of client.getQueryCache().findAll({ queryKey: HISTORY })) {
    const key = q.queryKey as [string, JobsFilter];
    const was = q.state.data as InfiniteData<HistoryPage, string | null> | undefined;
    if (!q.isActive() || !was || was.pages.length < 2) {
      void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
      continue;
    }
    try {
      const head = await api.jobs({ ...key[1], limit: HISTORY_PAGE });
      const now = client.getQueryData<InfiniteData<HistoryPage, string | null>>(key);
      const pages = now && withFreshHead(now.pages, head);
      if (now && pages) client.setQueryData<InfiniteData<HistoryPage, string | null>>(key, { pages, pageParams: now.pageParams });
      else void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
    } catch {
      void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
    }
  }
}
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings });

/**
 * Which model families are offered where something is chosen (the model list, a clip's model, the
 * tools under a picture). A family is on when its switch in Settings says so; left alone it follows its
 * files: on when ComfyUI has what one of its recipes needs, off when it does not. While ComfyUI has not
 * answered, everything is on. Off never hides what already uses a family: only the lists to pick from.
 */
export function useFamilies() {
  const recipes = useRecipes();
  const setup = useSetup();
  const settings = useSettings();
  return useMemo(() => {
    const said = settings.data?.families ?? {};
    const status = setup.data?.recipes;
    /** Its files (and nodes) are there for at least one of its recipes. */
    const found = (family: string) => !status || (recipes.data?.recipes ?? []).some((r) => r.family === family && status.find((s) => s.id === r.id)?.ready);
    const isOn = (family: string) => said[family] ?? found(family);
    return { isOn, found, said };
  }, [recipes.data, setup.data, settings.data]);
}

/** The timelines of the project the app looks at. Its key starts with "timelines", like each timeline's, so both refetch on a "timeline" event. */
export const useTimelines = () => {
  const project = useProject((s) => s.id);
  return useQuery({ queryKey: ["timelines", "list", project], queryFn: api.timelines });
};
/** The key of the drafts list, whatever project it is for: what to invalidate when a draft is made, saved or deleted (each draft is ["drafts", id]). */
export const DRAFT_LIST = ["drafts", "list"] as const;
export const useDrafts = (enabled = true) => {
  const project = useProject((s) => s.id);
  return useQuery({ queryKey: [...DRAFT_LIST, project], queryFn: api.drafts, enabled });
};
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: api.projects });
/** The Projects panel's tree, searched by `q` (empty: all of it), counted for one kind of item or all. Under "projects": what reads the projects again reads it too. */
export const useProjectsTree = (q: string, kind: "image" | "video" | "audio" | null = null) =>
  useQuery({ queryKey: ["projects", "tree", q, kind], queryFn: ({ signal }) => api.projectsTree(q, kind, { signal }), placeholderData: keepPreviousData });
/**
 * A timeline as the page reads it. A server older than the page (not restarted since an update) leaves the newer fields
 * out: they are given their defaults here, so the page shows the song from 0:00, with clip 1, and no clip's own music,
 * not NaN.
 */
const withDefaults = (t: Timeline): Timeline => ({
  ...t,
  music: t.music ? { ...t.music, fromMs: t.music.fromMs ?? 0, startClip: t.music.startClip ?? null } : t.music,
  clips: t.clips.map((c) => (c.music === undefined ? { ...c, music: null } : c)),
});
export const useTimeline = (id: string | undefined) => useQuery({ queryKey: ["timelines", id], queryFn: ({ signal }) => api.timeline(id!, { signal }), enabled: Boolean(id), select: withDefaults });
export const useEntities = () => useQuery({ queryKey: ["entities"], queryFn: api.entities });
export const useWorkflows = () => useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
// read once per file by the server, then kept: the "models" live event says when more has arrived
export const useModelUpdates = () => useQuery({ queryKey: ["model-updates"], queryFn: api.modelUpdates, staleTime: 5 * 60_000 });
export const useModelInfo = (folder: string | undefined) => useQuery({ queryKey: ["model-info", folder], queryFn: ({ signal }) => api.modelInfo(folder!, { signal }), staleTime: Infinity, enabled: Boolean(folder) });
export const useModelPages = (folder: string) => useQuery({ queryKey: ["model-pages", folder], queryFn: ({ signal }) => api.modelPages(folder, { signal }), staleTime: Infinity });
export const useModelWords = (folder: string) => useQuery({ queryKey: ["model-words", folder], queryFn: ({ signal }) => api.modelWords(folder, { signal }), staleTime: Infinity });
export const useModelSettings = () => useQuery({ queryKey: ["model-settings"], queryFn: api.modelSettings, staleTime: Infinity });
/**
 * What a "library" event reads again besides the lists and the items under "assets": the folders (their
 * counts), the disk use, the projects (their counts, sizes and tree), and the models and families the library's filters offer. Each has a key of its
 * own, so that a change to one item does not read them all again through the "assets" prefix.
 */
export const LIBRARY_KEYS = [["assets"], ["folders"], ["storage"], ["projects"], ["facets"]] as const;
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

/** Whether one change can touch what is under this key. */
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
/** What a render that ended changes: the record of render times, and what a form and the Finish dialog forecast from it (live.ts). */
export const RENDER_KEYS = [["renders"], ["advice"], ["finishForecast"]] as const;

export const useFolders = () => useQuery({ queryKey: ["folders"], queryFn: api.folders });
/**
 * The record of render times for a period: one ending now (a preset, "all") or a window of its own. A
 * preset's window is worked out when it is read, so that it still ends now when it is read again.
 */
export const useRenderTimes = (range: { preset: string; ms: number | null } | TimesPeriod | TimesWindow) =>
  useQuery({
    queryKey: ["renders", "summary", typeof range === "string" ? range : "preset" in range ? range.preset : `${Math.round(range.from)}-${Math.round(range.to)}`],
    queryFn: ({ signal }) => api.renderTimes(windowOf(range), { signal }),
    placeholderData: keepPreviousData,
  });
/** What to ask the server for: a preset's window ends now, at the moment it is asked. */
export function windowOf(range: { preset: string; ms: number | null } | TimesPeriod | TimesWindow, now = Date.now()): TimesPeriod | TimesWindow {
  if (typeof range === "string" || !("preset" in range)) return range;
  return range.ms === null ? "all" : { from: now - range.ms, to: now };
}
export const useStorage = () => useQuery({ queryKey: ["storage"], queryFn: api.storage });
export const useAssetFamilies = () => useQuery({ queryKey: ["facets", "families"], queryFn: api.assetFamilies });
export const useAssetModels = () => useQuery({ queryKey: ["facets", "models"], queryFn: api.assetModels });

/** How many pages of the library a capped list holds: past that, the pages at the far end are let go (and read again on the way back). */
const LIBRARY_PAGES = 8;
/** Where a page of the library starts: below `after`, above `before`, or at the top. */
export type AssetsPageParam = { after?: string; before?: string };

/**
 * A list of the library, a page at a time. `capped`: it holds LIBRARY_PAGES pages at most, so a library
 * change reads those again rather than every page scrolled through; the list then pages both ways and
 * shows the pages above again (fetchPreviousPage) when scrolled back up. Uncapped for a list with no way up.
 */
export function useAssets(filter: { kind?: string; bin?: boolean; folder?: string; q?: string; family?: string; kept?: boolean; unkept?: boolean; model?: string; lora?: string; draft?: string; since?: string; all?: boolean }, enabled = true, capped = false) {
  const project = useProject((s) => s.id);
  return useInfiniteQuery({
    // the cap in the key: a capped and an uncapped list of the same filter do not share pages
    queryKey: ["assets", "list", project, filter, capped],
    queryFn: ({ pageParam, signal }) => api.assets({ ...filter, ...pageParam }, { signal }),
    initialPageParam: {} as AssetsPageParam,
    getNextPageParam: (last): AssetsPageParam | undefined => (last.next ? { after: last.next } : undefined),
    getPreviousPageParam: (first): AssetsPageParam | undefined => (first.prev ? { before: first.prev } : undefined),
    maxPages: capped ? LIBRARY_PAGES : undefined,
    enabled,
  });
}

/** One item with its generation. Its key is under "assets": a "library" event reads it again. */
export const assetKey = (id: string | null) => ["assets", "one", id] as const;
export const useAsset = (id: string | null) => useQuery({ queryKey: assetKey(id), queryFn: ({ signal }) => api.asset(id!, { signal }), enabled: Boolean(id) });
