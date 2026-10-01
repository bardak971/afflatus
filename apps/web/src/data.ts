import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** The queries the screens share. Live events (live.ts) decide when they refetch. */

export const useRecipes = () => useQuery({ queryKey: ["recipes"], queryFn: api.recipes, staleTime: Infinity });
export const useSetup = () => useQuery({ queryKey: ["setup"], queryFn: () => api.setup(), staleTime: 60_000 });
export const useQueue = () => useQuery({ queryKey: ["queue"], queryFn: api.queue });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings });

export const useTimelines = () => useQuery({ queryKey: ["timelines"], queryFn: api.timelines });
export const useTimeline = (id: string | undefined) => useQuery({ queryKey: ["timelines", id], queryFn: () => api.timeline(id!), enabled: Boolean(id) });
export const useEntities = () => useQuery({ queryKey: ["entities"], queryFn: api.entities });
export const useWorkflows = () => useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
// read once per file by the server, then kept: the "models" live event says when more has arrived
export const useModelInfo = (folder: string | undefined) => useQuery({ queryKey: ["model-info", folder], queryFn: () => api.modelInfo(folder!), staleTime: Infinity, enabled: Boolean(folder) });
export const useModelPages = (folder: string) => useQuery({ queryKey: ["model-pages", folder], queryFn: () => api.modelPages(folder), staleTime: Infinity });
export const useModelSettings = () => useQuery({ queryKey: ["model-settings"], queryFn: api.modelSettings, staleTime: Infinity });
// folders change with the library (counts), so they are refetched with it: the key starts with "assets"
export const useFolders = () => useQuery({ queryKey: ["assets", "folders"], queryFn: api.folders });

// these follow the library: their keys start with "assets" so that they are refetched with it
export const useEstimates = () => useQuery({ queryKey: ["assets", "estimates"], queryFn: api.estimates, staleTime: 60_000 });
export const useStorage = () => useQuery({ queryKey: ["assets", "storage"], queryFn: api.storage });
export const useAssetFamilies = () => useQuery({ queryKey: ["assets", "families"], queryFn: api.assetFamilies });

export function useAssets(filter: { kind?: string; bin?: boolean; folder?: string; q?: string; family?: string; kept?: boolean }) {
  return useInfiniteQuery({
    queryKey: ["assets", filter],
    queryFn: ({ pageParam }) => api.assets({ ...filter, after: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export const useAsset = (id: string | null) => useQuery({ queryKey: ["assets", "one", id], queryFn: () => api.asset(id!), enabled: Boolean(id) });

/** A change to one item: the lists and the item are refetched once it is done. */
export function useAssetAction<T>(action: (arg: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: action, onSuccess: () => client.invalidateQueries({ queryKey: ["assets"] }) });
}
