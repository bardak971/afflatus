import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { api } from "../../api";
import { useQueue, useSettings } from "../../data";
import { usd } from "../../format";
import { queryKeys } from "../../queryKeys";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card, Row } from "./Rows";
import { tabHref } from "./settingsIndex";
import { COLUMNS } from "./wide";

const WHY_RUNPOD = "A pod you made on RunPod, added as a machine: Afflatus reads its state there, starts it only when you press Start, and stops it when it sits idle, at a spending cap, or (with the Afflatus node pack on it) when this PC goes silent. The key is a RunPod API key (RunPod › Settings › API Keys); it stays in Afflatus, never shown again. The pod must expose ComfyUI's port, 8188, over HTTP.";

/** The RunPod API key typed in and saved: written once, never shown again. */
function RunpodKey({ setting, label, onSaved, onCancel }: { setting: string; label: string; onSaved?(): void; onCancel?(): void }) {
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const saveKey = useMutation({
    mutationFn: () => api.saveSettings({ runpodKey: key.trim() }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      setKey("");
      for (const queryKey of [queryKeys.runpodPods(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
      onSaved?.();
    },
  });
  return (
    <>
      <Row setting={setting} label={label} htmlFor="runpod-key" help={WHY_RUNPOD}>
        <input id="runpod-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your RunPod API key" spellCheck={false} autoComplete="off" className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={() => saveKey.mutate()} disabled={key.trim().length < 10 || saveKey.isPending}>Save</Button>
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
  const any = settings.data?.machines.some((m) => m.rented) ?? false;
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
  const s = spending.data?.spending;
  // the caps as saved (written in at once on a save), not as the spending read some seconds ago: two edits in a row each keep the other
  const caps = settings.data?.rentCaps ?? s?.caps ?? { day: 0, month: 0 };
  return (
    <Card
      title="RunPod"
      help="What your rented pods cost: each one's running time × its rate, as Afflatus counts it (RunPod's bill is the reference). A stopped pod's disk is billed too, and is not in these figures: its card says what it costs a day."
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
      {s && <Row label="Today"><Against value={s.today} cap={caps.day} sub="every pod's GPU time" /></Row>}
      {s && <Row label="This month"><Against value={s.month} cap={caps.month} /></Row>}
      {has && (
        <Row setting="comfy.rentcaps" label="Caps" help="At a cap, the render running finishes, then the pods stop; what waits goes to your other machines, and Start says the cap is reached. Empty: no cap.">
          <CapBox label="a day" value={caps.day} onSave={(day) => saveCaps.mutate({ ...caps, day })} />
          <CapBox label="a month" value={caps.month} onSave={(month) => saveCaps.mutate({ ...caps, month })} />
        </Row>
      )}
      {(s?.lowBalance || spending.isError || saveCaps.isError) && (
        <Block>
          {s?.lowBalance && <ErrorNote>Your RunPod balance is low: RunPod stops pods at zero, and may delete their disks after a while.</ErrorNote>}
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
    <Card title="Your pods on RunPod" setting="rented.pods" help="Every pod of the account, made here or on RunPod's site. Add makes one a machine, as it is (its card is in Settings › ComfyUI): Afflatus starts it only when you press Start. A pod must expose ComfyUI's port, 8188, over HTTP to be added.">
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

/** Settings › Rented GPUs: the RunPod account beside its pods, side by side in a wide window. */
export function RentedTab() {
  const has = Boolean(useSettings().data?.hasRunpodKey);
  return (
    <div className={COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4"><RunpodAccount /></div>
      <div className="flex min-w-0 flex-col gap-4">{has && <RunpodPods />}</div>
    </div>
  );
}
