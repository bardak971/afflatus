import { useState, type ReactNode } from "react";
import { volumePerMonth } from "@afflatus/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, MoreHorizontal, Trash2 } from "lucide-react";
import { api, type NetworkVolume, type VolumePlan } from "../../api";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { DEPLOYED_READS } from "../../deployReads";
import { LicenceChecks } from "../../DeployModels";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../../Dialog";
import { est, gb, plural, usd, when } from "../../format";
import { Keys } from "../../Keys";
import { queryKeys } from "../../queryKeys";
import { Select } from "../../Select";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card } from "./Rows";

const WHY_VOLUMES = "A network volume keeps your models between deploys: a pod on it is up in a minute with what it holds, instead of fetching them each time. It bills every month, with or without a pod ($0.07 per GB, $0.05 past the first TB), and ties its pods to its data center. One pod at a time on a volume: Afflatus never puts a second one on it. What it holds is read through the last pod that ran on it (nothing can read a volume without a pod).";

/** What a volume of that size costs a month at RunPod's price, to the cent (core's volumePerMonth, as the server says it). */
const perMonth = (gbs: number) => Math.round(volumePerMonth(gbs) * 100) / 100;

/** A range of minutes and dollars, as the estimates say it: "~12–18 min · $0.10–0.15". */
const rangeSaid = (r: { fastMs: number; slowMs: number; lowUsd: number; highUsd: number }) =>
  `${est(r.fastMs)}–${est(r.slowMs).replace(/^~/, "")} · ${usd(r.lowUsd, true)}–${usd(r.highUsd, true).replace(/^\$/, "")}`;

/**
 * Network volumes: each with where it is, what it costs a month, how many model files it holds (as its last pod saw it),
 * the pod on it now, and whether it went unused; Make one, Fill from a set, Grow, Delete.
 */
export function VolumesCard() {
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), refetchInterval: 30_000, staleTime: 10_000, retry: false });
  // the GPUs in stock where each volume is: the plan reads RunPod's stock (the sets weighed are all of them)
  const plan = useQuery({ queryKey: queryKeys.volumePlan(null), queryFn: ({ signal }) => api.volumePlan(null, { signal }), staleTime: 60_000, retry: false });
  const [open, setOpen] = useState<null | { kind: "make" } | { kind: "fill" | "grow" | "delete"; volume: NetworkVolume }>(null);
  const list = volumes.data?.volumes ?? [];
  return (
    <Card
      title="Network volumes"
      setting="rented.volumes"
      help={WHY_VOLUMES}
      status={(
        <span className="flex items-center gap-3">
          {/* what they bill together every month, and how many bill for nothing */}
          {list.length > 0 && (
            <span className="text-[12.5px] text-ink-2">
              <span className="font-mono">{usd(list.reduce((n, v) => n + v.perMonth, 0))}</span>/month
              {list.some((v) => v.unused) && <> · <span className="font-semibold text-warn-ink">{list.filter((v) => v.unused).length} unused</span></>}
            </span>
          )}
          <Button size="sm" onClick={() => setOpen({ kind: "make" })}>Make one…</Button>
        </span>
      )}
    >
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

/** A small rounded label, as the app's chips: a data center, a set's state, a GPU in stock. */
function Chip({ children, tone = "plain", tip }: { children: ReactNode; tone?: "plain" | "good" | "warn"; tip?: string }) {
  return (
    <span data-tip={tip} className={cx("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] whitespace-nowrap", tone === "good" ? "bg-good/12 text-good" : tone === "warn" ? "bg-warn-wash text-warn-ink" : "bg-raised text-ink-2")}>
      {children}
    </span>
  );
}

/**
 * One volume as a tile: the drive and its state (a pod on it, unused, at rest), where it is, its size and what it costs a
 * month; how many model files it holds; how its last fill ended; the GPUs a pod could have there now. Fill from a set first,
 * Grow and Delete behind its ⋯ (a row of three buttons outweighed what it said, the owner: "poor").
 */
function VolumeRow({ v, stock, onAct }: { v: NetworkVolume; stock: Array<{ name: string; price: number }> | null; onAct(kind: "fill" | "grow" | "delete"): void }) {
  const mounted = v.mountedOn.length > 0;
  const more = useMenu<true>();
  const fill = v.lastFill;
  const fillWhy = fill ? fill.failed.map((f) => `${f.file}: ${f.error}`).join("\n") || undefined : undefined;
  return (
    <div className="flex gap-3.5 border-b border-line px-[18px] py-3.5 last:border-b-0">
      <span className={cx("relative grid size-10 shrink-0 place-items-center rounded-[10px] border", v.usedBy ? "border-good/40 bg-good/10 text-good" : v.unused ? "border-warn/40 bg-warn-wash text-warn-ink" : "border-line-strong bg-raised text-ink-2")}>
        <HardDrive size={18} />
        {v.usedBy && <span aria-hidden className="absolute -top-1 -right-1 size-2.5 animate-pulse rounded-full border-2 border-panel bg-good" />}
      </span>
      <div className="flex min-w-0 grow flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold">{v.name}</span>
          <Chip>{v.dataCenter}</Chip>
          <Chip>{v.size} GB</Chip>
          <span className="font-mono text-xs text-ink-2">{usd(v.perMonth)}<span className="text-ink-3">/month</span></span>
          <span className="grow" />
          <Button size="sm" onClick={() => onAct("fill")} disabled={Boolean(v.usedBy)} data-tip={v.usedBy ? `In use by ${v.usedBy.name}: one pod at a time on a volume` : "A pod on the cheapest GPU there fetches a set's files onto it, then goes"}>Fill from a set…</Button>
          <button type="button" aria-label={`More for ${v.name}`} onClick={(e) => more.open(e, true)} className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
            <MoreHorizontal size={16} />
          </button>
        </div>

        {/* its state: the pod on it, else unused (billed for nothing), else nothing to say */}
        {v.usedBy && <span className="text-[12.5px] text-good">In use by <b>{v.usedBy.name}</b> · {v.usedBy.status === "RUNNING" ? "running" : "starting"}</span>}
        {v.unused && <span className="text-[12.5px] text-warn-ink">Unused {v.usedAt ? `since ${when(v.usedAt)}` : "since Afflatus first saw it"}: {usd(v.perMonth)} a month for nothing. Delete it if you will not deploy on it soon.</span>}

        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <span className="w-[92px] shrink-0 text-ink-3">Holds</span>
          {v.holds
            ? <Chip tip={`As ${v.holds.seenBy} saw it ${when(v.holds.seenAt)}`}>{plural(v.holds.count, "model file")}</Chip>
            : <span className="text-ink-3">not read yet: the next pod on it reads it</span>}
        </div>

        {fill && (
          <span className={cx("text-[12.5px]", fill.interrupted || fill.failed.length ? "text-warn-ink" : "text-ink-2")} data-tip={fillWhy}>
            Last fill {when(fill.at)}: {fill.interrupted
              ? `cut short, ${fill.interrupted}${fill.failed.length ? ` (${plural(fill.failed.length, "file")} not in)` : ""}: fill again`
              : fill.failed.length
                ? `${plural(fill.failed.length, "file")} failed (${fill.failed.slice(0, 2).map((f) => f.file).join(", ")}${fill.failed.length > 2 ? "…" : ""}): fill again, or look at their sources`
                : "all in"}
          </span>
        )}

        {stock !== null && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="w-[92px] shrink-0 text-ink-3">In stock there</span>
            {stock.length
              ? <>{stock.slice(0, 6).map((g) => <Chip key={g.name}>{g.name} <span className="font-mono text-ink-3">{usd(g.price)}/h</span></Chip>)}{stock.length > 6 && <span className="text-ink-3">+{stock.length - 6}</span>}</>
              : <span className="text-ink-3">no GPU now</span>}
          </div>
        )}
      </div>
      {more.menu && (
        <ContextMenu at={more.menu.at} label={v.name} onClose={more.close} items={[
          { label: "Grow…", note: "never shrinks", run: () => onAct("grow") },
          { label: "Delete…", danger: true, icon: <Trash2 size={14} />, disabled: mounted, note: mounted ? `mounted on ${v.mountedOn.map((p) => p.name).join(", ")}` : "its monthly bill stops", run: () => onAct("delete") },
        ]} />
      )}
    </div>
  );
}

/** The "?" of an estimate with a guess in it: a source (or a pod's start) never measured on the user's deploys. */
const GUESS_TIP = "Part of this was never measured on your deploys (a source the files come from, or a pod's start): that part is taken at a cautious usual speed. It is measured from the first pod that fetches one, and said from then on.";

/** What a volume saves at the user's pace: the deploys of the last 30 days, each fetching the sets at the measured speeds. */
function paysSaid(plan: VolumePlan, size: number): string {
  const cost = usd(perMonth(size));
  if (!plan.deploys || !plan.fetch) return `${cost} a month. How much it saves is said once you have deployed with these sets (Afflatus measures the fetches).`;
  const n = plan.deploys;
  return `${cost} a month. At your pace (${plural(n, "pod")} in the last 30 days) it saves ${est(plan.fetch.fastMs * n)}–${est(plan.fetch.slowMs * n).replace(/^~/, "")} of fetching a month, and ${usd(plan.fetch.lowUsd * n, true)}–${usd(plan.fetch.highUsd * n, true).replace(/^\$/, "")} of GPU time${plan.fetch.guessed ? " (a guess until a pod has fetched one of each source)" : ""}.`;
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
      // the plan counts the user's pods and volumes per data center: read again with the new one
      for (const queryKey of [queryKeys.runpodVolumes(), queryKeys.rentedSpending(), queryKeys.volumePlan(null)]) void client.invalidateQueries({ queryKey });
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
        {plan && <span className="text-xs text-ink-2" data-tip={plan.fetch?.guessed ? GUESS_TIP : undefined}>{paysSaid(plan, gbs)}</span>}
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
  // the set's licences, each accepted here before its files are fetched (the server refuses otherwise)
  const [accept, setAccept] = useState<Set<string>>(() => new Set());
  const fill = useMutation({
    mutationFn: () => api.fillVolume(volume.id, chosen, [...accept]),
    onSuccess: () => {
      for (const queryKey of [...DEPLOYED_READS, queryKeys.runpodVolumes()]) void client.invalidateQueries({ queryKey });
      onClose();
    },
  });
  const p = plan.data;
  const nothing = p !== undefined && p.missing.count === 0;
  const accepted = (p?.licences ?? []).every((l) => accept.has(l.id));
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
            {p.gpu && !nothing && p.estimate && <span data-tip={p.estimate.guessed ? GUESS_TIP : undefined}>{`About ${rangeSaid(p.estimate)}, its start included, ${p.estimate.guessed ? "a guess until a pod has fetched one of each source" : "at your measured speeds"}.`}</span>}
          </span>
        )}
        {p && !nothing && p.licences.length > 0 && (
          <span className="flex flex-col gap-1">
            <LicenceChecks licences={p.licences} accept={accept} onChange={setAccept} />
            {!accepted && <span className="text-xs text-warn-ink">Accept the licence above to fill with those files.</span>}
          </span>
        )}
        {(plan.isError || fill.isError) && <ErrorNote>{(plan.error ?? fill.error)!.message}</ErrorNote>}
      </div>
      <DialogFoot info="Billed from the deploy, as any pod">
        <Button tone="quiet" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={() => fill.mutate()} disabled={!p?.gpu || nothing || !accepted || fill.isPending}>{fill.isPending ? "Deploying…" : p?.gpu ? `Fill · ${usd(p.gpu.price)}/h` : "Fill"}</Button>
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
