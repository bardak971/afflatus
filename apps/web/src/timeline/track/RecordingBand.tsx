import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Mic } from "lucide-react";
import type { Clip, RecipeInfo, Timeline } from "../../api";
import { clock as mmss, plural } from "../../format";
import { cx } from "../../ui";
import { SOUND } from "./rows";
import type { Slot } from "../model";

/** The input a model takes a recording in, part by part (H3 · Lip sync), and where in it each clip's part starts and lasts. */
export function recordingInput(recipe: RecipeInfo | undefined) {
  const spec = recipe?.inputs.find((i) => i.type === "audio" && i.role === "sound" && i.window);
  return spec && spec.type === "audio" && spec.window ? { id: spec.id, start: spec.window.start, seconds: spec.window.seconds } : null;
}

/** The clips made of a recording, in their order on the timeline. */
export function clipsOfRecording(clips: Clip[], recipes: RecipeInfo[], asset: string): Clip[] {
  return clips.filter((c) => {
    const input = recordingInput(recipes.find((r) => r.id === c.recipe));
    return Boolean(input && c.inputs[input.id] === asset);
  });
}

/**
 * The voice recordings of a timeline on its Audio row (the rethink's recording lane): each drawn as one band under the Lip
 * sync clips made of it, its name and the stretch of it they use. Its body dragged slips it (the same length, another part
 * of the recording: the clips made anew), its left edge moves its start (made anew), its right edge its end (clips set
 * aside or brought back, more made at its pauses), as the Recording chapter's In and Out do.
 */
export function RecordingBands({ timeline, slots, recipes, pps, onTrim, onSelect }: {
  timeline: Timeline;
  slots: Slot[];
  recipes: RecipeInfo[];
  pps: number;
  /**
   * The recording's stretch changed: its In and Out, in ms of the recording. Settles true once the change is read back,
   * false when it is not made (asked first, failed, or another one asked for in its place).
   */
  onTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  /** A click on a band: its first clip opened (its Recording chapter). */
  onSelect(clip: string): void;
}) {
  return (
    <>
      {(timeline.recordings ?? []).map((r) => (
        <Band key={r.asset.id} recording={r} slots={slots} recipes={recipes} pps={pps} onTrim={onTrim} onSelect={onSelect} />
      ))}
    </>
  );
}

function Band({ recording, slots, recipes, pps, onTrim, onSelect }: {
  recording: NonNullable<Timeline["recordings"]>[number];
  slots: Slot[];
  recipes: RecipeInfo[];
  pps: number;
  onTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  onSelect(clip: string): void;
}) {
  const [held, setHeld] = useState<{ kind: "slip" | "start" | "end"; x: number; fromMs: number; toMs: number; moved: boolean } | null>(null);
  /**
   * The stretch released, drawn until its clips read back have it (`was`: the one they had then) or it is not made: back
   * to the old one meanwhile, the band looked as if the drag had not been taken, and invited a second one.
   */
  const [sent, setSent] = useState<{ fromMs: number; toMs: number; kind: "slip" | "start" | "end"; was: { fromMs: number; toMs: number }; done: boolean } | null>(null);
  const asset = recording.asset.id;
  const mine = slots.filter((s) => {
    const input = recordingInput(recipes.find((r) => r.id === s.clip.recipe));
    return Boolean(input && s.clip.inputs[input.id] === asset);
  });
  const input = recordingInput(recipes.find((r) => r.id === mine[0]?.clip.recipe));
  const at = (c: Clip) => (input ? Math.round(Number(c.inputs[input.start] ?? 0) * 1000) : 0);
  const fromMs = mine.length ? at(mine[0]!.clip) : 0;
  const toMs = mine.length && input ? at(mine.at(-1)!.clip) + Math.round(Number(mine.at(-1)!.clip.inputs[input.seconds] ?? 0) * 1000) : 0;
  const arrived = Boolean(sent?.done && (fromMs !== sent.was.fromMs || toMs !== sent.was.toMs));
  useEffect(() => {
    if (arrived) setSent(null);
  }, [arrived]);
  if (!mine.length || !input) return null;
  const length = recording.asset.durationMs ?? toMs;
  const drawn = held ?? (sent && !arrived ? sent : null);
  const shown = drawn ?? { fromMs, toMs };
  // a drag starts from the stretch drawn: one released and not yet read back, else its clips'
  const base = sent && !arrived ? sent : { fromMs, toMs };
  // drawn under its clips; while dragged its edges follow the pointer, at the track's scale
  const px = (ms: number) => (ms / 1000) * pps;
  // slipped, the band stays where its clips are: the recording slides under it
  const edged = drawn && drawn.kind !== "slip";
  const left = mine[0]!.left + (edged ? px(shown.fromMs - fromMs) : 0);
  const right = mine.at(-1)!.left + mine.at(-1)!.width + (edged ? px(shown.toMs - toMs) : 0);
  const stretch = `${mmss(shown.fromMs, { decimals: 1 })}–${mmss(shown.toMs, { decimals: 1 })}`;

  const down = (kind: "slip" | "start" | "end") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that cannot be captured is followed while it stays over the band
    }
    setHeld({ kind, x: e.clientX, fromMs: base.fromMs, toMs: base.toMs, moved: false });
  };
  const move = (e: ReactPointerEvent) => {
    if (!held || !onTrim) return;
    const dx = e.clientX - held.x;
    if (!held.moved && Math.abs(dx) < 4) return;
    const dms = Math.round(((dx / pps) * 1000) / 100) * 100;
    if (held.kind === "slip") {
      // the recording slides under its clips: left, the same length of it taken later on
      const span = base.toMs - base.fromMs;
      const from = Math.max(0, Math.min(length - span, base.fromMs - dms));
      setHeld({ ...held, moved: true, fromMs: from, toMs: from + span });
    } else if (held.kind === "start") setHeld({ ...held, moved: true, fromMs: Math.max(0, Math.min(base.toMs - 1000, base.fromMs + dms)) });
    else setHeld({ ...held, moved: true, toMs: Math.max(base.fromMs + 1000, Math.min(length, base.toMs + dms)) });
  };
  const up = () => {
    if (held?.moved && (held.fromMs !== base.fromMs || held.toMs !== base.toMs)) {
      const asked = onTrim?.(asset, held.fromMs, held.toMs);
      // drawn meanwhile; taken, until its clips read back say it; not made, its clips' again at once (a newer release's
      // own drawing is left alone)
      if (asked) {
        const ours = { fromMs: held.fromMs, toMs: held.toMs, kind: held.kind, was: { fromMs, toMs }, done: false };
        setSent(ours);
        void asked.then((taken) => setSent((now) => (now !== ours ? now : taken ? { ...ours, done: true } : null)));
      }
    }
    else if (held && !held.moved) onSelect(mine[0]!.clip.id);
    setHeld(null);
  };
  // an edge: 8 px lit on hover, 24 px to take (WCAG 2.5.8)
  const edge = "pointer-events-auto absolute top-0 bottom-0 w-2 cursor-ew-resize rounded-sm before:absolute before:inset-y-0 before:-inset-x-2 before:content-[''] hover:bg-accent/40";
  return (
    <div
      aria-label={`Recording ${recording.asset.name}: ${stretch}`}
      style={{ left, width: Math.max(12, right - left), top: SOUND.top - 2, height: SOUND.height + 4 }}
      className={cx("pointer-events-none absolute z-10 rounded-md border-[1.5px]", held?.moved ? "border-accent" : "border-accent/60")}
    >
      {onTrim && <span aria-hidden data-tip="Drag: where the recording starts (its clips made anew)" onPointerDown={down("start")} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setHeld(null)} className={cx(edge, "-left-[4px]")} />}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Recording ${recording.asset.name}, ${stretch}${recording.parked ? `, ${recording.parked} set aside` : ""}`}
        data-tip={`${recording.asset.name}: ${stretch} of it, made into ${plural(mine.length, "Lip sync clip")}. Drag it to slip (another part of it, its clips made anew), its edges to trim${recording.parked ? `; ${recording.parked} set aside past its end, back when it is made longer` : ""}`}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(mine[0]!.clip.id)}
        onPointerDown={onTrim ? down("slip") : undefined}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setHeld(null)}
        onClick={onTrim ? undefined : () => onSelect(mine[0]!.clip.id)}
        className={cx("pointer-events-auto absolute top-1 left-3 flex h-6 max-w-[calc(100%-24px)] items-center gap-1 rounded bg-panel/90 px-1.5 text-micro font-semibold text-accent", onTrim && "cursor-grab active:cursor-grabbing")}
      >
        <Mic size={11} className="shrink-0" />
        <span className="truncate">{recording.asset.name} · {stretch}{recording.parked ? ` · +${recording.parked}` : ""}</span>
      </span>
      {onTrim && <span aria-hidden data-tip="Drag: where the recording ends (clips set aside, or brought back and added at its pauses)" onPointerDown={down("end")} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setHeld(null)} className={cx(edge, "-right-[4px]")} />}
    </div>
  );
}
