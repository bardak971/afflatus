import { Crosshair, Eye } from "lucide-react";
import { Slide } from "./parts";
import type { RecipeInfo, Timeline } from "../../api";
import { clock as mmss, plural } from "../../format";
import type { LeadPart } from "../../RecipeForm";
import { Button, NumberBox, Segmented, Toggle } from "../../ui";

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
  onCut(change: { windowMs?: number; snap?: boolean; inputs?: Record<string, unknown> }): void;
  cutting: boolean;
  /**
   * Show the mask (the owner's mock, 2026-10-18): asked for this clip's window, where it stands, and whether its video is
   * drawn over the source on the stage. Only the first window: the click decides the person there; the windows after
   * follow the one before's rendered frames, which a preview does not have.
   */
  mask: { status: "none" | "waiting" | "ready" | "failed"; error?: string | null; shown: boolean };
  onShowMask(): void;
  onMaskShown(on: boolean): void;
  /** Every window the source made, in order: its clip, its part, how it opens, its run-up, whether its prompt is its own, rendered. */
  list: Array<{ id: string; number: number; startMs: number; seconds: number; opens: boolean; form: string; carried: number; own: boolean; rendered: boolean }>;
  onSelectWindow(id: string): void;
  /** Frames from the clip before, for every window (H3's 5 / 22 / 39): changed, the source is cut again. Null: the model has one count. */
  runUp: { counts: number[]; value: number; on(n: number): void } | null;
  /** The source's start moved after Make, rendered windows in the way: said here, Change or Keep. */
  stretchAsk: { fromMs: number; rendered: number; windows: number; change(): void; keep(): void } | null;
  /** The stretch's In and Out typed (seconds of the source): a trim after Make, as the lane's drags. */
  onUses(fromMs: number, toMs: number): void;
  /** A trim of its stretch is on its way, or waits for the one before (a drag, I / O, In / Out typed). */
  trimming: boolean;
  /** Another form asked for on another grid, rendered windows in the way: said here, Change or Keep. */
  formAsk: { title: string; rendered: number; windows: number; change(): void; keep(): void } | null;
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
    help: "The video this clip is a part of, shared by every clip the source made, and how it is cut into windows. Changed, the source is cut again after its rendered clips.",
    summary: `${s.source.video.name} · ${stretch}`,
    node: (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-semibold">{s.source.video.name}</span>
          <span className="text-xs text-ink-2">
            {stretch} made into {plural(s.count, "clip")} · this one {mmss(start, { decimals: 1 })}–{mmss(start + seconds, { decimals: 1 })}
          </span>
        </div>
        {s.formAsk && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-warn-wash/40 p-2.5">
            <span className="text-xs">
              <span className="font-semibold">{s.formAsk.title} cuts the source on another grid:</span>{" "}
              <span className="text-ink-2">its {plural(s.formAsk.windows, "window")} are cut again; {plural(s.formAsk.rendered, "rendered take")} go to the library (Undo brings them back).</span>
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" tone="primary" onClick={s.formAsk.change}>Change</Button>
              <Button size="sm" onClick={s.formAsk.keep}>Keep it</Button>
            </span>
          </div>
        )}
        {s.stretchAsk && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-warn-wash/40 p-2.5">
            <span className="text-xs">
              <span className="font-semibold">The source starting at {mmss(s.stretchAsk.fromMs, { decimals: 1 })} shifts every window:</span>{" "}
              <span className="text-ink-2">its {plural(s.stretchAsk.windows, "window")} are made anew; {plural(s.stretchAsk.rendered, "rendered take")} go to the library (Undo brings them back). To keep them, trim its end instead.</span>
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" tone="primary" onClick={s.stretchAsk.change}>Change</Button>
              <Button size="sm" onClick={s.stretchAsk.keep}>Keep it</Button>
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="grow text-xs font-semibold">Uses</span>
          <NumberBox label="In (s of the source)" value={s.source.fromMs / 1000} min={0} max={Math.max(0, s.source.toMs / 1000 - 1)} step={0.1} unit=" s" onCommit={(v) => s.onUses(Math.round(v * 1000), s.source.toMs)} />
          <span className="text-ink-3">→</span>
          <NumberBox label="Out (s of the source)" value={s.source.toMs / 1000} min={s.source.fromMs / 1000 + 1} max={(s.source.video.durationMs ?? s.source.toMs) / 1000} step={0.1} unit=" s" onCommit={(v) => s.onUses(s.source.fromMs, Math.round(v * 1000))} />
        </div>
        {s.trimming && <span className="text-xs text-ink-2">Trimming the source…</span>}
        <Slide label="Window" value={Math.min(Math.max(s.source.windowMs, s.windows.leastMs), s.windows.mostMs)} min={s.windows.leastMs} max={s.windows.mostMs} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(windowMs) => s.onCut({ windowMs })} />
        <Toggle on={s.source.snap} disabled={s.cutting} onChange={(snap) => s.onCut({ snap })} label="Cut at scene changes" note={s.source.snap ? "a window ends at a cut in the source; the next one opens a new shot" : "windows of the same length, end to end"} />
        {s.runUp && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">Frames from the clip before</span>
            <Segmented<string>
              label="Frames from the clip before"
              size="sm"
              oneLine
              value={String(s.runUp.value)}
              onChange={(v) => s.runUp!.on(Number(v))}
              options={s.runUp.counts.map((n, k) => ({ value: String(n), label: s.runUp!.counts.length === 3 ? `${["Tight", "Normal", "Long"][k]} ${n}` : String(n) }))}
            />
          </div>
        )}
        <span className="text-xs text-ink-2">{s.cutting ? "Cutting the source again…" : "Changed, the source is cut again: its rendered clips at the start stay, the others are made anew after them."}</span>
        <WindowList s={s} />
      </div>
    ),
  };
}

/**
 * Every window the source made, as the mock's "each window's own": its clip, its part of the source, its form, whether it
 * opens on the source (a cut) or carries on, its run-up, and whether its prompt is its own or window 1's. A click selects its clip.
 */
function WindowList({ s }: { s: ClipSource }) {
  if (s.list.length < 2) return null;
  return (
    <div className="flex flex-col">
      <span className="pb-1 text-xs font-semibold">Each window</span>
      {s.list.map((x, k) => (
        <button key={x.id} type="button" onClick={() => s.onSelectWindow(x.id)} className="grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-2 border-t border-line py-1.5 text-left text-xs hover:bg-hover">
          <span className="font-semibold">{x.number}</span>
          <span className="truncate">
            <span className="font-mono">{mmss(x.startMs, { decimals: 1 })}–{mmss(x.startMs + x.seconds * 1000, { decimals: 1 })}</span>
            <span className="text-ink-2"> · {x.form ? `${x.form} · ` : ""}{x.opens ? "opens on the source" : `carries on · ${x.carried}`}{k > 0 ? ` · ${x.own ? "its own prompt" : "window 1's prompt"}` : ""}</span>
          </span>
          <span className={x.rendered ? "text-good" : "text-ink-3"}>{x.rendered ? "rendered" : "empty"}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * What the screen puts at the top of the swap's Mask card (the owner, 2026-10-18: Source and Mask as two cards): who is
 * replaced, clicked on the stage, and Show the mask. Nothing of it with the Mask off: SAM tracks no one then.
 */
export function MaskChapter({ s, maskOn }: { s: ClipSource; maskOn: boolean }) {
  if (!s.takesPick || !maskOn) return null;
  return (
    <div className="flex flex-col gap-3">
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
      {s.first && <MaskLine s={s} />}
    </div>
  );
}

/** Show the mask: asked, followed, then drawn over the source on the stage (in the accent colour) or not. */
function MaskLine({ s }: { s: ClipSource }) {
  const m = s.mask;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold">Mask</span>
      {m.status === "waiting" ? (
        <span className="text-xs text-ink-2">Tracking the person and making the mask… a short job in the queue, SAM 3 only.</span>
      ) : m.status === "ready" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Toggle on={m.shown} onChange={s.onMaskShown} label="On the stage" note="what H3 makes again in the accent colour, the band pasted back lighter, over this window" />
          <Button size="sm" tone="quiet" onClick={s.onShowMask}>Make it again</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={s.onShowMask} disabled={!s.source.pick}><Eye size={14} aria-hidden /> Show the mask</Button>
          <span className="text-xs text-ink-2">{m.status === "failed" ? `It failed: ${m.error ?? "see the Queue"}` : s.source.pick ? "what SAM 3 follows and what H3 makes again, before you render" : "pick who is replaced first"}</span>
        </div>
      )}
    </div>
  );
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
