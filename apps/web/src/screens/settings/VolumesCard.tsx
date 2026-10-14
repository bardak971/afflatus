import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Trash2 } from "lucide-react";
import { api, type NetworkVolume, type VolumePlan } from "../../api";
import { DEPLOYED_READS } from "../../deployReads";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../../Dialog";
import { est, gb, plural, usd, when } from "../../format";
import { Keys } from "../../Keys";
import { queryKeys } from "../../queryKeys";
import { Select } from "../../Select";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card } from "./Rows";

const WHY_VOLUMES = "A network volume keeps your models between deploys: a pod on it is up in a minute with what it holds, instead of fetching them each time. It bills every month, with or without a pod ($0.07 per GB), and ties its pods to its data center. One pod at a time on a volume: Afflatus never puts a second one on it. What it holds is read through the last pod that ran on it (nothing can read a volume without a pod).";

/** RunPod's price of a standard volume, a GB and a month (the server's VOLUME_PER_GB_MONTH says the same). */
const PER_GB = 0.07;
const perMonth = (gbs: number) => Math.round(gbs * PER_GB * 100) / 100;

/** A range of minutes and dollars, as the estimates say it: "~12–18 min · $0.10–0.15". */
const rangeSaid = (r: { fastMs: number; slowMs: number; lowUsd: number; highUsd: number }) =>
  `${est(r.fastMs)}–${est(r.slowMs).replace(/^~/, "")} · ${usd(r.lowUsd, true)}–${usd(r.highUsd, true).replace(/^\$/, "")}`;

/**
 * Network volumes: each with where it is, what it costs a month, what it holds (as its last pod saw it, per Model set),
 * the pod on it now, and whether it went unused; Make one, Fill from a set, Grow, Delete.
 */
export function VolumesCard() {
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), refetchInterval: 30_000, staleTime: 10_000, retry: false });
  // the GPUs in stock where each volume is: the plan reads RunPod's stock (the sets weighed are all of them)
  const plan = useQuery({ queryKey: queryKeys.volumePlan(null), queryFn: ({ signal }) => api.volumePlan(null, { signal }), staleTime: 60_000, retry: false });
  const [open, setOpen] = useState<null | { kind: "make" } | { kind: "fill" | "grow" | "delete"; volume: NetworkVolume }>(null);
  const list = volumes.data?.volumes ?? [];
  return (
    <Card title="Network volumes" setting="rented.volumes" help={WHY_VOLUMES} status={<Button size="sm" onClick={() => setOpen({ kind: "make" })}>Make one…</Button>}>
      {volumes.isError && <Block><ErrorNote>{volumes.error.message}</ErrorNote></Block>}
      {volumes.isSuccess && !list.length && <Block><span className="text-xs text-ink-2">No volume on this account. Without one, each deploy fetches its models; with one, they wait there for the next pod.</span></Block>}
      {list.map((v) => <VolumeRow key={v.id} v={v} stock={plan.data?.places.find((p) => p.dataCenter === v.dataCenter)?.gpus ?? null} onAct={(kind) => setOpen({ kind, volume: v })} />)}
      {open?.kind === "make" && <MakeVolume plan={plan.data ?? null} onClose={() => setOpen(null)} />}
      {open?.kind === "fill" && <FillVolume volume={open.volume} onClose={() => setOpen(null)} />}
      {open?.kind === "grow" && <GrowVolume volume={open.volume} onClose={() => setOpen(null)} />}
      {open?.kind === "delete" && <DeleteVolume volume={open.volume} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function VolumeRow({ v, stock, onAct }: { v: NetworkVolume; stock: Array<{ name: string; price: number }> | null; onAct(kind: "fill" | "grow" | "delete"): void }) {
  const mounted = v.mountedOn.length > 0;
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-[18px] py-3 text-[12.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={cx("size-[7px] rounded-full", v.usedBy ? "bg-good" : v.unused ? "bg-warn" : "border-[1.5px] border-ink-3")} />
        <span className="font-semibold">{v.name}</span>
        <span className="text-ink-3">· {v.dataCenter} · {v.size} GB · {usd(v.perMonth)} a month</span>
        <span className="grow" />
        <Button size="sm" onClick={() => onAct("fill")} disabled={Boolean(v.usedBy)} data-tip={v.usedBy ? `In use by ${v.usedBy.name}: one pod at a time on a volume` : undefined}>Fill from a set…</Button>
        <Button size="sm" tone="quiet" onClick={() => onAct("grow")}>Grow…</Button>
        <Button size="sm" tone="quiet" onClick={() => onAct("delete")} disabled={mounted} data-tip={mounted ? `Mounted on ${v.mountedOn.map((p) => p.name).join(", ")}: terminate ${v.mountedOn.length === 1 ? "that pod" : "those pods"} first` : undefined}>Delete…</Button>
      </div>
      {v.usedBy && <span className="text-ink-2">In use by <b className="text-ink">{v.usedBy.name}</b> · {v.usedBy.status === "RUNNING" ? "running" : "starting"}</span>}
      {v.unused && <span className="text-warn-ink">Unused {v.usedAt ? `since ${when(v.usedAt)}` : "since Afflatus first saw it"}: {usd(v.perMonth)} a month for nothing. Delete it if you will not deploy on it soon.</span>}
      <span className="text-ink-2">
        {v.holds ? <>Holds {plural(v.holds.count, "model file")}, as {v.holds.seenBy} saw it {when(v.holds.seenAt)}</> : "What it holds is not known yet: no pod Afflatus follows ran on it"}
        {v.sets.length > 0 && <> · {v.sets.map((s, i) => (
          <span key={s.id}>{i > 0 && " · "}{s.name} {s.missing.count ? <span className="text-warn-ink">{s.missing.bytes ? gb(s.missing.bytes) : plural(s.missing.count, "file")} missing</span> : <span className="text-good">all there</span>}</span>
        ))}</>}
      </span>
      {v.lastFill && (v.lastFill.failed.length
        ? <span className="text-warn-ink" data-tip={v.lastFill.failed.map((f) => `${f.file}: ${f.error}`).join("\n")}>Last fill {when(v.lastFill.at)}: {plural(v.lastFill.failed.length, "file")} failed ({v.lastFill.failed.slice(0, 2).map((f) => f.file).join(", ")}{v.lastFill.failed.length > 2 ? "…" : ""}): fill again, or look at their sources</span>
        : <span className="text-ink-2">Last fill {when(v.lastFill.at)}: all in</span>)}
      {stock !== null && <span className="text-ink-3">{stock.length ? `In stock there now: ${stock.slice(0, 5).map((g) => g.name).join(", ")}${stock.length > 5 ? ` and ${stock.length - 5} more` : ""}` : "No GPU in stock there now"}</span>}
    </div>
  );
}

/** What a volume saves at the user's pace: the deploys of the last 30 days, each fetching the sets at the measured speeds. */
function paysSaid(plan: VolumePlan, size: number): string {
  const cost = usd(perMonth(size));
  if (!plan.deploys || !plan.fetch) return `${cost} a month. How much it saves is said once you have deployed with these sets (Afflatus measures the fetches).`;
  const n = plan.deploys;
  return `${cost} a month. At your pace (${plural(n, "pod")} in the last 30 days) it saves ${est(plan.fetch.fastMs * n)}–${est(plan.fetch.slowMs * n).replace(/^~/, "")} of fetching a month, and ${usd(plan.fetch.lowUsd * n, true)}–${usd(plan.fetch.highUsd * n, true).replace(/^\$/, "")} of GPU time.`;
}

function MakeVolume({ plan, onClose }: { plan: VolumePlan | null; onClose(): void }) {
  const client = useQueryClient();
  const [name, setName] = useState("afflatus-models");
  const [place, setPlace] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const chosen = place ?? plan?.places[0]?.dataCenter ?? null;
  const gbs = size ?? plan?.sizeGb ?? 100;
  const make = useMutation({
    mutationFn: () => api.makeVolume({ name: name.trim(), size: gbs, dataCenter: chosen! }),
    onSuccess: () => {
      for (const queryKey of [queryKeys.runpodVolumes(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
      onClose();
    },
  });
  const setsBytes = plan?.sets.reduce((n, s) => n + s.bytes, 0) ?? 0;
  return (
    <Dialog label="Make a network volume" onClose={onClose} className={cx(DIALOG.replace("max-w-md", "max-w-[560px]"), "max-h-[calc(100vh-48px)]")}>
      <DialogHead icon={<HardDrive size={16} />} title="Make a network volume" sub="RunPod · Secure Cloud" onClose={onClose} />
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-1 text-[13px]">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-2">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={cx("h-9", fieldClass)} />
        </label>
        <div role="radiogroup" aria-label="Data center" className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-2">Data center: its pods run there only</span>
          {!plan && <span className="text-xs text-ink-3">Asking RunPod…</span>}
          {plan && !plan.places.length && <span className="text-xs text-ink-2">No GPU in stock anywhere now: a volume where none is free cannot be used. Try again in a while.</span>}
          <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
            {plan?.places.map((p) => (
              <button key={p.dataCenter} type="button" role="radio" aria-checked={p.dataCenter === chosen} onClick={() => setPlace(p.dataCenter)} className={cx("flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left", p.dataCenter === chosen ? "border-accent bg-accent-wash" : "border-line hover:bg-hover")}>
                <span className="font-semibold">{p.dataCenter}{p.pods > 0 && <span className="font-normal text-ink-3"> · {plural(p.pods, "pod")} of yours there now</span>}</span>
                <span className="text-xs text-ink-3">In stock now: {p.gpus.slice(0, 6).map((g) => `${g.name} ${usd(g.price)}/h`).join(", ")}{p.gpus.length > 6 ? ` and ${p.gpus.length - 6} more` : ""}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-2">Size</span>
          <input inputMode="numeric" aria-label="Size in GB" value={gbs} onChange={(e) => setSize(Math.min(4096, Number(e.target.value.replace(/\D/g, "")) || 0))} className={cx("h-8 w-[90px] font-mono text-xs", fieldClass)} />
          <span className="text-xs text-ink-3">GB{gbs < 10 ? " · 10 at least" : ""} · {setsBytes ? `your sets take ${gb(setsBytes)}` : "no Model set yet"} · a volume grows later, never shrinks</span>
        </label>
        {plan && <span className="text-xs text-ink-2">{paysSaid(plan, gbs)}</span>}
        {make.isError && <ErrorNote>{make.error.message}</ErrorNote>}
      </div>
      <DialogFoot info={`Billed every month from now, pod or not`}>
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={() => make.mutate()} disabled={!chosen || !name.trim() || gbs < 10 || make.isPending}>{make.isPending ? "Making…" : `Make it · ${usd(perMonth(gbs))} a month`}</Button>
      </DialogFoot>
    </Dialog>
  );
}

function FillVolume({ volume, onClose }: { volume: NetworkVolume; onClose(): void }) {
  const client = useQueryClient();
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }) });
  // the set it lacks the most of first
  const [set, setSet] = useState<string>(() => [...volume.sets].sort((a, b) => b.missing.bytes - a.missing.bytes)[0]?.id ?? "");
  const chosen = set || sets.data?.items[0]?.id || "";
  const plan = useQuery({ queryKey: queryKeys.fillPlan(volume.id, chosen), queryFn: ({ signal }) => api.fillPlan(volume.id, chosen, { signal }), enabled: Boolean(chosen), staleTime: 15_000, retry: false });
  const fill = useMutation({
    mutationFn: () => api.fillVolume(volume.id, chosen),
    onSuccess: () => {
      for (const queryKey of [...DEPLOYED_READS, queryKeys.runpodVolumes()]) void client.invalidateQueries({ queryKey });
      onClose();
    },
  });
  const p = plan.data;
  const nothing = p !== undefined && p.missing.count === 0;
  return (
    <Dialog label="Fill a volume from a set" onClose={onClose} className={DIALOG.replace("max-w-md", "max-w-[520px]")}>
      <DialogHead icon={<HardDrive size={16} />} title={`Fill ${volume.name}`} sub={`${volume.dataCenter} · ${volume.size} GB`} onClose={onClose} />
      <div className="flex flex-col gap-3 text-[13px]">
        <span className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-2">Model set</span>
          <span className="w-[260px]"><Select size="sm" label="Model set" value={chosen} onChange={setSet} placeholder="No Model set yet" options={(sets.data?.items ?? []).map((s) => ({ value: s.id, label: s.name, note: s.bytes ? gb(s.bytes) : undefined }))} /></span>
        </span>
        {sets.isSuccess && !sets.data.items.length && <span className="text-xs text-ink-2">No Model set yet: make one in Settings › Models.</span>}
        {plan.isPending && chosen && <span className="text-xs text-ink-3">Asking RunPod…</span>}
        {p && (
          <span className="flex flex-col gap-1 text-xs text-ink-2">
            <span>{p.missing.count ? <>To fetch: <b className="text-ink">{plural(p.missing.count, "file")}{p.missing.bytes ? `, ${gb(p.missing.bytes)}` : ""}</b>{volume.holds ? "" : " (what it holds is not known: all of the set, files already there are skipped)"}</> : "All of this set is there already, as last seen."}</span>
            {p.gpu ? <span>On the cheapest GPU in stock there: <b className="text-ink">{p.gpu.name}</b> at {usd(p.gpu.price)}/h, no render given to it, terminated once the files are in.</span> : <span className="text-warn-ink">No GPU in stock in {volume.dataCenter} now: try again in a while.</span>}
            {p.gpu && !nothing && <span>{p.estimate ? `About ${rangeSaid(p.estimate)}, its start included, at your measured speeds.` : "How long is said once Afflatus has measured a deploy's fetches."}</span>}
          </span>
        )}
        {(plan.isError || fill.isError) && <ErrorNote>{(plan.error ?? fill.error)!.message}</ErrorNote>}
      </div>
      <DialogFoot info="Billed from the deploy, as any pod">
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={() => fill.mutate()} disabled={!p?.gpu || nothing || fill.isPending}>{fill.isPending ? "Deploying…" : p?.gpu ? `Fill · ${usd(p.gpu.price)}/h` : "Fill"}</Button>
      </DialogFoot>
    </Dialog>
  );
}

function GrowVolume({ volume, onClose }: { volume: NetworkVolume; onClose(): void }) {
  const client = useQueryClient();
  const [size, setSize] = useState(Math.min(4096, Math.ceil((volume.size * 1.5) / 10) * 10));
  const grow = useMutation({
    mutationFn: () => api.growVolume(volume.id, size),
    onSuccess: () => {
      for (const queryKey of [queryKeys.runpodVolumes(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
      onClose();
    },
  });
  return (
    <Dialog label="Grow a network volume" onClose={onClose} className={DIALOG}>
      <DialogHead icon={<HardDrive size={16} />} title={`Grow ${volume.name}`} sub={`${volume.size} GB now · ${usd(volume.perMonth)} a month`} onClose={onClose} />
      <label className="flex items-center gap-2 text-[13px]">
        <span className="text-xs font-semibold text-ink-2">New size</span>
        <input inputMode="numeric" aria-label="New size in GB" value={size} onChange={(e) => setSize(Math.min(4096, Number(e.target.value.replace(/\D/g, "")) || 0))} className={cx("h-8 w-[90px] font-mono text-xs", fieldClass)} />
        <span className="text-xs text-ink-3">GB · {usd(perMonth(size))} a month · it never shrinks again</span>
      </label>
      {grow.isError && <ErrorNote>{grow.error.message}</ErrorNote>}
      <DialogFoot>
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={() => grow.mutate()} disabled={size <= volume.size || size > 4096 || grow.isPending}>Grow · {usd(perMonth(size))} a month</Button>
      </DialogFoot>
    </Dialog>
  );
}

function DeleteVolume({ volume, onClose }: { volume: NetworkVolume; onClose(): void }) {
  const client = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteVolume(volume.id),
    onSuccess: () => {
      for (const queryKey of [queryKeys.runpodVolumes(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
      onClose();
    },
  });
  return (
    <Dialog label="Delete a network volume" onClose={onClose} className={DIALOG}>
      <DialogHead icon={<Trash2 size={16} />} tone="warn" title={`Delete ${volume.name}?`} onClose={onClose} />
      <span className="text-[13px] text-ink-2">
        {volume.holds ? `It holds ${plural(volume.holds.count, "model file")} (as ${volume.holds.seenBy} saw it ${when(volume.holds.seenAt)}): the next deploys fetch them again.` : "What it holds is not known: everything on it goes."}
        {" "}Its {usd(volume.perMonth)} a month stops at once. This cannot be undone.
      </span>
      {del.isError && <ErrorNote>{del.error.message}</ErrorNote>}
      <DialogFoot>
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button>
      </DialogFoot>
    </Dialog>
  );
}
