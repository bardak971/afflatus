import { Crosshair } from "lucide-react";
import { Slide } from "./parts";
import type { RecipeInfo, Timeline } from "../../api";
import { clock as mmss, plural } from "../../format";
import type { LeadPart } from "../../RecipeForm";
import { Button, Segmented, Toggle } from "../../ui";

/**
 * A clip made from the timeline's source, as its panel shows it (the owner, 2026-10-18: no source form, the clip's form is
 * the one): the source's own chapter first, and at the foot whether a change goes to every clip of the source or stays
 * this clip's. What every clip of the source shares, and what one keeps its own, is the server's (sameForm).
 */
export type ClipSource = {
  source: NonNullable<Timeline["source"]>;
  /** How many clips the source made, this one among them. */
  count: number;
  /** The first window: the one the click on the stretch's first frame picks the person in. */
  first: boolean;
  /** The settings this clip keeps its own. */
  apart: string[];
  /** The model's driving video takes a click on its first frame (a swap): who is replaced, picked on the stage. */
  takesPick: boolean;
  picking: boolean;
  onPicking(on: boolean): void;
  onClearPick(): void;
  /** The window lengths the model takes, and the change of one or of the scene cuts: the source cut again (its rendered clips kept). */
  windows: { leastMs: number; mostMs: number };
  onCut(change: { windowMs?: number; snap?: boolean }): void;
  cutting: boolean;
  /** Its changes are kept to it ("This clip"). */
  kept: boolean;
  onKept(on: boolean): void;
  onInLine(): void;
  onToAll(): void;
};

/** The Source chapter of a clip made from the source: its stretch, its part of it, who is replaced. */
export function sourceLead(s: ClipSource, clip: { inputs: Record<string, unknown> }, recipe: RecipeInfo): LeadPart {
  const driving = recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
  const w = driving?.type === "clip" ? driving.window : undefined;
  const start = w ? Number(clip.inputs[w.start] ?? 0) * 1000 : 0;
  const seconds = w ? Number(clip.inputs[w.seconds] ?? 0) * 1000 : 0;
  const stretch = `${mmss(s.source.fromMs, { decimals: 1 })}–${mmss(s.source.toMs, { decimals: 1 })}`;
  return {
    id: "source",
    title: "Source",
    help: "The video this clip is a part of, shared by every clip the source made. Who is replaced is clicked once, on the stretch's first frame; every window follows that person.",
    summary: `${s.source.video.name} · ${stretch}`,
    node: (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-semibold">{s.source.video.name}</span>
          <span className="text-xs text-ink-2">
            {stretch} made into {plural(s.count, "clip")} · this one {mmss(start, { decimals: 1 })}–{mmss(start + seconds, { decimals: 1 })}
          </span>
        </div>
        <Slide label="Window" value={Math.min(Math.max(s.source.windowMs, s.windows.leastMs), s.windows.mostMs)} min={s.windows.leastMs} max={s.windows.mostMs} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(windowMs) => s.onCut({ windowMs })} />
        <Toggle on={s.source.snap} disabled={s.cutting} onChange={(snap) => s.onCut({ snap })} label="Cut at scene changes" note={s.source.snap ? "a window ends at a cut in the source; the next one opens a new shot" : "windows of the same length, end to end"} />
        <span className="text-xs text-ink-2">{s.cutting ? "Cutting the source again…" : "Changed, the source is cut again: its rendered clips at the start stay, the others are made anew after them."}</span>
        {s.takesPick && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Who is replaced</span>
            {s.picking ? (
              <Button tone="plain" className="h-11 justify-start gap-2 border-accent! px-3" onClick={() => s.onPicking(false)}>
                <Crosshair size={16} className="text-accent" aria-hidden />
                <span className="grow text-left"><span className="font-semibold">Picking</span><span className="text-ink-2"> · click the person on the stage</span></span>
                <kbd className="font-mono text-[11px] text-ink-3">Esc</kbd>
              </Button>
            ) : s.source.pick ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="grow text-xs text-ink-2">Clicked on {mmss(s.source.fromMs, { decimals: 1 })}; every window follows that person</span>
                <Button size="sm" onClick={() => s.onPicking(true)}>Pick again</Button>
                <Button size="sm" tone="quiet" onClick={s.onClearPick}>Clear</Button>
              </div>
            ) : (
              <Button className="h-11 justify-start gap-2 px-3" onClick={() => s.onPicking(true)}>
                <Crosshair size={16} aria-hidden />
                Pick on the stage
              </Button>
            )}
          </div>
        )}
      </div>
    ),
  };
}

/**
 * At the foot of a clip made from the source: where a change goes. Every clip by default, as the windows join best made
 * alike; this clip only for one kept apart. The settings it keeps its own are said, with the way back.
 */
export function ShareFoot({ s, recipe }: { s: ClipSource; recipe: RecipeInfo }) {
  const others = s.count - 1;
  const labels = s.apart.map((id) => recipe.inputs.find((i) => i.id === id)?.label ?? id);
  return (
    <div className="flex flex-col gap-2">
      {labels.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-accent/40 bg-accent-wash/40 p-2.5">
          <span className="text-xs"><span className="font-semibold">Set apart from the other {plural(others, "clip")}:</span> <span className="text-ink-2">{labels.join(", ")}</span></span>
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={s.onInLine}>Bring in line</Button>
            <Button size="sm" onClick={s.onToAll}>Give it to all {s.count}</Button>
          </span>
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <span className="grow text-xs text-ink-2">Apply to</span>
        <Segmented<"clip" | "all">
          label="Apply to"
          size="sm"
          oneLine
          value={s.kept ? "clip" : "all"}
          onChange={(v) => s.onKept(v === "clip")}
          options={[{ value: "clip", label: "This clip" }, { value: "all", label: `All ${s.count} clips` }]}
        />
      </div>
    </div>
  );
}
