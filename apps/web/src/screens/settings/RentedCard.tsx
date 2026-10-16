import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shortGpu } from "@afflatus/core";
import { Link, useLocation } from "wouter";
import { api, type RunpodPod } from "../../api";
import { useQueue, useSettings } from "../../data";
import { useOpenComfyUI } from "../../actions";
import { useRentedOps } from "../../rentedOps";
import { RentedHead } from "./RentedRows";
import { minutesSaid, plural, usd, when } from "../../format";
import { Select } from "../../Select";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, ErrorNote, fieldClass, Help } from "../../ui";
import { runwayNowSaid, runwaySaid, runwayWhy } from "../queue/costsView";
import { Block, Card, Row } from "./Rows";
import { tabHref } from "./settingsIndex";
import { COLUMNS } from "./wide";
import { capAmount } from "./capAmount";
import { openDeploy } from "../../deploy";
import { idleEndSaid, podsAdded, rateParts } from "../../machines";
import { BootNote, STARTING_DOT } from "../../machineBits";
import { VolumesCard } from "./VolumesCard";
import { SecretField } from "./SecretField";

/** The days after which a volume no pod ran on is flagged; 0: never. */
const UNUSED_DAYS = [3, 7, 14, 30, 0];

const WHY_RUNPOD = "A pod you made on RunPod, added as a machine: Afflatus reads its state there, starts it only when you press Start, and stops it when it sits idle, at a spending cap, or (with the Afflatus node pack on it) when this PC goes silent. The key is a RunPod API key (RunPod › Settings › API Keys); it stays in Afflatus, never shown again. The pod must expose ComfyUI's port, 8188, over HTTP.";

/** The RunPod API key typed in and saved: written once, never shown again. */
function RunpodKey({ setting, label, onSaved, onCancel }: { setting: string; label: string; onSaved?(): void; onCancel?(): void }) {
  const client = useQueryClient();
  const saveKey = useMutation({
    mutationFn: (runpodKey: string) => api.saveSettings({ runpodKey }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      for (const queryKey of [queryKeys.runpodPods(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
      onSaved?.();
    },
  });
  return (
    <>
      <Row setting={setting} label={label} htmlFor="runpod-key" help={WHY_RUNPOD}>
        <SecretField id="runpod-key" label="RunPod API key" saved={false} placeholder="Your RunPod API key" valid={(key) => key.length >= 10} busy={saveKey.isPending} onSave={(key) => saveKey.mutateAsync(key)} />
        {onCancel && <Button tone="quiet" onClick={onCancel}>Cancel</Button>}
      </Row>
      {saveKey.isError && <Block><ErrorNote>{saveKey.error.message}</ErrorNote></Block>}
    </>
  );
}

const WHY_S3 = "Optional. A volume's Files are read through the pod running on it, with no key to set. With RunPod's S3 API key, they are read and cleaned with no pod running too. Make one on RunPod's Credentials page (S3 API Keys tab) and paste its secret (rps_…) here: RunPod shows it once, and Afflatus keeps it, never shown again. Its access key is your RunPod user id, which Afflatus reads with the API key. Not every data center has the S3 API: RunPod says which.";

/** RunPod's S3 API key, for a volume's Files with no pod running: its secret pasted once (the access key is the account's id), never shown again. */
function S3Key() {
  const settings = useSettings();
  const client = useQueryClient();
  const has = Boolean(settings.data?.hasRunpodS3Secret);
  const [changing, setChanging] = useState(false);
  const save = useMutation({
    mutationFn: (secret: string) => api.saveSettings({ runpodS3Secret: secret }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.runpodVolumes() });
      setChanging(false);
    },
  });
  const make = <a href="https://console.runpod.io/user/credentials" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-ink-2 hover:text-ink">Make one <ExternalLink size={12} /></a>;
  if (has && !changing) {
    return (
      <Row setting="rented.s3" label="S3 API key" help={WHY_S3}>
        <span className="grow text-xs text-ink-2">set · kept in Afflatus, never shown again</span>
        <Button size="sm" tone="quiet" onClick={() => setChanging(true)}>Change key</Button>
      </Row>
    );
  }
  return (
    <>
      <Row setting="rented.s3" label="S3 API key" sub="optional: Files with no pod running" help={WHY_S3}>
        {make}
        <SecretField label="S3 API key's secret" saved={false} placeholder="rps_…" valid={(key) => key.length >= 10} busy={save.isPending} onSave={(key) => save.mutateAsync(key)} />
        {changing && <Button tone="quiet" onClick={() => setChanging(false)}>Cancel</Button>}
      </Row>
      {save.isError && <Block><ErrorNote>{save.error.message}</ErrorNote></Block>}
    </>
  );
}

/**
 * "Or a RunPod pod", under "Add a ComfyUI": the API key once, and then the way to Settings › Rented GPUs, where the
 * account's pods are added. The key saved here opens that tab.
 */
export function RentRow() {
  const settings = useSettings();
  const [, go] = useLocation();
  if (!settings.data) return null;
  if (!settings.data.hasRunpodKey) return <RunpodKey setting="comfy.runpod" label="Or a RunPod pod" onSaved={() => go(tabHref("rented"))} />;
  return (
    <Row setting="comfy.runpod" label="Or a RunPod pod" help={WHY_RUNPOD}>
      <span className="grow text-xs text-ink-2">Your pods, the caps and the key</span>
      <Link href={tabHref("rented")} className="text-[12.5px] font-semibold hover:underline">Rented GPUs ›</Link>
      <Button size="sm" onClick={() => openDeploy()}>Deploy a GPU…</Button>
    </Row>
  );
}

type CapKey = "day" | "month";

/** What each cap weighs: the day's is compute alone, the month's everything RunPod bills (rented.ts spent says the same). */
const CAP_DAY_WHY = "Compute only: what your pods cost today while they run, their GPU and their disk. A stopped pod's disk and the network volumes are not in it: they bill whether anything runs or not, and the month cap has them.";
const CAP_MONTH_WHY = "Everything RunPod bills this month: the pods, the disks of stopped pods and the network volumes. At it the pods stop, and Start, Deploy, Make volume and Grow are refused.";

/** A figure against its cap, in a few words: "$1.18 of $5", or the figure alone without a cap. */
const against = (value: number, cap: number) => `${usd(value, true)}${cap > 0 ? ` of ${usd(cap)}` : ""}`;

/**
 * A cap in dollars: a small box, saved when it is left. Empty or 0: no cap. Its parent remounts it (a new `key`) when a
 * save of it failed, so that it shows the cap as saved again rather than the amount typed, which is not in force. Its "?"
 * says what it weighs: the two caps do not weigh the same bill.
 */
function CapBox({ label, value, help, onSave }: { label: string; value: number; help: string; onSave(v: number): void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    // empty: no cap; anything that does not read as one amount for sure keeps the cap as it was (never a cap silently gone)
    const n = capAmount(text);
    if (n === null || !Number.isFinite(n)) {
      setText(value ? String(value) : "");
      return;
    }
    if (n !== value) onSave(n);
  };
  // its "?" beside the label, not in it: a click on it never lands in the box
  return (
    <span className="flex items-center gap-1">
      <label className="flex items-center gap-1.5 text-[12.5px]">
        <span className="text-ink-2">{label}</span>
        <span className="text-ink-3">$</span>
        <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} inputMode="decimal" placeholder="none" aria-label={`Cap ${label}`} className={cx("h-8 w-[68px] font-mono text-xs", fieldClass)} />
      </label>
      <Help text={help} title={`Cap ${label}`} />
    </span>
  );
}

/**
 * The RunPod account: its key, its balance and how long it lasts, the caps with today and this month under them, and when a
 * volume counts as unused. The spending itself (the month, the day, where it went) is Queue › Costs's: here, only what a
 * setting is weighed against.
 */
function RunpodAccount() {
  const settings = useSettings();
  const client = useQueryClient();
  const has = Boolean(settings.data?.hasRunpodKey);
  const [changing, setChanging] = useState(false);
  // with a key and no pod, a volume left behind still bills: read whenever there is a key
  const any = has || (settings.data?.machines.some((m) => m.rented) ?? false);
  // read again every 10 s while a pod runs (its cost goes on), every minute otherwise
  const running = useQueue().data?.machines.some((m) => m.rented?.status === "RUNNING") ?? false;
  const spending = useQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), enabled: any, refetchInterval: running ? 10_000 : 60_000 });
  const saveCaps = useMutation({
    mutationFn: (rentCaps: { day: number; month: number }) => api.saveSettings({ rentCaps }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.rentedSpending() });
    },
  });
  const sayFailed = useSayFailed({ href: "/settings/rented", go: "Open Rented GPUs" });
  const saveUnused = useMutation({
    mutationFn: (volumeUnusedDays: number) => api.saveSettings({ volumeUnusedDays }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      for (const queryKey of [queryKeys.rentedSpending(), queryKeys.runpodVolumes()]) void client.invalidateQueries({ queryKey });
    },
    onError: sayFailed("The unused volumes' days were not saved"),
  });
  const s = spending.data?.spending;
  const now = s ? runwayNowSaid({ spendPerHr: s.spendPerHr, runwayNowMs: s.runwayMs, perDay: s.perDay.pods + s.perDay.storage }) : null;
  // the caps as saved (written in at once on a save), not as the spending read some seconds ago: two edits in a row each keep the other
  const caps = settings.data?.rentCaps ?? s?.caps ?? { day: 0, month: 0 };
  // each edit made on the caps as the edits before it left them, and sent after them: a second edit within one round trip
  // never brings the first one's old value back (a cap is money)
  const latestCaps = useRef<{ day: number; month: number } | null>(null);
  const capsQueue = useRef<Promise<unknown>>(Promise.resolve());
  // a cap whose save failed: said under the boxes until that same cap saves (a save of the other one says nothing of it),
  // and its box remounted (`resets`) to show the cap as saved, not the amount typed, which is not in force
  const [notSaved, setNotSaved] = useState<Partial<Record<CapKey, string>>>({});
  const [resets, setResets] = useState<Record<CapKey, number>>({ day: 0, month: 0 });
  const changeCaps = (key: CapKey, value: number) => {
    const next = { ...(latestCaps.current ?? caps), [key]: value };
    latestCaps.current = next;
    capsQueue.current = capsQueue.current
      .then(() => saveCaps.mutateAsync(next))
      .then(
        () => setNotSaved(({ [key]: _was, ...rest }) => rest),
        (err: unknown) => {
          // the edits queued after this one were made on top of it: they start again from the caps as saved
          latestCaps.current = null;
          setNotSaved((was) => ({ ...was, [key]: err instanceof Error ? err.message : String(err) }));
          setResets((was) => ({ ...was, [key]: was[key] + 1 }));
        },
      )
      .finally(() => {
        if (latestCaps.current === next) latestCaps.current = null;
      });
  };
  return (
    <Card
      title="RunPod account"
      help="What your rented pods cost, every pod of the account, its GPU and its disk: RunPod's own bill. RunPod writes it some hours after the fact, so the last hours are Afflatus's count (each pod's time × its rate, from its deploy), the higher of the two while a pod runs, so that a cap is never reached late. A network volume is billed apart, every month: it counts in the month cap, not the day's. The balance lasts at this pace (the pods' last 7 days and storage), and at what the account spends now while a pod runs: at zero RunPod stops every pod, and a render that would end after it is not sent to a rented pod."
      status={(
        <span className="flex items-center gap-3 text-[12.5px]">
          {s && s.balance !== null && (
            <span className={s.lowBalance || (s.runwayMs !== null && s.runwayMs < 3_600_000) ? "font-semibold text-warn-ink" : "text-ink-2"}>
              balance <span className="font-mono text-ink">{usd(s.balance)}</span>
              {/* the same runways as Queue › Costs: at this pace (storage in it), and at what is spent now while a pod runs */}
              {s.runwayDays !== null && <> · lasts {runwaySaid(s.runwayDays)}</>}
              {now && <> · {now}</>}
            </span>
          )}
          {s && s.balance !== null && <Help text={runwayWhy(s.perDay)} title="How long the balance lasts" className="self-center" />}
          {/* the spending itself is the Queue's Costs view */}
          <Link href="/queue?view=costs" className="font-semibold text-ink-2 hover:text-ink">Costs ›</Link>
        </span>
      )}
    >
      {!has || changing
        ? <RunpodKey setting="rented.key" label="API key" onSaved={() => setChanging(false)} onCancel={changing ? () => setChanging(false) : undefined} />
        : (
          <Row setting="rented.key" label="API key" help={WHY_RUNPOD}>
            <span className="grow text-xs text-ink-2">set · kept in Afflatus, never shown again</span>
            <Button size="sm" tone="quiet" onClick={() => setChanging(true)}>Change key</Button>
          </Row>
        )}
      {has && (
        // today and this month under the caps, which they are weighed against
        <Row setting="comfy.rentcaps" label="Caps" sub={s ? `today ${against(s.today, caps.day)} · this month ${against(s.month, caps.month)}` : undefined} help="At a cap, the render running finishes, then the pods stop; what waits goes to your other machines, and Start and Deploy say the cap is reached. Empty: no cap. The day cap is compute only, the month cap the whole bill. Both are RunPod's bill, its last hours counted here.">
          <CapBox key={`day-${resets.day}`} label="a day" value={caps.day} help={CAP_DAY_WHY} onSave={(day) => changeCaps("day", day)} />
          <CapBox key={`month-${resets.month}`} label="a month" value={caps.month} help={CAP_MONTH_WHY} onSave={(month) => changeCaps("month", month)} />
        </Row>
      )}
      {has && <S3Key />}
      {has && (
        <Row setting="rented.unused" label="Unused volumes" help="A network volume no pod ran on for this long is flagged here and on the tab: it bills every month all the same.">
          <span className="w-[120px]"><Select size="sm" label="Flag a volume unused after" value={String(settings.data?.volumeUnusedDays ?? 7)} onChange={(v) => !saveUnused.isPending && saveUnused.mutate(Number(v))} options={UNUSED_DAYS.map((n) => ({ value: String(n), label: n ? `after ${plural(n, "day")}` : "never" }))} /></span>
        </Row>
      )}
      {(s?.lowBalance || spending.isError || Object.keys(notSaved).length > 0 || Boolean(s?.storage?.unused.length) || Boolean(s?.storage?.stoppedDisks)) && (
        <Block>
          {s?.lowBalance && <ErrorNote>Your RunPod balance is low: RunPod stops pods at zero, and may delete their disks after a while.</ErrorNote>}
          {Boolean(s?.storage?.stoppedDisks) && <ErrorNote>{s!.storage!.stoppedDisks === 1 ? "1 stopped pod with a disk: billed while it waits. Terminate it if you will not start it again." : `${s!.storage!.stoppedDisks} stopped pods with a disk: billed while they wait. Terminate them if you will not start them again.`}</ErrorNote>}
          {s?.storage?.unused.map((v) => <ErrorNote key={v.id}>The volume {v.name} is unused {v.usedAt ? `since ${when(v.usedAt)}` : "since Afflatus first saw it"}: {usd(v.perMonth)} a month for nothing. Delete it under Network volumes if you will not deploy on it soon.</ErrorNote>)}
          {spending.isError && <ErrorNote>{spending.error.message}</ErrorNote>}
          {(Object.keys(notSaved) as CapKey[]).map((key) => <ErrorNote key={key}>{`The ${key} cap was not saved (still ${caps[key] ? usd(caps[key]) : "none"}): ${notSaved[key]}`}</ErrorNote>)}
        </Block>
      )}
    </Card>
  );
}

/** Past this many pods each is one line, its facts left to its card: a long list of two-line pods is a long way down. */
const SHORT_PAST = 6;

/**
 * Every pod of the account, made here or on RunPod's site, read again while the tab is open: running ones first, the
 * list's head adding them up. A pod that is a machine says its state and cost, how it ends, and has Open ComfyUI (logged
 * in, a one-time code), Start or Stop, and its card; one that is not has Add. A running pod that is not a machine is
 * said: it bills, and nothing here stops it.
 */
function RunpodPods() {
  const client = useQueryClient();
  const pods = useQuery({ queryKey: queryKeys.runpodPods(), queryFn: ({ signal }) => api.runpodPods({ signal }), refetchInterval: 15_000, staleTime: 10_000, retry: false });
  const add = useMutation({
    mutationFn: (pod: string) => api.addRunpodPod(pod),
    onSuccess: () => {
      for (const queryKey of [queryKeys.settings(), queryKeys.runpodPods(), queryKeys.queue(), queryKeys.machines()]) void client.invalidateQueries({ queryKey });
    },
  });
  const machines = useSettings().data?.machines ?? [];
  const states = useQueue().data?.machines ?? [];
  const ops = useRentedOps();
  const openComfy = useOpenComfyUI();
  // the volumes' names (the Network volumes card reads them on this tab too)
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), staleTime: 30_000, retry: false });
  // a machine's state is the queue's, live; RunPod's list is read every 15 s and runs behind a pod just started or stopped
  const live = (p: RunpodPod) => {
    const r = p.added ? states.find((m) => m.id === p.added)?.rented : undefined;
    return { status: r?.status ?? p.status, rate: r?.rate ?? p.cost };
  };
  // a pod is a machine as soon as the settings say so (podsAdded); running first, then the others as RunPod lists them
  const list = podsAdded(pods.data?.pods ?? [], machines).sort((a, b) => Number(live(b).status === "RUNNING") - Number(live(a).status === "RUNNING"));
  const running = list.filter((p) => live(p).status === "RUNNING");
  const stopped = list.filter((p) => live(p).status === "EXITED").length;
  const perHour = running.reduce((n, p) => n + (live(p).rate ?? 0), 0);
  const short = list.length > SHORT_PAST;
  return (
    <Card
      title="Your pods"
      setting="rented.pods"
      help="Every pod of the account, made here or on RunPod's site. Add makes one a machine, as it is (its card is in Settings › ComfyUI): Afflatus starts it only when you press Start. A pod must expose ComfyUI's port, 8188, over HTTP to be added."
      status={(
        <span className="flex items-center gap-3">
          {list.length > 0 && (
            <span className="text-[12.5px] text-ink-2">
              {running.length > 0 && <><span className="font-semibold text-good">{running.length} running</span> · <span className="font-mono">{usd(perHour)}</span>/h</>}
              {running.length > 0 && stopped > 0 && " · "}
              {stopped > 0 && `${stopped} stopped`}
            </span>
          )}
          <Button size="sm" tone="primary" onClick={() => openDeploy()}>Deploy a GPU…</Button>
        </span>
      )}
    >
      {pods.isError && <Block><ErrorNote>{pods.error.message}</ErrorNote></Block>}
      {pods.isSuccess && !list.length && <Block><span className="text-xs text-ink-2">No pods on this account. Deploy a GPU, or make one on RunPod (a ComfyUI template, port 8188 exposed): then it shows here.</span></Block>}
      {list.map((p) => {
        const { status, rate } = live(p);
        const isRunning = status === "RUNNING";
        const machine = p.added ? machines.find((m) => m.id === p.added) : undefined;
        const state = p.added ? states.find((m) => m.id === p.added) : undefined;
        const r = state?.rented;
        // running and not a machine: billed, with no idle, cap or watchdog of Afflatus's on it
        const loose = isRunning && !p.added;
        const said = loose ? `running, not in Afflatus: billed, nothing here stops it${p.comfy ? "" : " · port 8188 not exposed"}`
          : !p.added && !p.comfy ? "ComfyUI not exposed: add port 8188 (HTTP) on RunPod"
          : !p.added ? (status === "EXITED" ? "stopped" : status.toLowerCase()) : null;
        // a pod that never stops when idle bills until it is stopped by hand: said in the warning tone
        const ends = machine?.rented ? <span key="ends" className={machine.rented.idleMinutes ? undefined : "text-warn-ink"}>{idleEndSaid(machine.rented)}</span> : null;
        const volume = p.volumeId ? volumes.data?.volumes.find((v) => v.id === p.volumeId) : undefined;
        // its rate with the same tip as its card's: the GPU and its disk, as RunPod bills them (a pod not added has only its total)
        const facts = [
          p.gpu ? shortGpu(p.gpu) : null,
          rate ? <span key="rate" data-tip={(r && rateParts(r)) ?? undefined}>{usd(rate)}/h</span> : null,
          p.dataCenter,
          p.volumeId ? `on ${volume ? volume.name : "a network volume"}` : null,
          ends,
        ].filter(Boolean).flatMap((x, k) => (k ? [" · ", x] : [x]));
        return (
          <div key={p.id} className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 px-[18px] py-3", !p.added && !p.comfy && !loose && "opacity-60")}>
            <span className="flex min-w-0 grow basis-[260px] flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", loose || r?.boot?.failed ? "bg-warn" : r?.booting ? STARTING_DOT : isRunning ? "bg-good" : "border-[1.5px] border-ink-3")} />
                <span className="truncate text-[13.5px] font-semibold">{machine ? machine.name || p.name : p.name}</span>
                {said && <span className={cx("min-w-0 truncate text-[12.5px]", loose ? "text-warn-ink" : "text-ink-3")}>· {said}</span>}
              </span>
              {!short && facts.length > 0 && <span className="truncate pl-[15px] text-xs text-ink-3">{facts}</span>}
              {/* a deployed pod's first start: the second line its card and the pill's popover say */}
              {machine && r?.booting && r.boot && !r.error && <BootNote machine={machine.id} boot={r.boot} className="pl-[15px] text-xs" />}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {machine && state && <RentedHead machine={machine} state={state} ops={ops} />}
              {/* its ComfyUI, logged in: once it runs and answers */}
              {machine && r?.status === "RUNNING" && !r.booting && r.answers !== false && <Button size="sm" onClick={() => openComfy.mutate(machine.id)} disabled={openComfy.isPending}>Open ComfyUI <ExternalLink size={12} /></Button>}
              {p.added
                ? <Link href={`/settings?machine=${encodeURIComponent(p.added)}`} className="text-[12.5px] font-semibold text-ink-2 hover:text-ink">Its card ›</Link>
                : p.comfy && <Button size="sm" tone="primary" onClick={() => add.mutate(p.id)} disabled={add.isPending}>Add</Button>}
            </span>
          </div>
        );
      })}
      {add.isError && <Block><ErrorNote>{add.error.message}</ErrorNote></Block>}
    </Card>
  );
}


/** One choice of the next deploy, as a small box: what it is, the choice, a line under it. */
function Choice({ what, children, sub, tone }: { what: string; children: ReactNode; sub?: ReactNode; tone?: "good" | "warn" }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-raised px-3 py-2.5">
      <span className="text-[11.5px] font-semibold text-ink-3">{what}</span>
      <span className={cx("truncate text-[13px] font-semibold", tone === "good" ? "text-good" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{children}</span>
      {sub && <span className="text-[11.5px] text-ink-2">{sub}</span>}
    </span>
  );
}

/**
 * Next deploy: what the Deploy dialog opens with and Deploy again repeats, as five small boxes (GPU, image, models, disk,
 * when done). Change… opens the dialog, which saves its choices on a deploy, or with "Save as next deploy".
 */
function NextDeploy() {
  const settings = useSettings();
  const next = settings.data?.lastDeploy ?? null;
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), staleTime: 60_000, retry: false, enabled: Boolean(next?.volume) });
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }), enabled: Boolean(next?.set) });
  const volume = next?.volume ? volumes.data?.volumes.find((v) => v.id === next.volume) : null;
  return (
    <Card title="Next deploy" setting="rented.next" help="What Deploy a GPU opens with, and what Deploy again does: the last deploy's choices, or the ones saved with “Save as next deploy”. Its models are what each waiting job needs, fetched onto the pod from Civitai or Hugging Face (or sent from this PC when no site has the file), in the order the jobs need them; a Model set adds its files ahead." status={<Button size="sm" onClick={() => openDeploy()}>Change…</Button>}>
      {!next && <Block><span className="text-xs text-ink-2">Nothing yet: the first deploy's choices are kept here.</span></Block>}
      {next && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 px-[18px] py-3.5">
          <Choice what="GPU" sub={`${next.cloud === "SECURE" ? "Secure" : "Community"} Cloud`}>{shortGpu(next.gpu)}</Choice>
          <Choice what="Image" tone={next.template === "afflatus" ? "good" : "warn"} sub={next.template === "afflatus" ? "locked from its start" : "not locked"}>{next.template === "afflatus" ? "Afflatus" : "RunPod's ComfyUI"}</Choice>
          <Choice what="Models" sub={next.set ? `+ ${sets.data?.items.find((x) => x.id === next.set)?.name ?? "a set since deleted"} ahead` : "no set ahead"}>What each job needs</Choice>
          <Choice what="Disk" tone={volume?.usedBy ? "warn" : undefined} sub={!next.volume ? "models fetched each deploy" : volume ? `${volume.dataCenter} · its GPUs only${volume.usedBy ? ` · in use by ${volume.usedBy.name}` : ""}` : undefined}>
            {!next.volume ? `Its own, ${next.disk} GB` : volume ? volume.name : volumes.isSuccess ? "A volume since deleted" : "A network volume"}
          </Choice>
          {/* 0 minutes: it never stops when idle, and bills until stopped by hand (never "after never idle") */}
          <Choice what="When done" tone={next.idleMinutes ? undefined : "warn"} sub={`${next.idleMinutes ? `after ${minutesSaid(next.idleMinutes)} idle` : "when idle: billed until you stop it"} · watchdog ${next.watchdogMinutes ? minutesSaid(next.watchdogMinutes) : "off"}`}>{!next.idleMinutes ? "Never stops" : next.idleDo === "stop" ? "Stop" : "Terminate"}</Choice>
        </div>
      )}
    </Card>
  );
}

/** Settings › Rented GPUs: what is on RunPod on the left (the pods, the volumes), the account and the next deploy on the right. */
export function RentedTab() {
  const has = Boolean(useSettings().data?.hasRunpodKey);
  return (
    <div className={COLUMNS}>
      {has && <div className="flex min-w-0 flex-col gap-4"><RunpodPods /><VolumesCard /></div>}
      <div className="flex min-w-0 flex-col gap-4"><RunpodAccount />{has && <NextDeploy />}</div>
    </div>
  );
}
