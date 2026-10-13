import { ExternalLink } from "lucide-react";
import type { Machine, MachineState, RentedMachine } from "../../api";
import { usd } from "../../format";
import { rentedSaid } from "../../machines";
import { RUNPOD_CONSOLE, useRentedOps } from "../../rentedOps";
import { Select } from "../../Select";
import { ButtonLink, cx, TwoStep } from "../../ui";
import { Row } from "./Rows";

const IDLE = [0, 5, 10, 15, 30, 60, 120];
const WATCH = [0, 5, 10, 15, 30, 60];
const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : `${n / 60} h`);

const WHY_IDLE = "Idle: nothing rendering on it and nothing waiting that it could take. A job waiting for it keeps it on. Stop: the GPU stops billing, its disk goes on (cheap, and it starts again in a minute). Delete the pod: nothing is billed after, and it is gone from RunPod with its disk: a new one is set up next time.";
const WHY_WATCH = "Afflatus runs on this PC, which can crash, sleep or lose its internet: then nothing here can stop the pod. The Afflatus node pack on the pod hears from Afflatus every minute; silent this long, it stops the pod by itself. It needs the pack on the pod (0.13 or newer).";

/** A rented machine's state for its card's head: its words, and Start or Stop. Start is the user's, its rate said first. */
export function RentedHead({ machine, state }: { machine: Machine; state: MachineState | undefined }) {
  const ops = useRentedOps();
  const r = state?.rented;
  if (!r) return null;
  const label = machine.name || "the pod";
  const running = r.status === "RUNNING";
  const stopped = r.status === "EXITED" || r.status === "ERROR";
  const busy = ops.start.isPending || ops.stop.isPending;
  return (
    <span className="flex items-center gap-2">
      <span className={cx("text-[12.5px] font-semibold", running ? "text-good" : r.status === "STARTING" || r.status === "PROVISIONING" ? "text-warn-ink" : "text-ink-2")}>{rentedSaid(r)}</span>
      {stopped && (
        <TwoStep
          label="Start…" title={`Start ${label}?`} yes="Start" disabled={busy || r.capped}
          note={r.capped ? "a spending cap is reached" : `${r.rate ? `${usd(r.rate)} / h from now` : "billed from now"}${machine.rented?.idleMinutes ? ` · stops after ${minutesSaid(machine.rented.idleMinutes)} idle` : ""}`}
          onYes={() => ops.start.mutate(machine.id)}
        />
      )}
      {running && <TwoStep label="Stop…" title={`Stop ${label}?`} yes="Stop" disabled={busy} note={r.diskPerDay > 0.005 ? `the GPU stops billing; the disk keeps billing ${usd(r.diskPerDay)}/day` : "the GPU stops billing"} onYes={() => ops.stop.mutate({ machine: machine.id, how: "stop" })} />}
    </span>
  );
}

/**
 * A rented machine's own rows on its card: the pod (its GPU, rate, address, its page on RunPod), what happens when it sits
 * idle, the watchdog, and deleting the pod on RunPod. `put` saves a change of its rented settings.
 */
export function RentedRows({ machine, state, put }: { machine: Machine; state: MachineState | undefined; put(rented: RentedMachine): void }) {
  const ops = useRentedOps();
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
          {gone && <span className="text-xs text-warn-ink">It is no longer on RunPod (deleted there): remove it here.</span>}
        </span>
        <ButtonLink href={RUNPOD_CONSOLE} target="_blank" rel="noreferrer" size="sm"><ExternalLink size={13} /> RunPod</ButtonLink>
      </Row>
      <Row label="When it is idle" help={WHY_IDLE}>
        <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
          <span className="text-ink-2">after</span>
          <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes idle before" value={String(rented.idleMinutes)} onChange={(v) => set({ idleMinutes: Number(v) })} options={IDLE.map((n) => ({ value: String(n), label: minutesSaid(n) }))} /></span>
          <span className="w-[150px] shrink-0"><Select size="sm" label="What then" value={rented.idleDo} onChange={(v) => set({ idleDo: v as RentedMachine["idleDo"] })} options={[{ value: "stop", label: "Stop it", note: "the disk keeps billing" }, { value: "terminate", label: "Delete the pod", note: "nothing billed, set up again next time" }]} /></span>
          {r?.idleLeftMs != null && <span className="text-ink-3">· stops in {Math.ceil(r.idleLeftMs / 60_000)} min</span>}
        </span>
      </Row>
      <Row label="Watchdog" help={WHY_WATCH}>
        <span className="flex grow flex-wrap items-center justify-end gap-2 text-[12.5px]">
          <span className="text-ink-2">stops it if this PC is silent for</span>
          <span className="w-[104px] shrink-0"><Select size="sm" label="Minutes silent before the pod stops itself" value={String(rented.watchdogMinutes)} onChange={(v) => set({ watchdogMinutes: Number(v) })} options={WATCH.map((n) => ({ value: String(n), label: n === 0 ? "off" : minutesSaid(n) }))} /></span>
          {r?.status === "RUNNING" && (r.watchdog === "on"
            ? <span className="font-semibold text-good">· on</span>
            : r.watchdog === "none" ? <span className="text-warn-ink">· no watchdog: the Afflatus node pack 0.13 is not on the pod</span> : null)}
        </span>
      </Row>
      {!gone && (
        <Row label="Delete the pod" help="On RunPod: the pod and its disk go, with what is on them; nothing is billed after. Your renders are all here already. A network volume, if it has one, stays.">
          <span className="grow text-xs text-ink-2">Nothing billed after; set up again next time.</span>
          <TwoStep tone="danger" label="Delete the pod…" title={`Delete ${machine.name || "the pod"} on RunPod`} note="its disk and what is on it go" yes="Delete" onYes={() => ops.stop.mutate({ machine: machine.id, how: "terminate" })} />
        </Row>
      )}
    </>
  );
}
