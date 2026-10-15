import { useEffect, useState } from "react";
import { Clipboard, X } from "lucide-react";
import type { RunningJob } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { elapsed, phaseLabel, timeLeft } from "../../format";
import { LivePreview, StageStrip } from "../../LivePreview";
import { Bar, Button, cx, Help } from "../../ui";
import { useCopyNote } from "./copyNote";
import { useModelName } from "./modelName";
import { STEP_RATE_HELP, stepRateSaid, useStepRate } from "./stepRate";

/** How long it has been running, counted every second on its own: a model load sends no progress to draw it again. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{elapsed(now - new Date(since).getTime())} elapsed</span>;
}

/**
 * What runs now, as one highlighted row: its live preview small, the progress and what is left, and a
 * Stop. A click on the preview opens it large (with its sound, and the workflow's own Preview nodes
 * under it), to judge a render by and stop one that is not going where it should. Under the bar, its figures
 * in a row: the phase and step, the s/it over the last steps, elapsed, time left and the seed once it is sent.
 */
export function RunningCard({ running, onStop }: { running: RunningJob | null; onStop(id: string): void }) {
  const menu = useMenu<true>();
  const [large, setLarge] = useState(false);
  const modelOf = useModelName();
  const rate = useStepRate();
  const seedCopy = useCopyNote();
  if (!running) return <div className="rounded-xl border border-line px-3 py-2.5 text-sm text-ink-2">Nothing running.</div>;
  const seen = running.previewSeq > 0;
  const seed = running.seed ?? null;
  const pace = rate?.id === running.id ? rate.secondsPerStep : null;
  const items: MenuItem[] = [
    ...(seed !== null ? [{ label: "Copy the seed", icon: <Clipboard size={14} />, note: String(seed), run: () => seedCopy.copy(String(seed)) }, "—" as const] : []),
    { label: "Stop this render", icon: <X size={14} />, danger: true, run: () => onStop(running.id) },
  ];
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-accent/10 px-3 py-2.5 inset-ring inset-ring-accent/35" onContextMenu={(e) => menu.open(e, true)}>
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          data-stage
          aria-expanded={large}
          aria-label={large ? "Show the live preview small" : "Show the live preview large"}
          data-tip={seen ? (large ? "Show it small again" : "Show it large, with its sound") : undefined}
          disabled={!seen}
          onClick={() => setLarge(!large)}
          className="relative flex h-[54px] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised text-[10px] text-ink-3 enabled:hover:ring-2 enabled:hover:ring-accent/50"
        >
          {seen && !large ? <LivePreview job={running} className="h-full w-full object-cover" /> : seen ? "shown below" : running.kind === "export" ? "no preview" : "no preview yet"}
        </button>
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 shrink truncate text-[14.5px] font-bold" data-tip={running.label}>{running.label}</span>
            <span className="min-w-0 shrink-[2] truncate text-xs text-ink-2">{running.kind === "load" ? `loading ${modelOf(running)}` : running.kind === "export" || running.kind === "cut" ? `${modelOf(running)} · no GPU needed` : modelOf(running)}</span>
          </span>
          <Bar value={running.progress * 100} steps={running.steps} loading={!running.progress} />
          <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-xs text-ink-2">
            <span className="text-ink">{phaseLabel(running.phase)}{running.steps ? ` ${running.step} / ${running.steps}` : ""}</span>
            {pace !== null && (
              <span className="flex items-center gap-1.5">
                <b className="font-semibold text-ink">{stepRateSaid(pace)}</b>
                <Help text={STEP_RATE_HELP} />
              </span>
            )}
            {running.startedAt && <Elapsed since={running.startedAt} />}
            {running.eta > 0 && <span className="text-ink">{timeLeft(running.eta)}</span>}
            {seed !== null && <span data-tip="Right-click to copy it">seed {seed}</span>}
            {seedCopy.note && <span aria-live="polite" className={cx("font-sans", seedCopy.note.ok ? "text-accent" : "text-warn-ink")}>{seedCopy.note.text}</span>}
            {running.spilling && <span className="font-sans font-semibold text-warn-ink" data-tip="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory (a finish frees ComfyUI's models first), or give SeedVR2 a smaller batch size (Finish).">spilling out of VRAM, much slower than usual</span>}
          </span>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => onStop(running.id)}>Stop this render</Button>
      </div>
      {large && seen && (
        <div className="flex flex-col gap-2">
          {/* a clip plays with its sound */}
          <div data-stage className="flex h-[260px] items-center justify-center overflow-hidden rounded-lg bg-stage">
            <LivePreview job={running} sound className="h-full w-auto max-w-full object-contain" />
          </div>
          <StageStrip job={running} />
        </div>
      )}
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on the running render" head={{ title: running.label, sub: `Running · ${modelOf(running)}` }} items={items} onClose={menu.close} />}
    </div>
  );
}
