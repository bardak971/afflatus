import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Inspection, Wiring, WorkflowDef } from "@afflatus/workflows";
import { api, type PacksStarted } from "../api";
import { useDownloads } from "../GetFile";
import { Button, cx } from "../ui";

const link = "font-semibold text-accent underline underline-offset-2 hover:text-ink";

/**
 * The node types a workflow uses that this ComfyUI lacks, by the pack each comes from, with one button
 * that has ComfyUI-Manager install the packs. The packs come from the workflow (its author's ComfyUI
 * wrote each node's pack) and, for the rest, from Manager's own map; a node type nobody places is
 * listed on its own with a search link. ComfyUI reads custom_nodes at start: a restart follows.
 */
export function MissingPacks({ missing, packs, graph, wiring, onInspected }: {
  missing: string[];
  packs: Record<string, string>;
  graph: WorkflowDef["graph"];
  wiring?: Wiring;
  /** Called with the workflow read again once ComfyUI is back after the restart. */
  onInspected(found: Inspection): void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const n of missing) {
      const p = packs[n] ?? "";
      if (!by.has(p)) by.set(p, []);
      by.get(p)!.push(n);
    }
    // the known packs first, by name; the orphans last
    return [...by.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [missing, packs]);
  const named = groups.filter(([p]) => p).length;
  const downloads = useDownloads();
  const noManager = downloads.data?.manager.found === false;
  const [started, setStarted] = useState<PacksStarted | null>(null);
  const start = useMutation({ mutationFn: () => api.installPacks({ classes: missing, packs }), onSuccess: setStarted });
  const ids = started?.jobs.map((j) => j.id) ?? [];
  // asked at once with no ids too: how many packs Manager installed since ComfyUI started (a reload of the page forgets ours)
  const status = useQuery({
    queryKey: ["packs", ids],
    queryFn: () => api.packsStatus(ids),
    refetchInterval: (q) => (ids.length && (!q.state.data || q.state.data.items.some((i) => i.state === "pending")) ? 2000 : false),
  });
  const installedBefore = !started && (status.data?.installed ?? 0) > 0;
  const stateOf = (pack: string) => {
    const job = started?.jobs.find((j) => j.pack === pack);
    if (!job) return started && started.skipped.includes(pack) ? { state: "skipped" as const } : null;
    return status.data?.items.find((i) => i.id === job.id) ?? { state: "pending" as const };
  };
  const states = started ? started.jobs.map((j) => stateOf(j.pack)!) : [];
  const allDone = started !== null && states.length > 0 && states.every((s) => s.state !== "pending");
  const failed = states.filter((s) => s.state === "failed").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const client = useQueryClient();
  const [back, setBack] = useState<"waiting" | "back" | null>(null);
  // Manager's reboot route; then the workflow is read again every few seconds until ComfyUI answers, and the list is the new one
  const restart = useMutation({
    mutationFn: () => api.restartComfy(),
    onSuccess: () => {
      setBack("waiting");
      const started = Date.now();
      const again = async () => {
        try {
          const found = await api.inspectWorkflow({ graph, wiring });
          onInspected(found);
          setBack("back");
          void client.invalidateQueries();
        } catch {
          if (Date.now() - started < 5 * 60_000) setTimeout(() => void again(), 3000);
          else setBack(null);
        }
      };
      setTimeout(() => void again(), 4000);
    },
  });

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg bg-warn-wash px-3 py-2 text-warn-ink">
      <span>
        Your ComfyUI is missing {plural(missing.length, "node type")} this workflow uses{named ? `, from ${plural(named, "pack")}` : ""}. You can save it, but it cannot run until they are installed.
      </span>
      <ul className="flex flex-col gap-1">
        {groups.map(([pack, nodes]) => {
          const s = pack ? stateOf(pack) : null;
          return (
            <li key={pack || "?"} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {pack
                ? <a className={link} href={`https://registry.comfy.org/nodes/${encodeURIComponent(pack)}`} target="_blank" rel="noreferrer">{pack}</a>
                : <span className="font-semibold">No pack known</span>}
              <span className="opacity-70">{nodes.join(" · ")}</span>
              {!pack && nodes.map((n) => (
                <a key={n} className={link} href={`https://github.com/search?q=${encodeURIComponent(`"${n}" comfyui`)}&type=code`} target="_blank" rel="noreferrer">search GitHub for {n}</a>
              ))}
              {s && (
                <span className={cx("font-semibold", s.state === "done" ? "text-good" : "")} title={"message" in s ? s.message : undefined}>
                  {s.state === "pending" ? "installing…" : s.state === "done" ? "installed" : s.state === "failed" ? `failed: ${"message" in s ? s.message : ""}` : "not installable from here"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {named > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {!started && installedBefore && back !== "back"
            ? (
              <>
                <span>{back === "waiting" ? "ComfyUI is restarting; the workflow is read again as soon as it answers…" : `${plural(status.data!.installed, "pack")} installed since ComfyUI started: it loads them at start.`}</span>
                {back !== "waiting" && <Button size="sm" tone="primary" onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? "Asking…" : "Restart ComfyUI now"}</Button>}
                {restart.isError && <span>{(restart.error as Error).message}</span>}
              </>
            )
            : !started
            ? <Button size="sm" tone="primary" onClick={() => start.mutate()} disabled={noManager || start.isPending}>{start.isPending ? "Asking ComfyUI-Manager…" : `Install ${named === 1 ? "the pack" : `the ${named} packs`} with ComfyUI-Manager`}</Button>
            : !allDone
              ? <span>ComfyUI-Manager is installing: it clones each pack and runs its requirements, which can take a few minutes.</span>
              : back === "waiting"
                ? <span>ComfyUI is restarting; the workflow is read again as soon as it answers…</span>
                : back === "back"
                  ? <span className="text-good">ComfyUI is back.{missing.length ? " What is listed above is still missing." : ""}</span>
                  : (
                    <>
                      <span>{failed ? `${plural(states.length - failed, "pack")} installed, ${failed} failed (see above).` : "Installed."} ComfyUI loads node packs at start.</span>
                      <Button size="sm" tone="primary" onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? "Asking…" : "Restart ComfyUI now"}</Button>
                      {restart.isError && <span>{(restart.error as Error).message}</span>}
                    </>
                  )}
          {noManager && <span>ComfyUI-Manager was not found in your ComfyUI: turn it on first (Settings → Models → Missing models says how).</span>}
          {start.isError && <span>{(start.error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}
