import { useEffect, useState } from "react";
import { useThemeChoice } from "../theme/store";
import { Help } from "../ui";
import { Progress, ProgressRing } from "./Progress";
import { DEFAULT_PROGRESS, PROGRESS_STYLES, shownStyle, useReducedMotion, type ProgressStyle } from "./style";
import { cx } from "../cx";

/** The pretend render of the previews: a model loading for a moment, 20 steps at 2.5 a second, a pause on the end. */
const STEPS = 20;
const LOADING = 3;
const TICK_MS = 400;
const CYCLE = LOADING + STEPS + 3;

/** Where the pretend render is: the model loading (no step yet), or a step of 20. One timer for the four previews, only while they are on screen. */
function usePretendRender(): { loading: boolean; step: number } {
  const [k, setK] = useState(LOADING);
  useEffect(() => {
    const timer = window.setInterval(() => setK((n) => (n + 1) % CYCLE), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return { loading: k < LOADING, step: Math.min(STEPS, k - LOADING) };
}

/** One style as a small picture of itself, moving: the Queue's ring, the status bar's line, a bar. */
function StyleTile({ id, label, tip, on, drawn, run, onPick }: { id: ProgressStyle; label: string; tip: string; on: boolean; drawn: ProgressStyle; run: { loading: boolean; step: number }; onPick(): void }) {
  const value = run.step / STEPS;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      data-tip={tip}
      aria-label={label}
      data-style={id}
      className={cx("flex w-[132px] flex-col gap-1.5 rounded-2xl border-2 p-1.5 text-left", on ? "border-accent" : "border-transparent hover:border-line-strong")}
    >
      <span className="flex h-[70px] w-full items-center gap-2 overflow-hidden rounded-lg border border-line bg-ground px-2">
        <span className="relative flex size-[30px] shrink-0 items-center justify-center">
          <ProgressRing styleAs={drawn} value={value} steps={STEPS} loading={run.loading} />
        </span>
        <span className="flex min-w-0 grow flex-col gap-2">
          <span className="relative h-3.5 overflow-hidden rounded-[5px] bg-raised">
            <Progress styleAs={drawn} shape="edge" value={value} steps={STEPS} loading={run.loading} />
          </span>
          <Progress styleAs={drawn} value={value} steps={STEPS} loading={run.loading} className="h-1.5" />
        </span>
      </span>
    </button>
  );
}

/**
 * Settings › Interface › Progress: how the bars move while something renders, in this browser. Each style is shown
 * moving with a pretend render; with motion reduced, Glide and Alive are drawn (and shown) as Steps.
 */
export function ProgressPicker() {
  const chosen = useThemeChoice((s) => s.progress) ?? DEFAULT_PROGRESS;
  const set = useThemeChoice((s) => s.set);
  const reduced = useReducedMotion();
  const run = usePretendRender();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        Progress
        {reduced && (chosen === "glide" || chosen === "alive") && <span className="font-normal text-ink-2">drawn without its motion: the system asks for less</span>}
        <Help title="Progress" text="How the progress bars, the status bar's line and the Queue's ring move while something renders; each tile shows its way, moving. From the left: a short ease to each step; the bar moving on at the render's pace, reaching each step as the next one is due; one tick per step, nothing moving in between; a short ease with a light along the bar and a dot circling the ring. Kept in this browser. With reduced motion asked by the system, the second and the fourth tick by step." />
      </span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Progress style">
        {PROGRESS_STYLES.map((s) => (
          <StyleTile key={s.id} id={s.id} label={s.label} tip={s.tip} on={chosen === s.id} drawn={shownStyle(s.id, reduced)} run={run} onPick={() => set({ progress: s.id })} />
        ))}
      </div>
    </div>
  );
}
