import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, X } from "lucide-react";
import { secondsInput } from "@studai/core";
import { api, type Job, type RecipeInfo, type SystemLoad } from "../api";
import { useQueue, useRecipes } from "../data";
import { about, aboutMs, phaseLabel, took, when } from "../format";
import { allowNotifications, useNotify, useSystem } from "../store";
import { Bar, Button, cx, Empty, ErrorNote, SectionTitle, Toggle } from "../ui";
import { LivePreview } from "../LivePreview";

/** The numbers of the machine ComfyUI runs on. Shows what is known: a meter with no source is left out. */
export function meters(load: SystemLoad | null): Array<{ label: string; value: string; percent: number; hot: boolean }> {
  if (!load) return [];
  const out: Array<{ label: string; value: string; percent: number; hot: boolean }> = [];
  const pct = (label: string, v: number | undefined) => v !== undefined && out.push({ label, value: `${Math.round(v)}%`, percent: v, hot: false });
  pct("Processor", load.cpu);
  pct("Memory", load.ram?.percent);
  pct("Disk space", load.disks[0]?.percent);
  const gpu = load.gpus[0];
  if (gpu) {
    pct("GPU load", gpu.load);
    pct("GPU memory", gpu.vramPercent);
    // a GPU is built to run warm; past 80° it is worth a glance
    if (gpu.temperature !== undefined) out.push({ label: "GPU heat", value: `${Math.round(gpu.temperature)}°`, percent: gpu.temperature, hot: gpu.temperature >= 80 });
  }
  return out;
}

const STATUS: Record<Job["status"], string> = { queued: "Waiting", running: "Rendering", done: "Done", failed: "Failed", cancelled: "Stopped" };

/**
 * After a render ran out of memory: the same job, one size smaller (or, when it has no size to set,
 * shorter). null when the recipe offers nothing to make it lighter.
 */
export function lighter(recipe: RecipeInfo | undefined, input: Record<string, unknown> | null): { change: Record<string, unknown>; label: string } | null {
  if (!recipe || !input) return null;
  const size = recipe.inputs.find((i) => i.type === "number" && /short|resolution|megapixel|size/i.test(`${i.id} ${i.label}`));
  const length = secondsInput(recipe.inputs);
  for (const spec of [size, length]) {
    if (!spec || spec.type !== "number") continue;
    const now = Number(input[spec.id] ?? spec.default);
    const next = Math.max(spec.min, Number((now - spec.step * (spec === length ? Math.max(1, Math.round(1 / spec.step)) : 1)).toFixed(4)));
    if (next < now) return { change: { [spec.id]: next }, label: `Try again at ${next}${spec.unit ?? ""}` };
  }
  return null;
}
const ranOutOfMemory = (error: string | null) => /out of memory|\boom\b|allocat|not enough memory/i.test(error ?? "");

export function Queue() {
  const queue = useQueue();
  const recipes = useRecipes();
  const load = useSystem((s) => s.load);
  const notify = useNotify();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["queue"] });
  const pause = useMutation({ mutationFn: (paused: boolean) => (paused ? api.pause() : api.resume()), onSuccess: refresh });
  const free = useMutation({ mutationFn: api.freeMemory });
  const cancel = useMutation({ mutationFn: api.cancel, onSuccess: refresh });
  const order = useMutation({ mutationFn: api.queueOrder, onSuccess: (q) => client.setQueryData(["queue"], q) });
  const again = useMutation({ mutationFn: (v: { id: string; input?: Record<string, unknown> }) => api.retryJob(v.id, v.input), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: api.dismissJob, onSuccess: refresh });
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [refused, setRefused] = useState(false);
  const q = queue.data;
  const m = meters(load);
  const error = queue.error ?? free.error ?? pause.error ?? cancel.error ?? order.error ?? again.error ?? dismiss.error;

  const drop = (index: number) => {
    if (!q || !dragged) return;
    const ids = q.waiting.map((w) => w.id).filter((id) => id !== dragged);
    ids.splice(index > q.waiting.findIndex((w) => w.id === dragged) ? index - 1 : index, 0, dragged);
    order.mutate(ids);
    setDragged(null);
    setOver(null);
  };
  const waitingMs = q?.waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0) ?? 0;
  const failed = q?.recent.filter((r) => r.status === "failed") ?? [];
  const finished = q?.recent.filter((r) => r.status !== "failed") ?? [];

  return (
    <div className="flex min-h-0 grow flex-col overflow-y-auto px-8 pb-8">
      <header className="flex h-24 shrink-0 items-center gap-5">
        <div className="grow">
          <h1 className="text-xl font-semibold">Queue</h1>
          <div className="flex items-center gap-2 text-ink-2">
            <span className={cx("h-2 w-2 rounded-full", q?.online ? "bg-good" : "bg-warn")} />
            {q?.online ? "ComfyUI is on · the numbers below are the computer it runs on, live" : "ComfyUI is not answering. Waiting jobs stay in line."}
          </div>
        </div>
        {q && !q.paused && <span className="max-w-72 text-right text-xs text-ink-2">Pause when you want to use ComfyUI yourself. Waiting jobs stay in line.</span>}
        {q?.online && (
          <Button
            className="h-12 px-5 text-sm"
            disabled={free.isPending || Boolean(q.running && q.running.recipe !== "studai.export")}
            title="Unloads ComfyUI's models from the graphics card and from memory, for a game or another program. The next render loads what it needs again. Not while a render is under way."
            onClick={() => free.mutate()}
          >
            {free.isPending ? "Freeing…" : free.isSuccess ? "Memory freed" : "Free the GPU memory"}
          </Button>
        )}
        {q && (
          <Button tone={q.paused ? "primary" : "plain"} className="h-12 px-5 text-sm" onClick={() => pause.mutate(!q.paused)}>
            {q.paused ? "Resume the queue" : "Pause: I need the GPU"}
          </Button>
        )}
      </header>

      {m.length > 0 && (
        <div className="mb-5 grid shrink-0 gap-2.5" style={{ gridTemplateColumns: `repeat(${m.length}, minmax(0, 1fr))` }}>
          {m.map((x) => (
            <div key={x.label} className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-3 py-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-2">{x.label}</span>
                <span className={cx("font-mono text-[15px]", x.hot && "text-warn-ink")}>{x.value}</span>
              </div>
              <Bar value={x.percent} tone={x.hot ? "warn" : "picture"} />
            </div>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error.message}</ErrorNote>}
      {q?.paused && (
        <div className="mb-4 rounded-[10px] bg-accent-wash px-4 py-3 font-semibold text-accent">
          Paused. The clip that is rendering finishes, then nothing new is sent to ComfyUI until you resume. The GPU is yours. Exports go on: they do not use it.
        </div>
      )}

      {q && (
        <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-8">
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <SectionTitle>{q.running?.kind === "export" ? "Exporting now" : q.running?.kind === "load" ? "Loading a model now" : "Rendering now"}</SectionTitle>
              {q.running ? (
                <div className="flex gap-4 rounded-xl border border-line-strong bg-panel p-3.5">
                  {/* large enough to judge a render by, and to stop one that is not going where it should; a clip plays with its sound */}
                  <div className="flex h-[280px] min-w-[158px] max-w-[420px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised text-[11px] text-ink-2">
                    {q.running.previewSeq > 0 ? <LivePreview job={q.running} sound className="h-full w-auto max-w-full object-contain" /> : q.running.kind === "export" ? "no preview" : "no preview yet"}
                  </div>
                  <div className="flex min-w-0 grow flex-col gap-2">
                    <div className="text-[15px] font-semibold">{q.running.label}</div>
                    <div className="text-ink-2">{phaseLabel(q.running.phase)}</div>
                    <Bar value={q.running.progress * 100} />
                    <div className="flex items-center justify-between">
                      <span>{q.running.steps ? `Step ${q.running.step} of ${q.running.steps}` : q.running.kind === "export" ? "No GPU needed" : "Starting"}{q.running.eta ? ` · ${about(q.running.eta)}` : ""}</span>
                      <Button size="sm" onClick={() => cancel.mutate(q.running!.id)}>Stop it</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-line px-4 py-5 text-ink-2">Nothing is rendering.</div>
              )}
            </section>

            <section className="flex flex-col gap-2" onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
              <div className="flex items-baseline justify-between">
                <SectionTitle>Waiting · {q.waiting.length}{waitingMs ? ` · ${aboutMs(waitingMs)} in all` : ""}</SectionTitle>
                {q.waiting.length > 1 && <span className="text-xs text-ink-2">Drag to change the order. Pictures go before videos unless you move them.</span>}
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
                    "flex items-center gap-2 rounded-[10px] border border-line bg-panel py-2.5 pr-2 pl-2",
                    dragged === w.id && "opacity-50",
                    dragged && over === i && "border-t-accent",
                    dragged && over === i + 1 && i === q.waiting.length - 1 && "border-b-accent",
                  )}
                >
                  <GripVertical size={15} className="shrink-0 cursor-grab text-ink-3" />
                  <span className="min-w-0 grow">
                    <span className="block font-semibold">{w.label}</span>
                    <span className="block text-xs text-ink-2">{w.kind === "export" ? "an export · no GPU needed" : `added ${when(w.createdAt)}`}</span>
                  </span>
                  {w.estimateMs ? <span className="shrink-0 text-xs text-ink-2">{aboutMs(w.estimateMs)}</span> : null}
                  <button type="button" aria-label={`Remove ${w.label} from the queue`} onClick={() => cancel.mutate(w.id)} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover">
                    <X size={15} />
                  </button>
                </div>
              ))}
              {!q.waiting.length && <div className="text-ink-2">Nothing is waiting.</div>}
            </section>

            {failed.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionTitle>{failed.length} render{failed.length > 1 ? "s" : ""} failed</SectionTitle>
                {failed.map((r) => {
                  const recipe = recipes.data?.recipes.find((x) => x.id === r.recipe);
                  const fix = ranOutOfMemory(r.error) ? lighter(recipe, r.input) : null;
                  return (
                    <div key={r.id} className="flex flex-col gap-2 rounded-[10px] border border-warn/50 bg-warn-wash px-3.5 py-3">
                      <div className="font-semibold">{r.label}</div>
                      <div className="text-warn-ink">{r.error}{fix ? " It was too heavy for the card's memory." : ""}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {fix && <Button size="sm" tone="danger" disabled={again.isPending} onClick={() => again.mutate({ id: r.id, input: fix.change }, { onSuccess: () => dismiss.mutate(r.id) })}>{fix.label}</Button>}
                        <Button size="sm" disabled={again.isPending} onClick={() => again.mutate({ id: r.id }, { onSuccess: () => dismiss.mutate(r.id) })}>Try again as it was</Button>
                        <Button size="sm" tone="quiet" onClick={() => dismiss.mutate(r.id)}>Dismiss</Button>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </div>

          <section className="flex flex-col gap-2">
            <SectionTitle>Finished · {finished.length}</SectionTitle>
            {finished.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-semibold">{r.label}</span>
                  <span className={cx("shrink-0 font-semibold", r.status === "done" ? "text-good" : "text-ink-2")}>{STATUS[r.status]}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-ink-2">
                  <span>
                    {r.finishedAt ? when(r.finishedAt) : ""}
                    {r.status === "done" && r.startedAt && r.finishedAt ? ` · took ${took(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())}` : ""}
                  </span>
                  {r.status === "cancelled" && <button type="button" onClick={() => again.mutate({ id: r.id }, { onSuccess: () => dismiss.mutate(r.id) })} className="underline hover:text-ink">Queue it again</button>}
                </div>
              </div>
            ))}
            {!finished.length && <Empty title="Nothing finished yet" />}
            <div className="mt-2 flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5">
              <Toggle
                on={notify.whenEmpty}
                label="Tell me when the queue is empty"
                onChange={async (on) => {
                  if (on && !(await allowNotifications())) return setRefused(true);
                  setRefused(false);
                  notify.set({ whenEmpty: on });
                }}
              />
              <span className="text-xs text-ink-2">{refused ? "Your browser does not allow notifications from this page. Allow them in its settings, next to the address." : "A notification from your browser. Nothing leaves your computer."}</span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
