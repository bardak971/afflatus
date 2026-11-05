import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type AssetVersions, type QueueStatus, type RunningJob } from "../api";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { allRunning, useQueueOf } from "../screens/studio/queueOf";

/** The jobs of a stack, running (each machine's) and waiting, by the root they land under. */
function versionJobs(q: QueueStatus, root: string): { running: RunningJob[]; waiting: number } {
  return { running: allRunning(q).filter((j) => j.versionOf === root), waiting: q.waiting.filter((j) => j.versionOf === root).length };
}

/**
 * A picture's versions (Inpaint, Face and Hand refine, Edit, Outpaint made in place), the original first: what the
 * strip under the picture shows, with the jobs still making more. Asked with any id of the stack, it answers the root's.
 * A server without versions (or a picture with none) answers an empty stack: nothing is shown.
 */
export function useVersions(asset: Pick<Asset, "id" | "kind" | "inBin"> | null, { onKept }: {
  /** A version kept in the original's place (K, the strip's Keep): the place showing the original shows it instead. */
  onKept?(head: Asset): void;
} = {}) {
  const id = asset && asset.kind === "image" && !asset.inBin ? asset.id : null;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.assets.versions(id ?? ""),
    queryFn: ({ signal }) => api.versions(id!, { signal }),
    enabled: Boolean(id),
    // a picture without a stack is the common case; a failure is no reason to ask again and again
    retry: false,
    staleTime: 10_000,
  });
  const stack = query.data && id && (query.data.head.id === id || query.data.versions.some((v) => v.id === id)) ? query.data : null;
  const root = stack?.head.id ?? id ?? "";
  const jobs = useQueueOf((q) => {
    const j = versionJobs(q, root);
    // the ids alone, so the strip draws again only when a job starts or ends, not at every sampler step
    return `${j.running.map((r) => r.id).join(",")}|${j.waiting}`;
  });
  // a job of the stack ended: what it made is a version now, read again
  const was = useRef(jobs);
  useEffect(() => {
    if (was.current !== undefined && jobs !== undefined && was.current !== jobs && id) void client.invalidateQueries({ queryKey: queryKeys.assets.versions(id) });
    was.current = jobs;
  }, [jobs, id, client]);
  const [running = "", waiting = "0"] = (jobs ?? "|0").split("|");

  /** The original, then each version, oldest first. */
  const all: Asset[] = stack ? [stack.head, ...stack.versions] : [];

  const failed = useSayFailed({ here: true });
  /**
   * What Keep and Keep all answer: the stack as it is now, under every id it was asked by, and the library read again. An id
   * that left the stack (Keep all made it a picture of its own) is read again rather than left answering the stack it left.
   */
  const landed = (next: AssetVersions) => {
    const ids = new Set([next.head, ...next.versions].map((a) => a.id));
    for (const a of all) if (!ids.has(a.id)) void client.resetQueries({ queryKey: queryKeys.assets.versions(a.id), exact: true });
    for (const a of [next.head, ...next.versions]) client.setQueryData(queryKeys.assets.versions(a.id), next);
    void client.invalidateQueries({ queryKey: queryKeys.assets.lists() });
  };
  const keep = useMutation({
    mutationFn: (version: string) => api.keepVersion(root, version),
    onSuccess: (next) => {
      landed(next);
      if (next.head.id !== root) onKept?.(next.head);
    },
    onError: failed("The version could not be kept"),
  });
  const keepAll = useMutation({
    mutationFn: () => api.keepAllVersions(root),
    onSuccess: landed,
    onError: failed("The versions could not be kept"),
  });

  /** How many versions are made, the original left out. */
  const made = Math.max(0, all.length - 1);
  return {
    root,
    all,
    made,
    /** Versions made or on their way: the strip is shown. */
    has: made > 0 || running !== "" || waiting !== "0",
    /** Whether this id is the stack's: its original or one of its versions. */
    holds: (id: string) => all.some((v) => v.id === id),
    /** K can keep now: there are versions, and no keep is on its way (else the key is not taken). */
    canKeep: made > 0 && !keep.isPending,
    /** K: the one shown kept (the original included), the others counting down to the bin. */
    keepShown: (id: string) => keep.mutate(id),
    running: running ? running.split(",") : [],
    waiting: Number(waiting),
    keep,
    keepAll,
  };
}

export type Versions = ReturnType<typeof useVersions>;
