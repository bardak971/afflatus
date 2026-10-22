import { useRef, type CSSProperties } from "react";
import { glideTo, litOf, ticksOf, useProgressStyle, useReducedMotion, type Glide, type ProgressStyle } from "./style";
import { cx } from "../cx";

/** The short ease of Same look and Alive: what the bars always did, now on the compositor. */
const EASE_MS = 300;
const EASE = "ease-out";

/** Where a bar or the ring is going and how it gets there, kept from one value to the next (the glide needs the pace). */
function useMove(value: number, style: ProgressStyle, meter: boolean): { aim: number; from: number; ms: number; ease: string } {
  const glide = useRef<Glide | null>(null);
  const from = useRef(0);
  const reduced = useReducedMotion();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  // a new value: the glide learns the pace from it (in every style, so that a change of style mid-render glides at once)
  if (!glide.current || glide.current.at !== v) {
    from.current = glide.current?.aim ?? v;
    glide.current = glideTo(glide.current, v, performance.now());
  }
  const g = glide.current;
  if (style === "glide" && !meter) return { aim: g.aim, from: from.current, ms: g.ms, ease: "linear" };
  // Steps draws no motion; Same look under reduced motion neither (Glide and Alive are drawn as Steps then); a gauge
  // jumps to its figure, as it always did (it moves every 2 s, a reading, not a progress)
  if (style === "steps" || reduced || meter) return { aim: v, from: v, ms: 0, ease: EASE };
  const back = v < from.current;
  return { aim: v, from: from.current, ms: back ? 0 : EASE_MS, ease: EASE };
}

const moving = (ms: number, ease: string, delay = 0) => (ms > 0 ? `transform ${ms}ms ${ease}${delay ? ` ${delay}ms` : ""}` : "none");

/**
 * Every progress the app draws, in the style this browser chose (style.ts): a render's, a download's, a gauge's. The bar
 * is a full-length fill slid along its track by `translateX`, so that a step costs no paint (the width eased on every
 * step before, and kept the tab painting while anything rendered); a gauge (`meter`: a GPU's load, VRAM) moves the same
 * way but never glides, sweeps or ticks, as it is not a progress. `loading`: no figure yet (the model loading), drawn
 * as the pulse of the whole bar, or in Steps a first tick in grey. `shape` "edge": the thin line along the bottom of a
 * pill (the status bar, a Queue lane), "bar": a rounded bar on its track.
 */
export function Progress({ value, steps, loading = false, meter = false, shape = "bar", tone = "bg-accent", under = "bg-line-strong", radius = "rounded-full", className, styleAs, label }: {
  /** 0–1. */
  value: number;
  /** The render's step count, for the ticks of Steps. */
  steps?: number;
  loading?: boolean;
  meter?: boolean;
  shape?: "bar" | "edge";
  /** The fill's colour class. */
  tone?: string;
  /** The track's colour class (the unlit ticks of Steps). */
  under?: string;
  /** The corners of a bar and its fill (a gauge's are near square). */
  radius?: string;
  /** The track's size and place. */
  className?: string;
  /** Drawn in this style rather than this browser's (Settings' previews). */
  styleAs?: ProgressStyle;
  label?: string;
}) {
  const chosen = useProgressStyle();
  const style = styleAs ?? chosen;
  const move = useMove(loading ? 0 : value, style, meter);
  const edge = shape === "edge";
  const round = edge ? "" : radius;
  const track = edge ? cx("pointer-events-none absolute inset-x-0 bottom-0 h-0.5", className) : cx("relative", className);
  const v = Math.max(0, Math.min(1, value));
  const aria = { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": loading ? undefined : Math.round(v * 100), "data-progress": meter ? "meter" : style } as const;

  if (style === "steps" && !meter) {
    const n = ticksOf(steps);
    const lit = loading ? 0 : litOf(v, n);
    return (
      // the mock's 2 px between ticks; past 24 of them 1 px, so that a tick of a narrow bar (a Studio tile's) stays wider than its gap
      <div {...aria} className={cx(track, "flex", n > 24 ? "gap-px" : "gap-[2px]")}>
        {Array.from({ length: n }, (_, i) => (
          <span key={i} data-lit={i < lit || undefined} className={cx("min-w-0 grow", !edge && "rounded-xs", i < lit ? tone : loading && i === 0 ? "bg-ink-3" : under)} />
        ))}
      </div>
    );
  }
  const sweep = style === "alive" && !meter && (loading || (v > 0 && v < 1));
  const fill: CSSProperties = { transform: `translateX(${(move.aim - 1) * 100}%)`, transition: loading ? "none" : moving(move.ms, move.ease) };
  return (
    <div {...aria} className={cx(track, "overflow-hidden", round, !edge && under)}>
      {loading ? (
        // design: the one progress bar's own wait for a first figure, in its shape and tone
        <span className={cx("absolute inset-0 animate-pulse opacity-40 motion-reduce:animate-none", round, tone)} />
      ) : (
        <span data-fill className={cx("absolute inset-0", round, tone)} style={fill} />
      )}
      {sweep && <span aria-hidden className="absolute inset-y-0 left-0 w-1/4 animate-[progress-sweep_1.6s_linear_infinite] bg-linear-to-r from-transparent via-white/60 to-transparent" />}
    </div>
  );
}

const RING_R = 13;
const RING = 2 * Math.PI * RING_R;

/** The ring's two halves and its head as turns (deg), and how each moves from the last value to this one. */
function ringMoves(from: number, to: number, ms: number, ease: string) {
  const first = Math.min(to, 0.5) * 360;
  const second = Math.max(0, to - 0.5) * 360;
  const head = to * 360;
  if (ms <= 0 || to <= from) return { first, second, head, firstT: "none", secondT: "none", headT: "none" };
  if (from < 0.5 && to > 0.5) {
    // across the top of the second half: the first half runs out, then the second starts, in one even motion
    const share = (0.5 - from) / (to - from);
    return { first, second, head, firstT: moving(ms * share, "linear"), secondT: moving(ms * (1 - share), "linear", ms * share), headT: moving(ms, "linear") };
  }
  return { first, second, head, firstT: to <= 0.5 ? moving(ms, ease) : "none", secondT: to > 0.5 ? moving(ms, ease) : "none", headT: moving(ms, ease) };
}

/**
 * The Queue's ring in the rail (30 px): the running render's progress round the icon. The arc is two half rings turned
 * by `rotate` inside two half clips, with a dot for each round end: it moves on the compositor as the bars do, where
 * an eased SVG dash was painted on every frame. Steps: dots round the icon, one lit per step.
 */
export function ProgressRing({ value, steps, loading = false, className, styleAs }: { value: number; steps?: number; loading?: boolean; className?: string; styleAs?: ProgressStyle }) {
  const chosen = useProgressStyle();
  const style = styleAs ?? chosen;
  const move = useMove(loading ? 0 : value, style, false);
  const box = cx("pointer-events-none absolute size-[30px]", className);
  if (style === "steps") {
    const n = ticksOf(steps, 20);
    const lit = loading ? 0 : litOf(value, n);
    return (
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden className={box} data-progress="steps">
        {Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          return <circle key={i} cx={15 + RING_R * Math.cos(a)} cy={15 + RING_R * Math.sin(a)} r="1.8" fill={i < lit ? "var(--color-accent)" : "var(--color-line-strong)"} />;
        })}
      </svg>
    );
  }
  const alive = style === "alive";
  const half = "absolute top-0 h-[30px] w-[15px] overflow-hidden";
  const ring = "absolute top-px size-7 rounded-full border-2 border-accent";
  const r = ringMoves(move.from, move.aim, move.ms, move.ease);
  return (
    <span aria-hidden className={box} data-progress={style}>
      <svg width="30" height="30" viewBox="0 0 30 30" className="absolute inset-0">
        <circle cx="15" cy="15" r={RING_R} fill="none" stroke="var(--color-line-strong)" strokeWidth="2" />
      </svg>
      {/* no figure yet from this phase: a quarter, pulsing (an svg of its own, whose opacity the compositor fades) */}
      {loading && (
        // design: the one progress ring's own wait for a first figure
        <svg width="30" height="30" viewBox="0 0 30 30" className="absolute inset-0 animate-pulse motion-reduce:animate-none">
          <circle cx="15" cy="15" r={RING_R} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * 0.75} transform="rotate(-90 15 15)" />
        </svg>
      )}
      {!loading && move.aim > 0 && (
        <>
          {/* 0 to ½: the ring's left half, turned into the right clip about the centre */}
          <span className={cx(half, "left-[15px]")}>
            <span className={cx(half, "-left-[15px] origin-right")} style={{ transform: `rotate(${r.first}deg)`, transition: r.firstT }}>
              <span className={cx(ring, "left-px")} />
            </span>
          </span>
          {/* ½ to 1: the right half, turned into the left clip */}
          <span className={cx(half, "left-0")}>
            <span className={cx(half, "left-[15px] origin-left")} style={{ transform: `rotate(${r.second}deg)`, transition: r.secondT }}>
              <span className={cx(ring, "-left-[14px]")} />
            </span>
          </span>
          {/* the round ends: at the top where it starts, and at the head, turning with it */}
          <span className="absolute top-0 left-[14px] size-[2px] rounded-full bg-accent" />
          <span className="absolute inset-0" style={{ transform: `rotate(${r.head}deg)`, transition: r.headT }}>
            <span className="absolute top-0 left-[14px] size-[2px] rounded-full bg-accent" />
          </span>
        </>
      )}
      {alive && (
        // design: the ring's live mark circling while it works (it stands still with reduced motion: the ring's figure says it)
        <span className="absolute inset-0 animate-spin [animation-duration:2.4s] motion-reduce:animate-none">
          <span className="absolute top-0 left-[13.5px] size-[3px] rounded-full bg-ink" />
        </span>
      )}
    </span>
  );
}
