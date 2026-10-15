import { Link } from "wouter";
import type { Machine, MachineState, RentedMachine } from "../../api";
import type { PodFile, PodPack } from "../../api";
import { minutesSaid, plural, size, usd } from "../../format";
import { useCopied, useNow } from "../../hooks";
import { gettingFiles, rateSaid, rentedSaid } from "../../machines";
import type { useRentedOps } from "../../rentedOps";
import { Select } from "../../Select";
import { Progress } from "../../progress/Progress";
import { Button, Checkbox, cx, TwoStep } from "../../ui";
import { diskNearlyFull, diskSaid } from "../../machineBits";
import { Block, Row } from "./Rows";

const IDLE = [0, 5, 10, 15, 30, 60, 120];
const WATCH = [0, 5, 10, 15, 30, 60];
/** A port as the card says it: what a template usually runs on it. */
const portSaid = (p: string) => {
  const [port, kind] = p.split("/");
  const what: Record<string, string> = { "8080": "FileBrowser", "8888": "JupyterLab", "22": "SSH", "3000": "web UI", "7860": "web UI" };
  return `${port}${what[port!] ? ` ${what[port!]}` : ""}${kind === "tcp" ? " (TCP)" : ""}`;
};

const WHY_IDLE = "Idle: nothing rendering on it, no model file coming to it, and nothing waiting that it could take; a job waiting for it keeps it on, and so do its files while they come (a download that brings nothing for 5 min no longer does). Stop: the GPU stops billing, its volume is kept (and billed), its container disk is erased; its GPU may be taken meanwhile, and then it cannot start again. Terminate: nothing billed after, the pod gone from RunPod: deploy a new one next time. Without a volume a stop keeps nothing: terminate.";
const WHY_PORTS = "What a pod's template opens besides ComfyUI: FileBrowser (8080), JupyterLab (8888), SSH (22). They have logins of their own, outside Afflatus's lock, some with a default password printed in the template's page: anyone who finds the pod's address can try them, and with FileBrowser reach its files, ComfyUI's custom nodes included. Closed, Afflatus takes them off the pod at each Start (RunPod's exposed ports), and only ComfyUI is reached, locked. Open them to use one (FileBrowser to put the Afflatus pack on it).";
const WHY_WATCH = "Afflatus runs on this PC, which can crash, sleep or lose its internet: then nothing here can stop the pod. The Afflatus node pack on the pod hears from Afflatus every minute; silent this long, it stops the pod by itself. It needs the pack on the pod (0.13 or newer).";

const VIA_SAID: Record<NonNullable<PodFile["via"]>, string> = { hf: "Hugging Face", civitai: "Civitai", url: "its address", upload: "this PC" };
const WHY_DISK = "The pod's own disk (or its volume), which the models it fetches fill: in use of all of it, as its node pack says (Afflatus's image 0.1.10 on). Make room: when a model its jobs need does not fit, Afflatus first deletes models it fetched there that no waiting or running job needs, the longest unused first; never a file it did not fetch. Off: such a job goes to another machine, and its row says why.";
const WHY_FILES = "The model files the pod gets: what its waiting jobs need first, in the order the queue needs them (a job starts as soon as its own files are there), then the ones asked ahead (its deploy's set, a job that ran at home this time). Straight from Hugging Face or Civitai; a file no site is known for comes from this PC. A file never keeps the pod: with nothing to render it goes idle and ends on time.";

/** The files a pod is getting, each with how far it is: ready, a share, next, or why it failed. */
export function PodFiles({ files, packs = [] }: { files: PodFile[]; packs?: PodPack[] }) {
  const ready = files.filter((f) => f.state === "ready").length;
  const packSaid: Record<PodPack["state"], string> = { next: "next", installing: "installing", installed: "installed · ComfyUI restarts once nothing renders", ready: "loaded", failed: "failed" };
  return (
    <span className="flex min-w-0 grow flex-col gap-1 text-[12.5px]">
      {files.length > 0 && <span className="text-xs text-ink-3">{ready} of {files.length} there</span>}
      {packs.map((p) => (
        <span key={p.name} className="flex items-center gap-2" data-tip={p.error}>
          <span className="min-w-0 truncate">{p.name}<span className="text-ink-3"> · node pack · for {plural(Math.max(1, p.jobs.length), "job")}</span></span>
          <span className="grow" />
          <span className={cx("text-xs", p.state === "ready" ? "text-good" : p.state === "failed" ? "text-warn-ink" : "text-ink-3")}>{packSaid[p.state]}</span>
        </span>
      ))}
      {files.map((f) => {
        const share = f.total ? Math.min(100, Math.round((f.bytes / f.total) * 100)) : 0;
        return (
          <span key={`${f.folder}|${f.file}`} className="grid grid-cols-[minmax(0,1fr)_90px_110px] items-center gap-3" data-tip={f.error ?? (f.via ? `from ${VIA_SAID[f.via]}` : undefined)}>
            <span className={cx("min-w-0 truncate", f.state === "next" && f.tier === "ahead" && "text-ink-2")}>
              {f.file}<span className="text-ink-3"> · {f.tier === "need" ? `for ${plural(Math.max(1, f.jobs.length), "job")}` : "ahead"}{f.via === "upload" ? " · from this PC" : ""}</span>
            </span>
            <Progress value={f.state === "ready" ? 1 : share / 100} className="h-1" under="bg-hover" radius="" tone={f.state === "ready" ? "bg-good" : f.state === "failed" ? "bg-warn" : f.tier === "ahead" ? "bg-ink-3" : "bg-accent"} label={f.file} />
            <span className={cx("text-right text-xs", f.state === "ready" ? "text-good" : f.state === "failed" ? "text-warn-ink" : "text-ink-3")}>
              {f.state === "ready" ? "ready" : f.state === "failed" ? "failed" : f.state === "next" ? "next" : f.total ? `${share} % of ${size(f.total)}` : "starting"}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** "Stops in 4 min", counting down between two reads of the queue (from when it was read). */
function IdleLeft({ at }: { at: number }) {
  const now = useNow(5000);
  const left = Math.max(0, at - now);
  return <span className="text-ink-3">· stops in {left < 60_000 ? "under a minute" : `${Math.ceil(left / 60_000)} min`}</span>;
}

/** A rented machine's state for its card's head: its words, and Start or Stop. Start is the user's, its rate said first. */
export function RentedHead({ machine, state, ops }: { machine: Machine; state: MachineState | undefined; ops: ReturnType<typeof useRentedOps> }) {
  const r = state?.rented;
  // its running time and cost count by the second while it runs, and a first start's time since its deploy
  const now = useNow(1000, r?.status === "RUNNING" || Boolean(r?.boot));
  if (!r) return null;
  const label = machine.name || "the pod";
  const running = r.status === "RUNNING";
  const stopped = r.status === "EXITED" || r.status === "ERROR";
  const starting = r.status === "STARTING" || r.status === "PROVISIONING";
  const busy = ops.start.isPending || ops.stop.isPending || r.stopping;
  return (
    <span className="flex items-center gap-2">
      <span className={cx("text-[12.5px] font-semibold", r.booting ? "text-ink-2" : running ? "text-good" : r.status === "STARTING" || r.status === "PROVISIONING" ? "text-warn-ink" : "text-ink-2")}>{rentedSaid(r, now)}</span>
      {stopped && (
        <TwoStep
          label="Start…" title={`Start ${label}?`} yes="Start" disabled={busy || r.capped}
          note={r.capped ? "a spending cap is reached" : `${rateSaid(r)}${machine.rented?.idleMinutes ? ` · ${machine.rented.idleDo === "stop" ? "stops" : "terminates"} after ${minutesSaid(machine.rented.idleMinutes)} idle` : ""}`}
          onYes={() => ops.start.mutate(machine.id)}
        />
      )}
      {(running || starting) && (
        <TwoStep
          label="Stop…" title={`Stop ${label}?`} yes="Stop" disabled={busy}
          note={`${state?.running ? "its render is lost · " : ""}${r.diskPerDay > 0.005 ? `the GPU stops billing; the disk keeps billing ${usd(r.diskPerDay)}/day` : "the GPU stops billing"}`}
          onYes={() => ops.stop.mutate({ machine: machine.id, how: "stop" })}
        />
      )}
    </span>
  );
}

/**
 * A rented machine's own rows on its card: what is happening to the pod (its first start, an error, gone), the files it
 * gets, how it stops by itself (idle, the watchdog), its public ports, and at its foot its address and Terminate. Its GPU,
 * rate and place are in the card's facts; its page on RunPod in the menu. `put` saves a change of its rented settings.
 */
export function RentedRows({ machine, state, put, ops, remove }: { machine: Machine; state: MachineState | undefined; put(rented: RentedMachine): void; ops: ReturnType<typeof useRentedOps>; /** Takes it out of Afflatus. */ remove(): void }) {
  const rented = machine.rented!;
  const r = state?.rented;
  const set = (change: Partial<RentedMachine>) => put({ ...rented, ...change });
  const gone = r?.status === "GONE" || r?.status === "TERMINATED";
  const { copied, copy } = useCopied();
  return (
    <>
      {/* what is happening to the pod, when something is: its first start, an error, gone from RunPod */}
      {((r?.booting && !r.error) || r?.error || gone) && (
        <Block>
          {r?.booting && !r.error && (
            <span className="text-xs text-ink-3">
              First start: its image pulled onto the host, then ComfyUI starts · a few minutes, billed · terminated by itself if not up in 20 min ·{" "}
              <Link href={`/queue?view=log&machine=${encodeURIComponent(machine.id)}`} className="font-semibold text-accent hover:underline">its boot log</Link>
            </span>
          )}
          {r?.error && <span className="text-xs text-warn-ink">{r.error}</span>}
          {gone && (
            <span className="flex flex-wrap items-center gap-2 text-xs text-warn-ink">
              {r?.stoppedBy === "idle" ? `Terminated after ${minutesSaid(rented.idleMinutes)} idle: nothing billed any more.` : r?.stoppedBy === "boot" ? (rented.deployed ? "Terminated: it did not come up in 20 min (its image did not pull, or its container did not start). Nothing billed any more." : "Terminated: its ComfyUI never answered (its container did not start). Nothing billed any more.") : r?.stoppedBy === "gpu" ? "Terminated: its GPU did not work on that host. Nothing billed any more; deploy again, RunPod picks another host." : r?.stoppedBy === "start" ? "Terminated: its start stopped on an error. Nothing billed any more; its last lines are in its log." : r?.stoppedBy === "watchdog" ? "Stopped by its watchdog while Afflatus was away, then terminated: it kept nothing. Nothing billed any more." : "Not on RunPod: terminated there, or the key is another account's."}
              <Button size="sm" onClick={remove}>Remove from Afflatus</Button>
            </span>
          )}
        </Block>
      )}
      {r && (r.files.length > 0 || r.packs.length > 0) && (
        <Row label="Models" help={WHY_FILES}>
          <PodFiles files={r.files} packs={r.packs} />
        </Row>
      )}
      {r && r.status === "RUNNING" && (
        <Row label="Disk" help={WHY_DISK}>
          <span className="flex grow flex-wrap items-center justify-end gap-3 text-[12.5px]">
            {r.disk && <span className={cx("font-mono", diskNearlyFull(r.disk) ? "text-warn-ink" : "text-ink-2")}>{diskSaid(r.disk)} in use</span>}
            <Checkbox checked={rented.makeRoom} onChange={(makeRoom) => set({ makeRoom })}>Make room</Checkbox>
          </span>
        </Row>
      )}
      {/* how it stops by itself, together: idle, and the watchdog when this PC goes silent */}
      <div className="flex flex-col divide-y divide-line/60">
        <div className="px-[18px] pt-3 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">Stops by itself</div>
        <Row label="When it is idle" help={WHY_IDLE}>
          <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
            {/* in the Deploy dialog's order: "Terminate it after 10 min idle" (here it was "after 10 min · Terminate it") */}
            <span className="w-[150px] shrink-0"><Select size="sm" label="What then" value={rented.idleDo} onChange={(v) => set({ idleDo: v as RentedMachine["idleDo"] })} options={[{ value: "stop", label: "Stop it", note: "its volume kept and billed" }, { value: "terminate", label: "Terminate it", note: "nothing billed, deploy a new one next time" }]} /></span>
            <span className="text-ink-2">after</span>
            <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes idle before" value={String(rented.idleMinutes)} onChange={(v) => set({ idleMinutes: Number(v) })} options={IDLE.map((n) => ({ value: String(n), label: minutesSaid(n) }))} /></span>
            <span className="text-ink-2">idle</span>
            {r?.idleAt != null ? <IdleLeft at={r.idleAt} /> : r?.status === "RUNNING" && state && gettingFiles(state) && <span className="text-ink-3">· held while its files come</span>}
          </span>
        </Row>
        {rented.idleDo === "stop" && r && !r.volume && r.status !== "GONE" && r.status !== "UNKNOWN" && (
          <Block><span className="text-xs text-warn-ink">No volume on this pod: a stop keeps nothing (its container disk is erased), and its GPU can be taken meanwhile. Terminate costs the same and leaves nothing billed.</span></Block>
        )}
        <Row label="Watchdog" help={WHY_WATCH} sub="stops it when this PC goes silent">
          <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
            <span className="text-ink-2">stops it if this PC is silent for</span>
            <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes silent before the pod stops itself" value={String(rented.watchdogMinutes)} onChange={(v) => set({ watchdogMinutes: Number(v) })} options={WATCH.map((n) => ({ value: String(n), label: n === 0 ? "off" : minutesSaid(n) }))} /></span>
            {r?.status === "RUNNING" && (r.watchdog === "on"
              ? <span className="font-semibold text-good">· on</span>
              : r.watchdog === "none" ? <span className="text-warn-ink">· no watchdog: the Afflatus node pack 0.13 is not on the pod</span> : null)}
          </span>
        </Row>
      </div>
      {r && (r.otherPorts.length > 0 || rented.closedPorts.length > 0) && (
        <Row label="Public ports" help={WHY_PORTS}>
          <span className="flex min-w-0 grow flex-col gap-1 text-[12.5px]">
            <span className="font-mono text-xs text-ink-2">{[...new Set([...r.otherPorts, ...rented.closedPorts])].map(portSaid).join(" · ")}</span>
            {rented.openPorts
              ? <span className="text-xs text-warn-ink">{r.otherPorts.length ? "Open, outside the lock: anyone who finds the pod's address can try their logins." : "Put back at its next Start, then open outside the lock."}</span>
              : <span className="text-xs text-ink-3">{r.otherPorts.length ? (r.status === "RUNNING" ? "Open now, outside the lock: closed at its next Start." : "Closed at its next Start.") : "Closed: only ComfyUI is reached, locked."}</span>}
          </span>
          <Checkbox checked={rented.openPorts} onChange={(openPorts) => set({ openPorts })}>Keep them open</Checkbox>
        </Row>
      )}
      {/* its foot: its address, and Terminate apart from the everyday buttons (the pod and its disk go, nothing billed after) */}
      <div className="flex flex-wrap items-center gap-3 bg-raised px-[18px] py-2.5 text-xs">
        <span className="min-w-0 truncate font-mono text-ink-3">{machine.url.replace(/^https?:\/\//, "")}</span>
        <button type="button" className="shrink-0 font-semibold text-ink-2 hover:text-ink" onClick={() => copy(machine.url)}>{copied ? "Copied" : "Copy"}</button>
        <span className="grow" />
        {!gone && <TwoStep tone="danger" label="Terminate…" title={`Terminate ${machine.name || "the pod"}`} note={`${state?.running ? "its render is lost · " : ""}gone from RunPod and from Afflatus, its disk with it; nothing billed after (a network volume stays)`} yes="Terminate" disabled={ops.stop.isPending} onYes={() => ops.stop.mutate({ machine: machine.id, how: "terminate" })} />}
      </div>
    </>
  );
}
