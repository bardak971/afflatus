import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TimesPeriod, type TimesWindow } from "./api";

/** The queries the screens share. Live events (live.ts) decide when they refetch. */

export const useRecipes = () => useQuery({ queryKey: ["recipes"], queryFn: api.recipes, staleTime: Infinity });
export const useSetup = () => useQuery({ queryKey: ["setup"], queryFn: () => api.setup(), staleTime: 60_000 });
export const useQueue = () => useQuery({ queryKey: ["queue"], queryFn: api.queue });
/** The queue's history, a page at a time; it follows the queue's live events. */
export function useJobs(filter: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string }) {
  return useInfiniteQuery({
    queryKey: ["queue", "history", filter],
    queryFn: ({ pageParam }) => api.jobs({ ...filter, offset: pageParam, limit: 60 }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.more ? pages.reduce((n, p) => n + p.items.length, 0) : undefined),
    placeholderData: keepPreviousData,
  });
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

export const useTimelines = () => useQuery({ queryKey: ["timelines"], queryFn: api.timelines });
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: api.projects });
export const useTimeline = (id: string | undefined) => useQuery({ queryKey: ["timelines", id], queryFn: () => api.timeline(id!), enabled: Boolean(id) });
export const useEntities = () => useQuery({ queryKey: ["entities"], queryFn: api.entities });
export const useWorkflows = () => useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
// read once per file by the server, then kept: the "models" live event says when more has arrived
export const useModelUpdates = () => useQuery({ queryKey: ["model-updates"], queryFn: api.modelUpdates, staleTime: 5 * 60_000 });
export const useModelInfo = (folder: string | undefined) => useQuery({ queryKey: ["model-info", folder], queryFn: () => api.modelInfo(folder!), staleTime: Infinity, enabled: Boolean(folder) });
export const useModelPages = (folder: string) => useQuery({ queryKey: ["model-pages", folder], queryFn: () => api.modelPages(folder), staleTime: Infinity });
export const useModelWords = (folder: string) => useQuery({ queryKey: ["model-words", folder], queryFn: () => api.modelWords(folder), staleTime: Infinity });
export const useModelSettings = () => useQuery({ queryKey: ["model-settings"], queryFn: api.modelSettings, staleTime: Infinity });
// folders change with the library (counts), so they are refetched with it: the key starts with "assets"
export const useFolders = () => useQuery({ queryKey: ["assets", "folders"], queryFn: api.folders });

// these follow the library: their keys start with "assets" so that they are refetched with it
export const useEstimates = () => useQuery({ queryKey: ["assets", "estimates"], queryFn: api.estimates, staleTime: 60_000 });
/** The record of render times for a period. Read again when a render ends (the library changes then). */
export const useRenderTimes = (range: TimesPeriod | TimesWindow) => useQuery({ queryKey: ["assets", "render-times", typeof range === "string" ? range : `${Math.round(range.from)}-${Math.round(range.to)}`], queryFn: () => api.renderTimes(range), placeholderData: keepPreviousData });
export const useStorage = () => useQuery({ queryKey: ["assets", "storage"], queryFn: api.storage });
export const useAssetFamilies = () => useQuery({ queryKey: ["assets", "families"], queryFn: api.assetFamilies });
export const useAssetModels = () => useQuery({ queryKey: ["assets", "models"], queryFn: api.assetModels });

export function useAssets(filter: { kind?: string; bin?: boolean; folder?: string; q?: string; family?: string; kept?: boolean; model?: string; lora?: string; draft?: string; since?: string; all?: boolean }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["assets", filter],
    queryFn: ({ pageParam }) => api.assets({ ...filter, after: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
    enabled,
  });
}

export const useAsset = (id: string | null) => useQuery({ queryKey: ["assets", "one", id], queryFn: () => api.asset(id!), enabled: Boolean(id) });

/** A change to one item: the lists and the item are refetched once it is done. */
export function useAssetAction<T>(action: (arg: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: action, onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }) });
}
