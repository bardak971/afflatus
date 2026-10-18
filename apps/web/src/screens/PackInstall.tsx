import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PacksStarted } from "../api";
import { useDownloads } from "../useGetFile";
import { Button } from "../ui";
import { plural } from "../format";
import { queryKeys } from "../queryKeys";

/** How long the installs are watched: past that, Manager is not answering for them. */
const WATCH_MS = 15 * 60_000;
/** How long ComfyUI is waited for after its restart: past that, it is said not to have come back. */
const BACK_MS = 5 * 60_000;

/** A pack's install, as its line says it. */
export type PackStateSaid = { state: "pending" | "done" | "failed" | "skipped"; message?: string };

/**
 * Node packs installed through ComfyUI-Manager, then ComfyUI restarted: what a workflow's missing nodes (Workflows)
 * and the optional ones of the built-in forms (Settings › Models) both go through. `readAgain` is what is read once
 * ComfyUI is back; it throws while ComfyUI does not answer yet ("not answering"), and is tried again until it does.
 */
export function usePackInstall({ missing, packs, machine, readAgain, again }: {
  missing: string[];
  packs: Record<string, string>;
  machine?: string;
  readAgain(): Promise<void>;
  /** What is read again once ComfyUI is back, in a few words ("the workflow"): said while it restarts and when it did not come back. */
  again: { what: string; reopen: string };
}) {
  // the Manager of the machine the packs go to (a pod's tab), not the first one's
  const downloads = useDownloads(machine);
  const noManager = downloads.data?.manager.found === false;
  const [started, setStarted] = useState<(PacksStarted & { at: number }) | null>(null);
  const start = useMutation({ mutationFn: () => api.installPacks({ classes: missing, packs, ...(machine ? { machine } : {}) }), onSuccess: (s) => setStarted({ ...s, at: Date.now() }) });
  const ids = started?.jobs.map((j) => j.id) ?? [];
  // asked at once with no ids too: how many packs Manager installed since ComfyUI started (a reload of the page forgets ours).
  // Watched while something is pending, for a while: a refusal (no Manager) is not asked again
  const watching = () => started !== null && Date.now() - started.at < WATCH_MS;
  const status = useQuery({
    queryKey: [...queryKeys.packs.status(ids), machine ?? ""],
    queryFn: () => api.packsStatus(ids, machine),
    retry: false,
    refetchInterval: (q) => (ids.length && !q.state.error && watching() && (!q.state.data || q.state.data.items.some((i) => i.state === "pending")) ? 2000 : false),
  });
  const gaveUp = started !== null && !watching() && (status.data?.items.some((i) => i.state === "pending") ?? true);
  const installedBefore = !started && (status.data?.installed ?? 0) > 0;
  const stateOf = (pack: string): PackStateSaid | null => {
    const job = started?.jobs.find((j) => j.pack === pack);
    if (!job) return started && started.skipped.includes(pack) ? { state: "skipped" } : null;
    return status.data?.items.find((i) => i.id === job.id) ?? { state: "pending" };
  };
  const states = started ? started.jobs.map((j) => stateOf(j.pack)!) : [];
  const allDone = started !== null && states.length > 0 && states.every((s) => s.state !== "pending");
  const failed = states.filter((s) => s.state === "failed").length;
  const client = useQueryClient();
  const [back, setBack] = useState<"waiting" | "back" | null>(null);
  // why it could not be read again after the restart (ComfyUI not back in time, or the file refused)
  const [notBack, setNotBack] = useState<string | null>(null);
  // the next try, and whether the screen is still open: once it is left, nothing is tried, read or invalidated any more
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  // Manager's reboot route; then read again every few seconds until ComfyUI answers
  const restart = useMutation({
    mutationFn: () => api.restartComfy(machine),
    onSuccess: () => {
      setBack("waiting");
      setNotBack(null);
      const started = Date.now();
      const tryAgain = async () => {
        try {
          await readAgain();
          if (!open.current) return;
          setBack("back");
          // what the new packs change: the forms' setup, the recipes and the machines (not every query of the app)
          for (const queryKey of [queryKeys.setup(), queryKeys.recipes(), queryKeys.machines()]) void client.invalidateQueries({ queryKey });
        } catch (err) {
          if (!open.current) return;
          // only ComfyUI not answering yet is waited out; a file it refuses is refused again on every try
          const message = (err as Error).message;
          const down = /has to be running|not answering|answered 5\d\d/.test(message);
          if (down && Date.now() - started < BACK_MS) timer.current = setTimeout(() => void tryAgain(), 3000);
          else {
            setBack(null);
            setNotBack(down ? `ComfyUI did not come back in ${BACK_MS / 60_000} minutes: see its console, then ${again.reopen}.` : `${again.what.replace(/^./, (c) => c.toUpperCase())} could not be read again: ${message}`);
          }
        }
      };
      timer.current = setTimeout(() => void tryAgain(), 4000);
    },
  });
  return { noManager, started, start, status, gaveUp, installedBefore, stateOf, states, allDone, failed, back, notBack, restart, again };
}

/** The button and where the installs stand: install, installing, restart ComfyUI, back. */
export function PackInstallActions({ install, named, missingLeft }: {
  install: ReturnType<typeof usePackInstall>;
  /** How many packs are known to install. */
  named: number;
  /** Whether something is still missing once ComfyUI is back. */
  missingLeft: boolean;
}) {
  const { noManager, started, start, status, gaveUp, installedBefore, states, allDone, failed, back, notBack, restart, again } = install;
  const restartButton = <Button size="sm" tone="primary" onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? "Asking…" : "Restart ComfyUI now"}</Button>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!started && installedBefore && back !== "back"
        ? (
          <>
            <span>{back === "waiting" ? `ComfyUI is restarting; ${again.what} is read again as soon as it answers…` : `${plural(status.data!.installed, "pack")} installed since ComfyUI started: it loads them at start.`}</span>
            {back !== "waiting" && restartButton}
            {restart.isError && <span>{(restart.error as Error).message}</span>}
          </>
        )
        : !started
        ? <Button size="sm" tone="primary" onClick={() => start.mutate()} disabled={noManager || start.isPending}>{start.isPending ? "Asking ComfyUI-Manager…" : `Install ${named === 1 ? "the pack" : `the ${named} packs`} with ComfyUI-Manager`}</Button>
        : status.isError
          ? <span>{(status.error as Error).message}</span>
        : gaveUp
          ? <span>ComfyUI-Manager has not said for {WATCH_MS / 60_000} minutes how the installs went: see ComfyUI's log, then restart ComfyUI.</span>
        : !allDone
          ? <span>ComfyUI-Manager is installing: it clones each pack and runs its requirements, which can take a few minutes.</span>
          : back === "waiting"
            ? <span>ComfyUI is restarting; {again.what} is read again as soon as it answers…</span>
            : back === "back"
              ? <span className="text-good">ComfyUI is back.{missingLeft ? " What is listed above is still missing." : ""}</span>
              : (
                <>
                  <span>{failed ? `${plural(states.length - failed, "pack")} installed, ${failed} failed (see above).` : "Installed."} ComfyUI loads node packs at start.</span>
                  {restartButton}
                  {restart.isError && <span>{(restart.error as Error).message}</span>}
                </>
              )}
      {noManager && <span>ComfyUI-Manager was not found in your ComfyUI: turn it on first (Settings → Models → Missing models says how).</span>}
      {start.isError && <span>{(start.error as Error).message}</span>}
      {notBack && <span>{notBack}</span>}
    </div>
  );
}

/** A pack's line: where its install stands. */
export function PackStateLine({ s }: { s: PackStateSaid | null }) {
  if (!s) return null;
  return (
    <span className={s.state === "done" ? "font-semibold text-good" : "font-semibold"} data-tip={s.message}>
      {s.state === "pending" ? "installing…" : s.state === "done" ? "installed" : s.state === "failed" ? `failed: ${s.message ?? ""}` : "not installable from here"}
    </span>
  );
}
