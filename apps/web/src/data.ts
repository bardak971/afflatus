import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, type Asset, type HistoryPage, type Timeline, type TimesPeriod, type TimesWindow } from "./api";
import { mergeTop } from "./assetCache";
import { withFreshHead } from "./screens/queue/historyHead";
import { useProject } from "./project";
import { queryKeys } from "./queryKeys";

/**
 * The queries the screens share. Live events (live.ts) decide when they refetch. The lists that follow
 * the project switcher (library, drafts, timelines) carry the project in their key, so a switch is a
 * new query rather than a refetch of the old one.
 */

export const useRecipes = () => useQuery({ queryKey: queryKeys.recipes(), queryFn: api.recipes, staleTime: Infinity });
/** A model family's name by its id: the id itself while the recipes load, or for a family no longer installed. */
export function useFamilyName(): (id: string) => string {
  const families = useRecipes().data?.families;
  return useMemo(() => (id: string) => families?.find((f) => f.id === id)?.name ?? id, [families]);
}
export const useSetup = () => useQuery({ queryKey: queryKeys.setup(), queryFn: api.setup, staleTime: 60_000 });
export const useQueue = () => useQuery({ queryKey: queryKeys.queue(), queryFn: api.queue });
/**
 * The queue's history, a page at a time (queryKeys.history). Its first page is read again when a job ends (live.ts,
 * readHistoryHead), and every page after a change made to it here.
 */
type JobsFilter = { status?: "done" | "failed" | "cancelled"; q?: string; model?: string };
const HISTORY_PAGE = 60;
export function useJobs(filter: JobsFilter) {
  return useInfiniteQuery({
    queryKey: queryKeys.history.list(filter),
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
  for (const q of client.getQueryCache().findAll({ queryKey: queryKeys.history.all() })) {
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
export const useSettings = () => useQuery({ queryKey: queryKeys.settings(), queryFn: api.settings });

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
  return useQuery({ queryKey: queryKeys.timelines.list(project), queryFn: api.timelines });
};
export const useDrafts = (enabled = true) => {
  const project = useProject((s) => s.id);
  return useQuery({ queryKey: queryKeys.drafts.list(project), queryFn: api.drafts, enabled });
};
export const useProjects = () => useQuery({ queryKey: queryKeys.projects.all(), queryFn: api.projects });
/** The Projects panel's tree, searched by `q` (empty: all of it), counted for one kind of item or all. Under "projects": what reads the projects again reads it too. */
export const useProjectsTree = (q: string, kind: "image" | "video" | "audio" | null = null) =>
  useQuery({ queryKey: queryKeys.projects.tree(q, kind), queryFn: ({ signal }) => api.projectsTree(q, kind, { signal }), placeholderData: keepPreviousData });
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
export const useTimeline = (id: string | undefined) => useQuery({ queryKey: queryKeys.timelines.one(id), queryFn: ({ signal }) => api.timeline(id!, { signal }), enabled: Boolean(id), select: withDefaults });
export const useEntities = () => useQuery({ queryKey: queryKeys.entities(), queryFn: api.entities });
export const useWorkflows = () => useQuery({ queryKey: queryKeys.workflows(), queryFn: api.workflows });
// read once per file by the server, then kept: the "models" live event says when more has arrived
export const useModelUpdates = () => useQuery({ queryKey: queryKeys.modelUpdates(), queryFn: api.modelUpdates, staleTime: 5 * 60_000 });
export const useModelInfo = (folder: string | undefined) => useQuery({ queryKey: queryKeys.modelInfo.of(folder), queryFn: ({ signal }) => api.modelInfo(folder!, { signal }), staleTime: Infinity, enabled: Boolean(folder) });
export const useModelPages = (folder: string) => useQuery({ queryKey: queryKeys.modelPages(folder), queryFn: ({ signal }) => api.modelPages(folder, { signal }), staleTime: Infinity });
export const useModelWords = (folder: string) => useQuery({ queryKey: queryKeys.modelWords(folder), queryFn: ({ signal }) => api.modelWords(folder, { signal }), staleTime: Infinity });
export const useModelSettings = () => useQuery({ queryKey: queryKeys.modelSettings(), queryFn: api.modelSettings, staleTime: Infinity });

export const useFolders = () => useQuery({ queryKey: queryKeys.folders(), queryFn: api.folders });
/**
 * The record of render times for a period: one ending now (a preset, "all") or a window of its own. A
 * preset's window is worked out when it is read, so that it still ends now when it is read again.
 */
export const useRenderTimes = (range: { preset: string; ms: number | null } | TimesPeriod | TimesWindow) =>
  useQuery({
    queryKey: queryKeys.renders.summary(typeof range === "string" ? range : "preset" in range ? range.preset : `${Math.round(range.from)}-${Math.round(range.to)}`),
    queryFn: ({ signal }) => api.renderTimes(windowOf(range), { signal }),
    placeholderData: keepPreviousData,
  });
/** What to ask the server for: a preset's window ends now, at the moment it is asked. */
export function windowOf(range: { preset: string; ms: number | null } | TimesPeriod | TimesWindow, now = Date.now()): TimesPeriod | TimesWindow {
  if (typeof range === "string" || !("preset" in range)) return range;
  return range.ms === null ? "all" : { from: now - range.ms, to: now };
}
export const useStorage = () => useQuery({ queryKey: queryKeys.storage(), queryFn: api.storage });
export const useAssetFamilies = () => useQuery({ queryKey: queryKeys.facets.families(), queryFn: api.assetFamilies });
export const useAssetModels = () => useQuery({ queryKey: queryKeys.facets.models(), queryFn: api.assetModels });

/** How many pages of the library a capped list holds: past that, the pages at the far end are let go (and read again on the way back). */
const LIBRARY_PAGES = 8;
/** Where a page of the library starts: below `after`, above `before`, or at the top. */
export type AssetsPageParam = { after?: string; before?: string };

/**
 * A list of the library, a page at a time. `capped`: it holds LIBRARY_PAGES pages at most, so a library
 * change reads those again rather than every page scrolled through; the list then pages both ways and
 * shows the pages above again (fetchPreviousPage) when scrolled back up. Uncapped for a list with no way up, and for
 * the Studio's grid, which keeps every page read and draws only the rows in view (MediaGrid.tsx): scrolled back up, the
 * user finds the pages as they were, with no read and no jump.
 */
export function useAssets(filter: { kind?: string; bin?: boolean; folder?: string; q?: string; family?: string; kept?: boolean; unkept?: boolean; model?: string; lora?: string; draft?: string; since?: string; all?: boolean }, enabled = true, capped = false) {
  const project = useProject((s) => s.id);
  return useInfiniteQuery({
    queryKey: queryKeys.assets.list(project, filter, capped),
    queryFn: ({ pageParam, signal }) => api.assets({ ...filter, ...pageParam }, { signal }),
    initialPageParam: {} as AssetsPageParam,
    getNextPageParam: (last): AssetsPageParam | undefined => (last.next ? { after: last.next } : undefined),
    getPreviousPageParam: (first): AssetsPageParam | undefined => (first.prev ? { before: first.prev } : undefined),
    maxPages: capped ? LIBRARY_PAGES : undefined,
    enabled,
  });
}

/**
 * A library list after items were added (live.ts): its first page read again, the new items put above it (assetCache.ts
 * mergeTop), instead of every page loaded read again one after another. Read whole when that cannot be told from the first
 * page, when it is another project's (the page's project is the one asked for), or while it is being read anyway.
 */
export async function readLibraryTop(client: QueryClient, key: readonly unknown[]): Promise<void> {
  const whole = () => void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
  const q = client.getQueryCache().find({ queryKey: key, exact: true });
  if (!q || q.state.fetchStatus !== "idle" || key[2] !== useProject.getState().id) return whole();
  try {
    const top = await api.assets({ ...(key[3] as Parameters<typeof api.assets>[0]) });
    const now = client.getQueryData<InfiniteData<AssetsPage, AssetsPageParam>>(key);
    const merged = now && q.state.fetchStatus === "idle" ? mergeTop(now, top) : null;
    if (merged) client.setQueryData(key, merged);
    else whole();
  } catch {
    whole();
  }
}
type AssetsPage = { items: Asset[]; next: string | null; prev: string | null };

/** One item with its generation. Its key is under "assets": a "library" event reads it again. */
export const useAsset = (id: string | null) => useQuery({ queryKey: queryKeys.assets.one(id), queryFn: ({ signal }) => api.asset(id!, { signal }), enabled: Boolean(id) });
