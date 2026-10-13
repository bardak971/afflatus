import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Machine, MachineState, RentedMachine } from "../../api";
import { usd } from "../../format";
import { useNow } from "../../hooks";
import { rateSaid, rentedSaid } from "../../machines";
import { RUNPOD_CONSOLE, type useRentedOps } from "../../rentedOps";
import { Select } from "../../Select";
import { Button, ButtonLink, Checkbox, cx, TwoStep } from "../../ui";
import { Block, Row } from "./Rows";

const IDLE = [0, 5, 10, 15, 30, 60, 120];
const WATCH = [0, 5, 10, 15, 30, 60];
/** A port as the card says it: what a template usually runs on it. */
const portSaid = (p: string) => {
  const [port, kind] = p.split("/");
  const what: Record<string, string> = { "8080": "FileBrowser", "8888": "JupyterLab", "22": "SSH", "3000": "web UI", "7860": "web UI" };
  return `${port}${what[port!] ? ` ${what[port!]}` : ""}${kind === "tcp" ? " (TCP)" : ""}`;
};
const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : `${n / 60} h`);

const WHY_IDLE = "Idle: nothing rendering on it and nothing waiting that it could take; a job waiting for it keeps it on. Stop: the GPU stops billing, its volume is kept (and billed), its container disk is erased; its GPU may be taken meanwhile, and then it cannot start again. Terminate: nothing billed after, the pod gone from RunPod: deploy a new one next time. Without a volume a stop keeps nothing: terminate.";
const WHY_PORTS = "What a pod's template opens besides ComfyUI: FileBrowser (8080), JupyterLab (8888), SSH (22). They have logins of their own, outside Afflatus's lock, some with a default password printed in the template's page: anyone who finds the pod's address can try them, and with FileBrowser reach its files, ComfyUI's custom nodes included. Closed, Afflatus takes them off the pod at each Start (RunPod's exposed ports), and only ComfyUI is reached, locked. Open them to use one (FileBrowser to put the Afflatus pack on it).";
const WHY_WATCH = "Afflatus runs on this PC, which can crash, sleep or lose its internet: then nothing here can stop the pod. The Afflatus node pack on the pod hears from Afflatus every minute; silent this long, it stops the pod by itself. It needs the pack on the pod (0.13 or newer).";

/** "Stops in 4 min", counting down between two reads of the queue (from when it was read). */
function IdleLeft({ ms }: { ms: number }) {
  const [from] = useState(() => Date.now());
  const now = useNow(5000);
  const left = Math.max(0, ms - (now - from));
  return <span className="text-ink-3">· stops in {left < 60_000 ? "under a minute" : `${Math.ceil(left / 60_000)} min`}</span>;
}

/** A rented machine's state for its card's head: its words, and Start or Stop. Start is the user's, its rate said first. */
export function RentedHead({ machine, state, ops }: { machine: Machine; state: MachineState | undefined; ops: ReturnType<typeof useRentedOps> }) {
  const r = state?.rented;
  // its running time and cost count by the second while it runs
  const now = useNow(1000, r?.status === "RUNNING");
  if (!r) return null;
  const label = machine.name || "the pod";
  const running = r.status === "RUNNING";
  const stopped = r.status === "EXITED" || r.status === "ERROR";
  const starting = r.status === "STARTING" || r.status === "PROVISIONING";
  const busy = ops.start.isPending || ops.stop.isPending || r.stopping;
  return (
    <span className="flex items-center gap-2">
      <span className={cx("text-[12.5px] font-semibold", running ? "text-good" : r.status === "STARTING" || r.status === "PROVISIONING" ? "text-warn-ink" : "text-ink-2")}>{rentedSaid(r, now)}</span>
      {stopped && (
        <TwoStep
          label="Start…" title={`Start ${label}?`} yes="Start" disabled={busy || r.capped}
          note={r.capped ? "a spending cap is reached" : `${rateSaid(r)}${machine.rented?.idleMinutes ? ` · stops after ${minutesSaid(machine.rented.idleMinutes)} idle` : ""}`}
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
 * A rented machine's own rows on its card: the pod (its GPU, rate, address, its page on RunPod), what happens when it sits
 * idle, the watchdog, and deleting the pod on RunPod. `put` saves a change of its rented settings.
 */
export function RentedRows({ machine, state, put, ops, remove }: { machine: Machine; state: MachineState | undefined; put(rented: RentedMachine): void; ops: ReturnType<typeof useRentedOps>; /** Takes it out of Afflatus. */ remove(): void }) {
  const rented = machine.rented!;
  const r = state?.rented;
  const set = (change: Partial<RentedMachine>) => put({ ...rented, ...change });
  const gone = r?.status === "GONE" || r?.status === "TERMINATED";
  return (
    <>
      <Row label="Pod" help="A pod you made on RunPod, added as it is. Afflatus reads its state there, starts it only when you press Start, and stops it as you say below. Its rate is RunPod's; what it has cost is Afflatus's figure (its time × its rate), and RunPod's bill is the reference.">
        <span className="flex min-w-0 grow flex-col gap-0.5 text-[12.5px]">
          <span>{[r?.gpu?.replace(/^NVIDIA (GeForce )?/, ""), r?.dataCenter, r?.rate ? `${usd(r.rate)} / h` : null].filter(Boolean).join(" · ") || "…"}</span>
          <span className="truncate font-mono text-[11.5px] text-ink-3">{machine.url}</span>
          {r?.error && <span className="text-xs text-warn-ink">{r.error}</span>}
          {gone && (
            <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-warn-ink">
              {r?.stoppedBy === "idle" ? `Terminated after ${minutesSaid(rented.idleMinutes)} idle: nothing billed any more.` : "Not on RunPod: terminated there, or the key is another account's."}
              <Button size="sm" onClick={remove}>Remove from Afflatus</Button>
            </span>
          )}
        </span>
        <ButtonLink href={RUNPOD_CONSOLE} target="_blank" rel="noreferrer" size="sm"><ExternalLink size={13} /> RunPod</ButtonLink>
      </Row>
      <Row label="When it is idle" help={WHY_IDLE}>
        <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
          <span className="text-ink-2">after</span>
          <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes idle before" value={String(rented.idleMinutes)} onChange={(v) => set({ idleMinutes: Number(v) })} options={IDLE.map((n) => ({ value: String(n), label: minutesSaid(n) }))} /></span>
          <span className="w-[150px] shrink-0"><Select size="sm" label="What then" value={rented.idleDo} onChange={(v) => set({ idleDo: v as RentedMachine["idleDo"] })} options={[{ value: "stop", label: "Stop it", note: "its volume kept and billed" }, { value: "terminate", label: "Terminate it", note: "nothing billed, deploy a new one next time" }]} /></span>
          {r?.idleLeftMs != null && <IdleLeft key={r.idleLeftMs} ms={r.idleLeftMs} />}
        </span>
      </Row>
      {rented.idleDo === "stop" && r && !r.volume && r.status !== "GONE" && (
        <Block><span className="text-xs text-warn-ink">No volume on this pod: a stop keeps nothing (its container disk is erased), and its GPU can be taken meanwhile. Terminate costs the same and leaves nothing billed.</span></Block>
      )}
      <Row label="Watchdog" help={WHY_WATCH}>
        <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
          <span className="text-ink-2">stops it if this PC is silent for</span>
          <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes silent before the pod stops itself" value={String(rented.watchdogMinutes)} onChange={(v) => set({ watchdogMinutes: Number(v) })} options={WATCH.map((n) => ({ value: String(n), label: n === 0 ? "off" : minutesSaid(n) }))} /></span>
          {r?.status === "RUNNING" && (r.watchdog === "on"
            ? <span className="font-semibold text-good">· on</span>
            : r.watchdog === "none" ? <span className="text-warn-ink">· no watchdog: the Afflatus node pack 0.13 is not on the pod</span> : null)}
        </span>
      </Row>
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
      {!gone && (
        <Row label="Terminate" help="On RunPod: the pod and its disk go, with what is on them; nothing is billed after. It goes from Afflatus too. Your renders are all here already. A network volume, if it has one, stays.">
          <span className="grow text-xs text-ink-2">Nothing billed after; deploy a new one next time.</span>
          <TwoStep tone="danger" label="Terminate…" title={`Terminate ${machine.name || "the pod"}`} note={`${state?.running ? "its render is lost · " : ""}gone from RunPod and from Afflatus, its disk with it`} yes="Terminate" disabled={ops.stop.isPending} onYes={() => ops.stop.mutate({ machine: machine.id, how: "terminate" })} />
        </Row>
      )}
    </>
  );
}
