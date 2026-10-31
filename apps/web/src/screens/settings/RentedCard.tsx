import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shortGpu, SETTING_HELP } from "@afflatus/core";
import { Link } from "wouter";
import { api, type RunpodPod } from "../../api";
import { useQueue, useSettings } from "../../data";
import { useOpenComfyUI } from "../../actions";
import { useRentedOps } from "../../rentedOps";
import { RentedHead } from "./RentedRows";
import { minutesSaid, plural, usd, when } from "../../format";
import { Select } from "../../Select";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, Checkbox, cx, ErrorNote, Failed, fieldClass, Help } from "../../ui";
import { runwayNowSaid, runwaySaid, runwayWhy } from "../queue/costsView";
import { Block, Card, CardLoading, Row } from "./Rows";
import { settingHref, tabHref } from "./settingsIndex";
import { COLUMNS } from "./wide";
import { capAmount, capRefusal } from "./capAmount";
import { useCapsSave } from "../../rentCaps";
import { openDeploy } from "../../deploy";
import { idleEndSaid, podsAdded, rateParts } from "../../machines";
import { BootNote, STARTING_DOT } from "../../machineBits";
import { VolumesCard } from "./VolumesCard";
import { SecretField } from "./SecretField";

/** The days after which a volume no pod ran on is flagged; 0: never. */
const UNUSED_DAYS = [3, 7, 14, 30, 0];
/** How long a pod's boot log may be kept, once kept at all. */
const BOOT_LOG_DAYS = [3, 7, 14, 30, 90];

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
      {saveKey.isError && <Block><Failed what="Key not saved" error={saveKey.error} /></Block>}
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
  const make = <a href="https://console.runpod.io/user/credentials" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-body font-semibold text-ink-2 hover:text-ink">Make one <ExternalLink size={12} /></a>;
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
      {save.isError && <Block><Failed what="S3 key not saved" error={save.error} /></Block>}
    </>
  );
}

/**
 * "Or a RunPod pod", under "Add a ComfyUI": the key's state and the way to Settings › Rented GPUs, where the key is typed
 * and the account's pods are added (card #168: the key was typed here, and the tab only came once it was).
 */
export function RentRow() {
  const settings = useSettings();
  const running = useQueue().data?.machines.filter((m) => m.rented?.status === "RUNNING").length ?? 0;
  if (!settings.data) return <CardLoading />;
  return (
    <Row setting="comfy.runpod" label="Or a RunPod pod" help={WHY_RUNPOD}>
      <span className="grow text-xs text-ink-2">{settings.data.hasRunpodKey ? `key saved${running ? ` · ${plural(running, "pod")} running` : ""}` : "no RunPod key yet"}</span>
      <Link href={tabHref("rented")} className="text-body font-semibold hover:underline">Rented GPUs ›</Link>
    </Row>
  );
}

/** What each cap weighs: the day's is compute alone, the month's everything RunPod bills (rented.ts spent says the same). */
export const CAP_DAY_WHY = "Compute only: what your pods cost today while they run, their GPU and their disk. A stopped pod's disk and the network volumes are not in it: they bill whether anything runs or not, and the month cap has them.";
const BOOT_LOGS_WHY = SETTING_HELP.bootLogDays;
export const CAP_MONTH_WHY = "Everything RunPod bills this month: the pods, the disks of stopped pods and the network volumes. At it the pods stop, and Start, Deploy, Make volume and Grow are refused.";

/** A figure against its cap, in a few words: "$1.18 of $5", or the figure alone without a cap. */
const against = (value: number, cap: number) => `${usd(value, true)}${cap > 0 ? ` of ${usd(cap)}` : ""}`;

/** The caps as RunPod account says them: "$10 a day · $60 a month", or none. */
const capsSaid = (caps: { day: number; month: number }) =>
  [caps.day > 0 && `${usd(caps.day)} a day`, caps.month > 0 && `${usd(caps.month)} a month`].filter(Boolean).join(" · ") || "none: no cap";

/**
 * A cap in US dollars: a small box, saved when it is left. Empty: no cap (a typed 0 or € is refused, and said). Its parent remounts it (a new `key`, useCapsSave
 * resets) when a save of it failed, so that it shows the cap as saved again rather than the amount typed, which is not in force. Its "?"
 * says what it weighs: the two caps do not weigh the same bill.
 */
export function CapBox({ label, value, help, onSave }: { label: string; value: number; help: string; onSave(v: number): void }) {
  const [text, setText] = useState(value ? String(value) : "");
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    // empty: no cap; anything that does not read as one amount for sure keeps the cap as it was (never a cap silently gone),
    // and says so: a "0" or a "€50" put back without a word would read as taken
    const n = capAmount(text);
    if (n === null || !Number.isFinite(n)) {
      setRefused(`"${text.trim()}" not taken: ${capRefusal(text)}`);
      setText(value ? String(value) : "");
      return;
    }
    setRefused(null);
    if (n !== value) onSave(n);
  };
  // its "?" beside the label, not in it: a click on it never lands in the box
  return (
    <span className="flex items-center gap-1">
      <label className="flex items-center gap-1.5 text-body">
        <span className="text-ink-2">{label}</span>
        <span className="text-ink-3">$</span>
        <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} inputMode="decimal" placeholder="no cap" aria-label={`Cap ${label}`} className={cx("h-8 w-[68px] font-mono text-xs", fieldClass)} />
      </label>
      <Help text={help} title={`Cap ${label}`} />
      {refused && <span role="status" className="text-xs text-warn-ink">{refused}</span>}
    </span>
  );
}

/**
 * Settings › Costs › Spending caps (card #168: they were the RunPod account's): the day's and the month's, with today and
 * this month under them, and the way to an agent's own cap. Set before a RunPod key too: they hold from the first deploy.
 */
export function CapsCard() {
  const settings = useSettings();
  const has = Boolean(settings.data?.hasRunpodKey);
  const any = has || (settings.data?.machines.some((m) => m.rented) ?? false);
  const spending = useQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), enabled: any, staleTime: 60_000 });
  const s = spending.data?.spending;
  // the caps as saved (written in at once on a save), not as the spending read some seconds ago: two edits in a row each keep the other
  const caps = settings.data?.rentCaps ?? s?.caps ?? { day: 0, month: 0 };
  const capsSave = useCapsSave(caps);
  return (
    <Card title="Spending caps">
      {/* today and this month under the caps, which they are weighed against */}
      <Row setting="comfy.rentcaps" label="Rented GPUs" sub={s ? `today ${against(s.today, caps.day)} · this month ${against(s.month, caps.month)}` : has ? undefined : "no RunPod key yet: they hold from the first deploy"} help={SETTING_HELP.rentCaps}>
        <CapBox key={`day-${capsSave.resets.day}`} label="a day" value={caps.day} help={CAP_DAY_WHY} onSave={(day) => capsSave.change("day", day)} />
        <CapBox key={`month-${capsSave.resets.month}`} label="a month" value={caps.month} help={CAP_MONTH_WHY} onSave={(month) => capsSave.change("month", month)} />
      </Row>
      <Row label="An agent's own cap" help="Each MCP token with Spend has its own month cap, under these: set on its line in Settings › Agents (MCP).">
        <span className="grow text-xs text-ink-2">set per token</span>
        <Link href={tabHref("agents")} className="shrink-0 text-body font-semibold hover:underline">Agents (MCP) ›</Link>
      </Row>
      {(spending.isError || capsSave.notes.length > 0) && (
        <Block>
          {spending.isError && <Failed what="Today's and this month's spending could not be read" error={spending.error} />}
          {capsSave.notes.map((n) => <ErrorNote key={n.key}>{n.text}</ErrorNote>)}
        </Block>
      )}
    </Card>
  );
}

/**
 * The RunPod account: its key first, always shown (card #168), its balance and how long it lasts, the caps' state (set in
 * Settings › Costs), the S3 key, when a volume counts as unused and the boot logs. The spending itself (the month, the day,
 * where it went) is Queue › Costs's.
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
  const sayFailed = useSayFailed({ href: "/settings/rented", go: "Open Settings › Rented GPUs" });
  const saveUnused = useMutation({
    mutationFn: (volumeUnusedDays: number) => api.saveSettings({ volumeUnusedDays }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      for (const queryKey of [queryKeys.rentedSpending(), queryKeys.runpodVolumes()]) void client.invalidateQueries({ queryKey });
    },
    onError: sayFailed("The unused volumes' days were not saved"),
  });
  const saveBootLogs = useMutation({
    mutationFn: (bootLogDays: number) => api.saveSettings({ bootLogDays }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
    onError: sayFailed("The boot logs' setting was not saved"),
  });
  const bootLogDays = settings.data?.bootLogDays ?? 0;
  const s = spending.data?.spending;
  const now = s ? runwayNowSaid({ spendPerHr: s.spendPerHr, runwayNowMs: s.runwayMs, perDay: s.perDay.pods + s.perDay.storage }) : null;
  const caps = settings.data?.rentCaps ?? s?.caps ?? { day: 0, month: 0 };
  return (
    <Card
      title="RunPod account"
      help="What your rented pods cost, every pod of the account, its GPU and its disk: RunPod's own bill. RunPod writes it some hours after the fact, so the last hours are Afflatus's count (each pod's time × its rate, from its deploy), the higher of the two while a pod runs, so that a cap is never reached late. A network volume is billed apart, every month: it counts in the month cap, not the day's. The balance lasts at this pace (the pods' last 7 days and storage), and at what the account spends now while a pod runs: at zero RunPod stops every pod, and a render that would end after it is not sent to a rented pod."
      status={(
        <span className="flex items-center gap-3 text-body">
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
          <Link href="/queue?view=costs" className="font-semibold text-ink-2 hover:text-ink">Queue › Costs</Link>
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
      {/* the caps are set in Costs, beside the electricity (card #168): their state here, and the way there */}
      <Row setting="rented.caps" label="Spending caps" help={SETTING_HELP.rentCaps}>
        <span className="grow text-xs text-ink-2">{capsSaid(caps)}</span>
        <Link href={settingHref("comfy.rentcaps")} className="shrink-0 text-body font-semibold hover:underline">Costs ›</Link>
      </Row>
      <S3Key />
      <Row setting="rented.unused" label="Unused volumes" help={SETTING_HELP.volumeUnusedDays}>
        <span className="w-[120px]"><Select size="sm" label="Flag a volume unused after" value={String(settings.data?.volumeUnusedDays ?? 7)} onChange={(v) => !saveUnused.isPending && saveUnused.mutate(Number(v))} options={UNUSED_DAYS.map((n) => ({ value: String(n), label: n ? `after ${plural(n, "day")}` : "never" }))} /></span>
      </Row>
      <Row setting="rented.bootlogs" label="Boot logs" help={BOOT_LOGS_WHY}>
        <span className="flex items-center gap-2">
          <Checkbox checked={bootLogDays > 0} onChange={(on) => !saveBootLogs.isPending && saveBootLogs.mutate(on ? 14 : 0)}>Keep each deploy's boot log</Checkbox>
          {bootLogDays > 0 && <span className="w-[120px]"><Select size="sm" label="Keep boot logs for" value={String(bootLogDays)} onChange={(v) => !saveBootLogs.isPending && saveBootLogs.mutate(Number(v))} options={[...new Set([...BOOT_LOG_DAYS, bootLogDays])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `for ${plural(n, "day")}` }))} /></span>}
        </span>
      </Row>
      {(s?.lowBalance || spending.isError || Boolean(s?.storage?.unused.length) || Boolean(s?.storage?.stoppedDisks)) && (
        <Block>
          {s?.lowBalance && <ErrorNote>Your RunPod balance is low: RunPod stops pods at zero, and may delete their disks after a while.</ErrorNote>}
          {Boolean(s?.storage?.stoppedDisks) && <ErrorNote>{s!.storage!.stoppedDisks === 1 ? "1 stopped pod with a disk: billed while it waits. Terminate it if you will not start it again." : `${s!.storage!.stoppedDisks} stopped pods with a disk: billed while they wait. Terminate them if you will not start them again.`}</ErrorNote>}
          {s?.storage?.unused.map((v) => <ErrorNote key={v.id}>The volume {v.name} is unused {v.usedAt ? `since ${when(v.usedAt)}` : "since Afflatus first saw it"}: {usd(v.perMonth)} a month for nothing. Delete it under Network volumes if you will not deploy on it soon.</ErrorNote>)}
          {spending.isError && <Failed what="Spending not loaded" error={spending.error} />}
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
  // shown before a RunPod key too (card #168), with a line in place of the list: nothing is asked of RunPod until then
  const has = Boolean(useSettings().data?.hasRunpodKey);
  const pods = useQuery({ queryKey: queryKeys.runpodPods(), queryFn: ({ signal }) => api.runpodPods({ signal }), refetchInterval: 15_000, staleTime: 10_000, retry: false, enabled: has });
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
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), staleTime: 30_000, retry: false, enabled: has });
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
            <span className="text-body text-ink-2">
              {running.length > 0 && <><span className="font-semibold text-good">{running.length} running</span> · <span className="font-mono">{usd(perHour)}</span>/h</>}
              {running.length > 0 && stopped > 0 && " · "}
              {stopped > 0 && `${stopped} stopped`}
            </span>
          )}
          <Button size="sm" tone="primary" onClick={() => openDeploy()} disabled={!has} data-tip={has ? undefined : "Save the RunPod API key first (RunPod account, on this tab)"}>Deploy a GPU…</Button>
        </span>
      )}
    >
      {!has && <Block><span className="text-xs text-ink-2">Your pods on RunPod show here once the API key is saved (RunPod account, on this tab).</span></Block>}
      {pods.isError && <Block><Failed what="Pods not loaded" error={pods.error} /></Block>}
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
          <div key={p.id} className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 px-gutter py-3", !p.added && !p.comfy && !loose && "opacity-60")}>
            <span className="flex min-w-0 grow basis-[260px] flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", loose || r?.boot?.failed ? "bg-warn" : r?.booting ? STARTING_DOT : isRunning ? "bg-good" : "border-[1.5px] border-ink-3")} />
                <span className="truncate text-title font-semibold">{machine ? machine.name || p.name : p.name}</span>
                {said && <span className={cx("min-w-0 truncate text-body", loose ? "text-warn-ink" : "text-ink-3")}>· {said}</span>}
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
                ? <Link href={`/settings?machine=${encodeURIComponent(p.added)}`} className="text-body font-semibold text-ink-2 hover:text-ink">Its card ›</Link>
                : // plain: Deploy above is the card's one coral action (a pod list of three had three coral buttons)
                  p.comfy && <Button size="sm" onClick={() => add.mutate(p.id)} disabled={add.isPending}>Add</Button>}
            </span>
          </div>
        );
      })}
      {add.isError && <Block><Failed what="Pod not added" error={add.error} /></Block>}
    </Card>
  );
}


/** One choice of the next deploy, as a small box: what it is, the choice, a line under it. */
function Choice({ what, children, sub, tone }: { what: string; children: ReactNode; sub?: ReactNode; tone?: "good" | "warn" }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 rounded-control bg-raised px-3 py-2.5">
      <span className="text-meta font-semibold text-ink-3">{what}</span>
      <span className={cx("truncate text-body font-semibold", tone === "good" ? "text-good" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{children}</span>
      {sub && <span className="text-meta text-ink-2">{sub}</span>}
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
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 px-gutter py-3.5">
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

/**
 * Settings › Rented GPUs, always a tab (card #168: it only came once a RunPod key was saved): the account, its key first,
 * and the next deploy on the left; what is on RunPod on the right (the pods, the volumes), each with a line until there is
 * a key. One column under 1600 px, the key on top.
 */
export function RentedTab() {
  return (
    <div className={COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4"><RunpodAccount /><NextDeploy /></div>
      <div className="flex min-w-0 flex-col gap-4"><RunpodPods /><VolumesCard /></div>
    </div>
  );
}
