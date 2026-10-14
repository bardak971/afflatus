import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { api } from "../../api";
import { useQueue, useSettings } from "../../data";
import { est, plural, usd, when } from "../../format";
import { Select } from "../../Select";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card, Row } from "./Rows";
import { tabHref } from "./settingsIndex";
import { COLUMNS } from "./wide";
import { openDeploy } from "../../deploy";
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

/** A figure against its cap: the amount, "of $5", a thin bar. */
function Against({ value, cap, sub }: { value: number; cap: number; sub?: string }) {
  const part = cap > 0 ? Math.min(1, value / cap) : 0;
  return (
    <span className="flex min-w-0 grow flex-col gap-1.5">
      <span className="text-[12.5px]"><span className="font-semibold">{usd(value, true)}</span>{cap > 0 && <span className="text-ink-2"> of {usd(cap)}</span>}{sub && <span className="text-ink-3"> · {sub}</span>}</span>
      {cap > 0 && <span className="h-[5px] max-w-[320px] overflow-hidden rounded-[3px] bg-line-strong"><span className={cx("block h-full rounded-[3px]", part >= 1 ? "bg-warn" : "bg-accent")} style={{ width: `${part * 100}%` }} /></span>}
    </span>
  );
}

/** A cap in dollars: a small box, saved when it is left. Empty or 0: no cap. */
function CapBox({ label, value, onSave }: { label: string; value: number; onSave(v: number): void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    const cleaned = text.replace(/[$€\s]/g, "").replace(",", ".");
    // empty: no cap; anything that does not read as an amount keeps the cap as it was (never a cap silently gone)
    const n = cleaned === "" ? 0 : Number(cleaned);
    if (!Number.isFinite(n) || n < 0) {
      setText(value ? String(value) : "");
      return;
    }
    if (n !== value) onSave(n);
  };
  return (
    <label className="flex items-center gap-1.5 text-[12.5px]">
      <span className="text-ink-2">{label}</span>
      <span className="text-ink-3">$</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} inputMode="decimal" placeholder="none" aria-label={`Cap ${label}`} className={cx("h-8 w-[68px] font-mono text-xs", fieldClass)} />
    </label>
  );
}

/**
 * The RunPod account: its key, its balance, today and this month against the caps, and the caps themselves. The figures
 * are Afflatus's (each pod's time × its rate), counted once a pod is a machine; RunPod's bill is the reference.
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
  // the caps as saved (written in at once on a save), not as the spending read some seconds ago: two edits in a row each keep the other
  const caps = settings.data?.rentCaps ?? s?.caps ?? { day: 0, month: 0 };
  // each edit made on the caps as the edits before it left them, and sent after them: a second edit within one round trip
  // never brings the first one's old value back (a cap is money)
  const latestCaps = useRef<{ day: number; month: number } | null>(null);
  const capsQueue = useRef<Promise<unknown>>(Promise.resolve());
  const changeCaps = (change: Partial<{ day: number; month: number }>) => {
    const next = { ...(latestCaps.current ?? caps), ...change };
    latestCaps.current = next;
    capsQueue.current = capsQueue.current
      .then(() => saveCaps.mutateAsync(next))
      .catch(() => {})
      .finally(() => {
        if (latestCaps.current === next) latestCaps.current = null;
      });
  };
  return (
    <Card
      title="RunPod"
      help="What your rented pods cost, every pod of the account, its GPU and its disk: RunPod's own bill. RunPod writes it some hours after the fact, so the last hours are Afflatus's count (each pod's time × its rate, from its deploy), the higher of the two while a pod runs, so that a cap is never reached late. A network volume is billed apart, every month."
      status={s && s.balance !== null ? <span className={cx("text-[12.5px]", s.lowBalance ? "font-semibold text-warn-ink" : "text-ink-2")}>balance <span className="font-mono">{usd(s.balance)}</span></span> : undefined}
    >
      {!has || changing
        ? <RunpodKey setting="rented.key" label="API key" onSaved={() => setChanging(false)} onCancel={changing ? () => setChanging(false) : undefined} />
        : (
          <Row setting="rented.key" label="API key" help={WHY_RUNPOD}>
            <span className="grow text-xs text-ink-2">set · kept in Afflatus, never shown again</span>
            <Button size="sm" tone="quiet" onClick={() => setChanging(true)}>Change key</Button>
          </Row>
        )}
      {s && <Row label="Today"><Against value={s.today} cap={caps.day} sub={s.billed ? "RunPod's bill, the last hours counted here" : "counted here (RunPod's bill not read)"} /></Row>}
      {s && <Row label="This month"><Against value={s.month} cap={caps.month} /></Row>}
      {s?.storage && (s.storage.volumes > 0 || s.storage.stoppedDisks > 0 || s.storage.disksMonth > 0) && (
        <Row label="Storage" help="What keeping models costs: the network volumes (billed every month, pod or not) and the pods' own disks (a stopped pod's disk still bills, at $0.20 per GB a month). The disks are in the figures above, RunPod billing them with their pod; the volumes are not. A cap stops pods, never storage: only deleting a volume, or terminating a stopped pod, ends it.">
          <span className="text-[12.5px] text-ink-2">
            {s.storage.volumesMonth !== null && <><span className="font-semibold text-ink">{usd(s.storage.volumesMonth, true)}</span> for {plural(s.storage.volumes, "volume")} this month · </>}
            {s.storage.disksMonth > 0 && <>{usd(s.storage.disksMonth, true)} of disks in the month above · </>}
            ~{usd(s.storage.perMonth)} a month as it stands{s.storage.stoppedDisks > 0 && <span className="text-warn-ink"> · {plural(s.storage.stoppedDisks, "stopped pod")} with a disk, billed while it waits</span>}
          </span>
        </Row>
      )}
      {s && s.runwayMs !== null && s.spendPerHr !== null && (
        <Row label="Balance lasts" help="At what the account spends now on RunPod (every pod and volume): at zero RunPod stops every pod, and terminates those without a volume. A render that would end after it is not sent to a rented pod.">
          <span className={cx("text-[12.5px]", s.runwayMs < 3_600_000 ? "font-semibold text-warn-ink" : "text-ink-2")}>{est(s.runwayMs)} at {usd(s.spendPerHr)}/h</span>
        </Row>
      )}
      {has && (
        <Row setting="rented.unused" label="Unused volumes" help="A network volume no pod ran on for this long is flagged here and on the tab: it bills every month all the same.">
          <span className="w-[120px]"><Select size="sm" label="Flag a volume unused after" value={String(settings.data?.volumeUnusedDays ?? 7)} onChange={(v) => !saveUnused.isPending && saveUnused.mutate(Number(v))} options={UNUSED_DAYS.map((n) => ({ value: String(n), label: n ? `after ${plural(n, "day")}` : "never" }))} /></span>
        </Row>
      )}
      {has && (
        <Row setting="comfy.rentcaps" label="Caps" help="At a cap, the render running finishes, then the pods stop; what waits goes to your other machines, and Start says the cap is reached. Empty: no cap.">
          <CapBox label="a day" value={caps.day} onSave={(day) => changeCaps({ day })} />
          <CapBox label="a month" value={caps.month} onSave={(month) => changeCaps({ month })} />
        </Row>
      )}
      {(s?.lowBalance || spending.isError || saveCaps.isError || Boolean(s?.storage?.unused.length)) && (
        <Block>
          {s?.lowBalance && <ErrorNote>Your RunPod balance is low: RunPod stops pods at zero, and may delete their disks after a while.</ErrorNote>}
          {s?.storage?.unused.map((v) => <ErrorNote key={v.id}>The volume {v.name} is unused {v.usedAt ? `since ${when(v.usedAt)}` : "since Afflatus first saw it"}: {usd(v.perMonth)} a month for nothing. Delete it under Network volumes if you will not deploy on it soon.</ErrorNote>)}
          {spending.isError && <ErrorNote>{spending.error.message}</ErrorNote>}
          {saveCaps.isError && <ErrorNote>{saveCaps.error.message}</ErrorNote>}
        </Block>
      )}
    </Card>
  );
}

/**
 * Every pod of the account, made here or on RunPod's site, read again while the tab is open. Add makes one a machine; one
 * already a machine leads to its card. A running pod that is not a machine is said: it bills, and nothing here stops it.
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
  const list = pods.data?.pods ?? [];
  return (
    <Card title="Your pods on RunPod" setting="rented.pods" status={<Button size="sm" tone="primary" onClick={() => openDeploy()}>Deploy a GPU…</Button>} help="Every pod of the account, made here or on RunPod's site. Add makes one a machine, as it is (its card is in Settings › ComfyUI): Afflatus starts it only when you press Start. A pod must expose ComfyUI's port, 8188, over HTTP to be added.">
      {pods.isError && <Block><ErrorNote>{pods.error.message}</ErrorNote></Block>}
      {pods.isSuccess && !list.length && <Block><span className="text-xs text-ink-2">No pods on this account. Make one on RunPod (a ComfyUI template, port 8188 exposed), then it shows here.</span></Block>}
      {list.map((p) => {
        const running = p.status === "RUNNING";
        // running and not a machine: billed, with no idle, cap or watchdog of Afflatus's on it
        const loose = running && !p.added;
        const said = p.added ? `a machine · ${running ? "running" : p.status === "EXITED" ? "stopped" : p.status.toLowerCase()}`
          : loose ? `running, not in Afflatus: billed, nothing here stops it${p.comfy ? "" : " · port 8188 not exposed"}`
          : !p.comfy ? "ComfyUI not exposed: add port 8188 (HTTP) on RunPod"
          : p.status === "EXITED" ? "stopped" : p.status.toLowerCase();
        return (
          <div key={p.id} className={cx("grid grid-cols-[10px_minmax(0,1fr)_minmax(0,160px)_70px_84px] items-center gap-2.5 px-[18px] py-2 text-[12.5px]", !p.added && !p.comfy && !loose && "opacity-60")}>
            <span aria-hidden className={cx("size-[7px] rounded-full", loose ? "bg-warn" : running ? "bg-good" : "border-[1.5px] border-ink-3")} />
            <span className="min-w-0 truncate"><span className="font-semibold">{p.name}</span> <span className={loose ? "text-warn-ink" : "text-ink-3"}>· {said}</span></span>
            <span className="truncate text-ink-2">{[p.gpu?.replace(/^NVIDIA (GeForce )?/, ""), p.dataCenter].filter(Boolean).join(" · ")}</span>
            <span className="font-mono text-xs text-ink-2" data-tip={p.cost ? undefined : "RunPod says a pod's rate only while it runs"}>{p.cost ? `${usd(p.cost)}/h` : "—"}</span>
            {p.added
              ? <Link href={`/settings?machine=${encodeURIComponent(p.added)}`} className="justify-self-end text-[12.5px] font-semibold hover:underline">Its card ›</Link>
              : p.comfy ? <Button size="sm" tone="primary" onClick={() => add.mutate(p.id)} disabled={add.isPending}>Add</Button> : <span />}
          </div>
        );
      })}
      {add.isError && <Block><ErrorNote>{add.error.message}</ErrorNote></Block>}
    </Card>
  );
}

/** The choices the Deploy dialog opens with: a GPU name as RunPod lists it, without its maker's words. */
const gpuSaid = (id: string) => id.replace(/^NVIDIA (GeForce )?/, "");
const minutesSaid = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} min` : `${n / 60} h`);

/**
 * Next deploy: what the Deploy dialog opens with and Deploy again repeats, said in one place. Change… opens the dialog,
 * which saves its choices on a deploy, or with "Save as next deploy".
 */
function NextDeploy() {
  const settings = useSettings();
  const next = settings.data?.lastDeploy ?? null;
  const volumes = useQuery({ queryKey: queryKeys.runpodVolumes(), queryFn: ({ signal }) => api.runpodVolumes({ signal }), staleTime: 60_000, retry: false, enabled: Boolean(next?.volume) });
  const sets = useQuery({ queryKey: queryKeys.modelSets.all(), queryFn: ({ signal }) => api.modelSets({ signal }), enabled: Boolean(next?.set) });
  const volume = next?.volume ? volumes.data?.volumes.find((v) => v.id === next.volume) : null;
  return (
    <Card title="Next deploy" setting="rented.next" help="What Deploy a GPU opens with, and what Deploy again does: the last deploy's choices, or the ones saved with “Save as next deploy”." status={<Button size="sm" onClick={() => openDeploy()}>Change…</Button>}>
      {!next && <Block><span className="text-xs text-ink-2">Nothing yet: the first deploy's choices are kept here.</span></Block>}
      {next && (
        <>
          <Row label="GPU"><span className="text-[12.5px] text-ink-2"><b className="text-ink">{gpuSaid(next.gpu)}</b> · {next.cloud === "SECURE" ? "Secure" : "Community"} Cloud</span></Row>
          <Row label="Image"><span className="text-[12.5px] text-ink-2">{next.template === "afflatus" ? "Afflatus · locked" : "RunPod's ComfyUI · not locked"}</span></Row>
          <Row label="Model set"><span className="text-[12.5px] text-ink-2">{next.set ? sets.data?.items.find((x) => x.id === next.set)?.name ?? "a set since deleted" : "none: the waiting jobs' files only"}</span></Row>
          <Row label="Disk">
            <span className={cx("text-[12.5px]", volume?.usedBy ? "text-warn-ink" : "text-ink-2")}>
              {!next.volume ? `its own, ${next.disk} GB · models fetched at each deploy` : volume ? `${volume.name} · ${volume.dataCenter} · its GPUs only${volume.usedBy ? ` · in use by ${volume.usedBy.name} now` : ""}` : volumes.isSuccess ? "a volume since deleted: none" : "a network volume"}
            </span>
          </Row>
          <Row label="When done"><span className="text-[12.5px] text-ink-2">{next.idleDo === "stop" ? "Stop" : "Terminate"} it after {minutesSaid(next.idleMinutes)} idle · watchdog {next.watchdogMinutes ? minutesSaid(next.watchdogMinutes) : "off"}</span></Row>
        </>
      )}
    </Card>
  );
}

/** Settings › Rented GPUs: what is set once on the left (the account, the next deploy), what is on RunPod now on the right. */
export function RentedTab() {
  const has = Boolean(useSettings().data?.hasRunpodKey);
  return (
    <div className={COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4"><RunpodAccount />{has && <NextDeploy />}</div>
      <div className="flex min-w-0 flex-col gap-4">{has && <><RunpodPods /><VolumesCard /></>}</div>
    </div>
  );
}
