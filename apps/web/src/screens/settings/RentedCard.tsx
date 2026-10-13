import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { usd } from "../../format";
import { queryKeys } from "../../queryKeys";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block, Card, Row } from "./Rows";

const WHY_RUNPOD = "A pod you made on RunPod, added as a machine: Afflatus reads its state there, starts it only when you press Start, and stops it when it sits idle, at a spending cap, or (with the Afflatus node pack on it) when this PC goes silent. The key is a RunPod API key (RunPod › Settings › API Keys); it stays in Afflatus, never shown again. The pod must expose ComfyUI's port, 8188, over HTTP.";

/**
 * "Or a RunPod pod", under "Add a ComfyUI": the API key once, then the user's pods (read only) each with Add. Nothing is
 * started, stopped or made here.
 */
export function RunpodAdd() {
  const settings = useSettings();
  const client = useQueryClient();
  const has = Boolean(settings.data?.hasRunpodKey);
  const [key, setKey] = useState("");
  const [changing, setChanging] = useState(false);
  const saveKey = useMutation({
    mutationFn: () => api.saveSettings({ runpodKey: key.trim() }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      setKey("");
      setChanging(false);
      void client.invalidateQueries({ queryKey: queryKeys.runpodPods() });
    },
  });
  const pods = useQuery({ queryKey: queryKeys.runpodPods(), queryFn: ({ signal }) => api.runpodPods({ signal }), enabled: has && !changing, staleTime: 15_000, retry: false });
  const add = useMutation({
    mutationFn: (pod: string) => api.addRunpodPod(pod),
    onSuccess: () => {
      for (const queryKey of [queryKeys.settings(), queryKeys.runpodPods(), queryKeys.queue(), queryKeys.machines()]) void client.invalidateQueries({ queryKey });
    },
  });
  if (!has || changing) {
    return (
      <>
        <Row setting="comfy.runpod" label="Or a RunPod pod" htmlFor="runpod-key" help={WHY_RUNPOD}>
          <input id="runpod-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your RunPod API key" spellCheck={false} autoComplete="off" className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
          <Button onClick={() => saveKey.mutate()} disabled={key.trim().length < 10 || saveKey.isPending}>Save</Button>
          {changing && <Button tone="quiet" onClick={() => setChanging(false)}>Cancel</Button>}
        </Row>
        {saveKey.isError && <Block><ErrorNote>{saveKey.error.message}</ErrorNote></Block>}
      </>
    );
  }
  const list = pods.data?.pods ?? [];
  return (
    <>
      <Row setting="comfy.runpod" label="Or a RunPod pod" help={WHY_RUNPOD}>
        <span className="grow text-xs text-ink-2">Your pods on RunPod · the key reads them; nothing is started from here</span>
        <Button size="sm" tone="quiet" onClick={() => setChanging(true)}>Change key</Button>
      </Row>
      {pods.isError && <Block><ErrorNote>{pods.error.message}</ErrorNote></Block>}
      {pods.isSuccess && !list.length && <Block><span className="text-xs text-ink-2">No pods on this account. Make one on RunPod (a ComfyUI template, port 8188 exposed), then it shows here.</span></Block>}
      {list.map((p) => {
        const running = p.status === "RUNNING";
        const why = p.added ? "added already" : !p.comfy ? "ComfyUI not exposed: add port 8188 (HTTP) on RunPod" : null;
        return (
          <div key={p.id} className={cx("grid grid-cols-[10px_minmax(0,1fr)_minmax(0,160px)_70px_64px] items-center gap-2.5 border-t border-line/60 px-[18px] py-2 text-[12.5px]", why && "opacity-60")}>
            <span aria-hidden className={cx("size-[7px] rounded-full", running ? "bg-good" : "border-[1.5px] border-ink-3")} />
            <span className="min-w-0 truncate"><span className="font-semibold">{p.name}</span> <span className="text-ink-3">· {why ?? (running ? "running" : p.status === "EXITED" ? "stopped" : p.status.toLowerCase())}</span></span>
            <span className="truncate text-ink-2">{[p.gpu?.replace(/^NVIDIA (GeForce )?/, ""), p.dataCenter].filter(Boolean).join(" · ")}</span>
            <span className="font-mono text-xs text-ink-2">{p.cost ? `${usd(p.cost)}/h` : ""}</span>
            {!why ? <Button size="sm" tone="primary" onClick={() => add.mutate(p.id)} disabled={add.isPending}>Add</Button> : <span />}
          </div>
        );
      })}
      {add.isError && <Block><ErrorNote>{add.error.message}</ErrorNote></Block>}
    </>
  );
}

/** A figure against its cap: the amount, "of $5", a thin bar. */
function Against({ value, cap, sub }: { value: number; cap: number; sub?: string }) {
  const part = cap > 0 ? Math.min(1, value / cap) : 0;
  return (
    <span className="flex min-w-0 grow flex-col gap-1.5">
      <span className="text-[12.5px]"><span className="font-semibold">{usd(value)}</span>{cap > 0 && <span className="text-ink-2"> of {usd(cap)}</span>}{sub && <span className="text-ink-3"> · {sub}</span>}</span>
      {cap > 0 && <span className="h-[5px] max-w-[320px] overflow-hidden rounded-[3px] bg-line-strong"><span className={cx("block h-full rounded-[3px]", part >= 1 ? "bg-warn" : "bg-accent")} style={{ width: `${part * 100}%` }} /></span>}
    </span>
  );
}

/** A cap in dollars: a small box, saved when it is left. Empty or 0: no cap. */
function CapBox({ label, value, onSave }: { label: string; value: number; onSave(v: number): void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    const n = Math.max(0, Number(text.replace(/[$\s]/g, "")) || 0);
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
 * Rented GPUs, under the machines when one is a rented pod: today and this month against the caps, the caps themselves,
 * and RunPod's balance. The figures are Afflatus's (each pod's time × its rate); RunPod's bill is the reference.
 */
export function RentedCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const any = settings.data?.machines.some((m) => m.rented) ?? false;
  const spending = useQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), enabled: any, refetchInterval: 30_000 });
  const caps = useMutation({
    mutationFn: (rentCaps: { day: number; month: number }) => api.saveSettings({ rentCaps }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.rentedSpending() });
    },
  });
  const s = spending.data?.spending;
  if (!any || !s) return null;
  return (
    <Card
      title="Rented GPUs"
      help="What your rented pods cost: each one's running time × its rate, as Afflatus counts it (RunPod's bill is the reference). A stopped pod's disk is billed too, and is not in these figures: its card says what it costs a day."
      status={s.balance !== null ? <span className={cx("text-[12.5px]", s.lowBalance ? "font-semibold text-warn-ink" : "text-ink-2")}>RunPod balance <span className="font-mono">{usd(s.balance)}</span></span> : undefined}
    >
      <Row label="Today"><Against value={s.today} cap={s.caps.day} sub="GPU time" /></Row>
      <Row label="This month"><Against value={s.month} cap={s.caps.month} /></Row>
      <Row setting="comfy.rentcaps" label="Caps" help="At a cap, the render running finishes, then the pods stop; what waits goes to your other machines, and Start says the cap is reached. Empty: no cap.">
        <CapBox label="a day" value={s.caps.day} onSave={(day) => caps.mutate({ ...s.caps, day })} />
        <CapBox label="a month" value={s.caps.month} onSave={(month) => caps.mutate({ ...s.caps, month })} />
      </Row>
      {s.lowBalance && <Block><ErrorNote>Your RunPod balance is low: RunPod stops pods at zero, and may delete their disks after a while.</ErrorNote></Block>}
      {caps.isError && <Block><ErrorNote>{caps.error.message}</ErrorNote></Block>}
    </Card>
  );
}
