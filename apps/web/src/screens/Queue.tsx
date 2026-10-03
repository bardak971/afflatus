import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, X } from "lucide-react";
import { api, type SystemLoad } from "../api";
import { useQueue } from "../data";
import { about, aboutMs, phaseLabel, when } from "../format";
import { allowNotifications, useNotify, useSystem } from "../store";
import { Bar, Button, cx, ErrorNote, SectionTitle, Segmented, Toggle } from "../ui";
import { LivePreview } from "../LivePreview";
import { History } from "./queue/History";
import { RenderTimes } from "./queue/Times";
import { ComfyLog } from "./queue/Log";

/** The numbers of the machine ComfyUI runs on. Shows what is known: a meter with no source is left out. */
export function meters(load: SystemLoad | null): Array<{ label: string; value: string; percent: number; hot: boolean }> {
  if (!load) return [];
  const out: Array<{ label: string; value: string; percent: number; hot: boolean }> = [];
  const pct = (label: string, v: number | undefined) => v !== undefined && out.push({ label, value: `${Math.round(v)}%`, percent: v, hot: false });
  pct("CPU", load.cpu);
  pct("RAM", load.ram?.percent);
  pct("Disk", load.disks[0]?.percent);
  const gpu = load.gpus[0];
  if (gpu) {
    pct("GPU", gpu.load);
    pct("VRAM", gpu.vramPercent);
    // a GPU is built to run warm; past 80° it is worth a glance
    if (gpu.temperature !== undefined) out.push({ label: "GPU temp", value: `${Math.round(gpu.temperature)}°`, percent: gpu.temperature, hot: gpu.temperature >= 80 });
  }
  return out;
}

/**
 * The queue: what runs now, what comes next and when it will all be done, on the left; what was done,
 * as the results themselves, on the right (History). The machine's meters sit under the queue, small:
 * the footer has the ones that matter at every moment.
 */
export function Queue() {
  const queue = useQueue();
  const load = useSystem((s) => s.load);
  const notify = useNotify();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["queue"] });
  const pause = useMutation({ mutationFn: (paused: boolean) => (paused ? api.pause() : api.resume()), onSuccess: refresh });
  const free = useMutation({ mutationFn: api.freeMemory });
  const cancel = useMutation({ mutationFn: api.cancel, onSuccess: refresh });
  const order = useMutation({ mutationFn: api.queueOrder, onSuccess: (q) => client.setQueryData(["queue"], q) });
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [refused, setRefused] = useState(false);
  const [tab, setTab] = useState<"queue" | "times" | "log">("queue");
  const q = queue.data;
  const m = meters(load);
  const error = queue.error ?? free.error ?? pause.error ?? cancel.error ?? order.error;

  const drop = (index: number) => {
    if (!q || !dragged) return;
    const ids = q.waiting.map((w) => w.id).filter((id) => id !== dragged);
    ids.splice(index > q.waiting.findIndex((w) => w.id === dragged) ? index - 1 : index, 0, dragged);
    order.mutate(ids);
    setDragged(null);
    setOver(null);
  };
  const waitingMs = q?.waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0) ?? 0;
  const switches = (() => {
    // how many times the model changes down the line: each one costs a load
    let n = 0;
    let last: string | null = null;
    for (const w of q?.waiting ?? []) {
      if (w.kind !== "render") continue;
      const model = w.recipe;
      if (last && model !== last) n++;
      last = model;
    }
    return n;
  })();

  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden px-8 pb-6">
      <header className="flex h-20 shrink-0 items-center gap-5">
        <h1 className="text-xl font-semibold">Queue</h1>
        <div className="w-[380px]">
          <Segmented<"queue" | "times" | "log"> label="View" value={tab} options={[{ value: "queue", label: "Queue" }, { value: "times", label: "Render times" }, { value: "log", label: "ComfyUI log" }]} onChange={setTab} />
        </div>
        <div className="flex min-w-0 grow items-center gap-3 text-xs text-ink-2">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={cx("h-2 w-2 rounded-full", q?.online ? "bg-good" : "bg-warn")} />
            {q?.online ? "ComfyUI online" : "ComfyUI offline · queued jobs wait"}
          </span>
          {q?.model && <span className="truncate font-mono">{q.model} loaded</span>}
        </div>
        {q?.online && (
          <Button
            className="h-10 px-4"
            disabled={free.isPending || Boolean(q.running && q.running.kind === "render")}
            title="Unloads ComfyUI's models from VRAM and RAM, for a game or another program. The next render loads what it needs again. Not while a render is running."
            onClick={() => free.mutate()}
          >
            {free.isPending ? "Unloading…" : free.isSuccess ? "Models unloaded" : "Unload models (free VRAM)"}
          </Button>
        )}
        {q && (
          <Button tone={q.paused ? "primary" : "plain"} className="h-10 px-4" title={q.paused ? "Send what waits to ComfyUI again" : "Finish the running render, then send nothing new: the GPU is yours"} onClick={() => pause.mutate(!q.paused)}>
            {q.paused ? "Resume queue" : "Pause queue"}
          </Button>
        )}
      </header>

      {error && <ErrorNote>{error.message}</ErrorNote>}

      {tab === "times" && <div className="min-h-0 grow overflow-y-auto"><RenderTimes /></div>}
      {tab === "log" && <ComfyLog online={Boolean(q?.online)} />}

      {tab === "queue" && q && (
        <div className="grid min-h-0 grow grid-cols-[400px_minmax(0,1fr)] gap-6">
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1 pb-4">
            {q.paused && (
              <div className="rounded-[10px] bg-accent-wash px-3.5 py-2.5 text-sm font-semibold text-accent">
                Paused. The running render finishes, then nothing new goes to ComfyUI until you resume. Exports go on: no GPU.
              </div>
            )}

            <section className="flex flex-col gap-2">
              <SectionTitle>{q.running?.kind === "export" ? "Exporting" : q.running?.kind === "load" ? "Loading model" : "Running"}</SectionTitle>
              {q.running ? (
                <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-panel p-3">
                  {/* large enough to judge a render by, and to stop one that is not going where it should; a clip plays with its sound */}
                  <div data-stage className="flex h-[260px] items-center justify-center overflow-hidden rounded-lg bg-raised text-[11px] text-ink-2">
                    {q.running.previewSeq > 0 ? <LivePreview job={q.running} sound className="h-full w-auto max-w-full object-contain" /> : q.running.kind === "export" ? "no preview" : "no preview yet"}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="truncate text-[15px] font-semibold">{q.running.label}</div>
                    <Bar value={q.running.progress * 100} />
                    <div className="flex items-center justify-between gap-2 text-xs text-ink-2">
                      <span className="truncate">
                        {phaseLabel(q.running.phase)}
                        {q.running.steps ? ` · step ${q.running.step} of ${q.running.steps}` : q.running.kind === "export" ? " · no GPU needed" : ""}
                        {q.running.eta ? ` · ${about(q.running.eta)}` : ""}
                      </span>
                      <Button size="sm" onClick={() => cancel.mutate(q.running!.id)}>Stop</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-line px-3.5 py-3 text-sm text-ink-2">Nothing running.</div>
              )}
            </section>

            <section className="flex flex-col gap-2" onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
              <div className="flex items-baseline justify-between gap-2">
                <SectionTitle>Next · {q.waiting.length}</SectionTitle>
                {q.waiting.length > 0 && (
                  <span className="truncate text-xs text-ink-2">
                    {waitingMs ? `${aboutMs(waitingMs)} in all` : ""}{switches ? ` · ${switches} model switch${switches > 1 ? "es" : ""}` : ""}
                  </span>
                )}
              </div>
              {q.waiting.map((w, i) => (
                <div
                  key={w.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDragged(w.id);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragged) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    setOver(e.clientY < r.top + r.height / 2 ? i : i + 1);
                  }}
                  className={cx(
                    "flex items-center gap-2 rounded-[10px] border border-line bg-panel py-2 pr-1.5 pl-1.5",
                    dragged === w.id && "opacity-50",
                    dragged && over === i && "border-t-accent",
                    dragged && over === i + 1 && i === q.waiting.length - 1 && "border-b-accent",
                  )}
                >
                  <GripVertical size={15} className="shrink-0 cursor-grab text-ink-3" />
                  <span className="min-w-0 grow">
                    <span className="block truncate text-sm font-semibold">{w.label}</span>
                    <span className="block text-xs text-ink-2">{w.kind === "export" || w.kind === "cut" ? `${w.kind} · no GPU needed` : w.kind === "load" ? "loads the model, renders nothing" : `queued ${when(w.createdAt)}`}</span>
                  </span>
                  {w.estimateMs ? <span className="shrink-0 text-xs text-ink-2">{aboutMs(w.estimateMs)}</span> : null}
                  <button type="button" aria-label={`Remove ${w.label} from the queue`} onClick={() => cancel.mutate(w.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover">
                    <X size={15} />
                  </button>
                </div>
              ))}
              {!q.waiting.length && <div className="rounded-xl border border-line px-3.5 py-3 text-sm text-ink-2">Nothing queued.</div>}
              {q.waiting.length > 1 && <span className="text-xs text-ink-3">Drag to reorder. Images go before videos unless you move them.</span>}
            </section>

            <div className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2">
              <Toggle
                on={notify.whenEmpty}
                label="Notify when the queue is empty"
                onChange={async (on) => {
                  if (on && !(await allowNotifications())) return setRefused(true);
                  setRefused(false);
                  notify.set({ whenEmpty: on });
                }}
              />
              <span className="text-xs text-ink-2">{refused ? "Your browser does not allow notifications from this page. Allow them in its settings, next to the address." : "A notification from your browser. Nothing leaves your computer."}</span>
            </div>

            {m.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionTitle>Machine</SectionTitle>
                <div className="grid grid-cols-3 gap-1.5">
                  {m.map((x) => (
                    <div key={x.label} className="flex flex-col gap-1 rounded-[8px] border border-line bg-panel px-2 py-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[11px] text-ink-2">{x.label}</span>
                        <span className={cx("font-mono text-xs", x.hot && "text-warn-ink")}>{x.value}</span>
                      </div>
                      <Bar value={x.percent} tone={x.hot ? "warn" : "picture"} />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <History />
        </div>
      )}
    </div>
  );
}
