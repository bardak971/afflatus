import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type HealthCheck } from "./api";
import { size } from "./format";
import { useCopied } from "./hooks";
import { Progress } from "./progress/Progress";
import { queryKeys } from "./queryKeys";
import { Button, ErrorNote } from "./ui";

const BUSY = new Set(["downloading", "unpacking", "checking"]);
/** Said in place of the button to a page on another computer (the banner too). */
export const ELSEWHERE = "Get ffmpeg from the PC Afflatus runs on.";

/**
 * Get ffmpeg followed wherever it was started (About's button, the banner's, the bar's), mounted once by the app: its view
 * read every second while it runs, and the checks read again once it is done or failed. Followed only by About's button,
 * the checks (read once, kept for good) still said ffmpeg failed in the banner and the bar after a Get begun elsewhere.
 */
export function useFollowFfmpegGet() {
  const client = useQueryClient();
  const busy = (phase: string | undefined) => BUSY.has(phase ?? "");
  const phase = useQuery({
    queryKey: queryKeys.ffmpegGet(),
    queryFn: ({ signal }) => api.ffmpegGet({ signal }),
    // nothing asked until a Get is under way (its start writes the view): the page never asks when there is nothing to get
    enabled: (q) => busy(q.state.data?.phase),
    refetchInterval: (q) => (busy(q.state.data?.phase) ? 1000 : false),
  }).data?.phase;
  const before = useRef(phase);
  useEffect(() => {
    const was = before.current;
    before.current = phase;
    if (phase !== was && (phase === "done" || phase === "failed")) void client.invalidateQueries({ queryKey: queryKeys.health() });
  }, [phase, client]);
}

/**
 * Get ffmpeg (ffmpegGet.ts), where the ffmpeg check offers it: on Windows and Linux, a button that downloads the bundles'
 * build into Afflatus's data folder, with its progress, then the checks read again (the new ffmpeg used at once); on macOS,
 * Homebrew's line with Copy. Nothing when the check offers neither (it passed, or FFMPEG is set). From another computer
 * (`here` false), where the server refuses the download, the button gives way to a line saying where to press it.
 */
export function GetFfmpeg({ check, here }: { check: HealthCheck | undefined; here: boolean | undefined }) {
  const client = useQueryClient();
  const brew = useCopied();
  const view = useQuery({
    queryKey: queryKeys.ffmpegGet(),
    queryFn: ({ signal }) => api.ffmpegGet({ signal }),
    enabled: check?.get === "download",
    refetchInterval: (q) => (BUSY.has(q.state.data?.phase ?? "") ? 1000 : false),
  });
  const start = useMutation({ mutationFn: () => api.getFfmpeg(), onSuccess: (v) => client.setQueryData(queryKeys.ffmpegGet(), v) });
  const phase = view.data?.phase ?? "idle";
  // done: the server ran its checks again, which the banner, About and the first launch read
  useEffect(() => {
    if (phase === "done" || phase === "failed") void client.invalidateQueries({ queryKey: queryKeys.health() });
  }, [phase, client]);
  if (check?.get === "brew") {
    return (
      <span className="flex items-center gap-2">
        <code className="rounded-control bg-raised px-2 py-1 font-mono text-xs text-ink">brew install ffmpeg</code>
        <Button size="sm" onClick={() => brew.copy("brew install ffmpeg")}>{brew.copied ? "Copied" : "Copy"}</Button>
      </span>
    );
  }
  if (check?.get !== "download" && phase !== "done") return null;
  const v = view.data;
  if (v && BUSY.has(v.phase)) {
    const said = v.phase === "downloading" ? `Downloading ffmpeg · ${size(v.bytes)} of ${size(v.total)}` : v.phase === "unpacking" ? "Unpacking ffmpeg…" : "Checking the new ffmpeg…";
    return (
      <span className="flex min-w-0 grow flex-col gap-1">
        <span className="text-xs text-ink-2">{said}</span>
        <Progress value={v.total ? v.bytes / v.total : 0} loading={v.phase !== "downloading"} className="h-1.5 w-full" label={said} />
      </span>
    );
  }
  if (phase === "done") return <span className="text-xs text-good">ffmpeg is in Afflatus's data folder and used from now on.</span>;
  if (here === false) return <span className="text-xs text-ink-3">{ELSEWHERE}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" tone="primary" disabled={start.isPending} onClick={() => start.mutate()}>{start.isPending ? "Starting…" : "Get ffmpeg"}</Button>
      <span className="text-xs text-ink-3">BtbN's GPL build{v?.total ? `, ${size(v.total)}` : ""}, into the data folder</span>
      {(start.error || (phase === "failed" && v?.error)) && <ErrorNote>{start.error?.message ?? v?.error}</ErrorNote>}
    </span>
  );
}
