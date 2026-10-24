import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Mic } from "lucide-react";
import { trimIn } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline } from "../../api";
import { clock as mmss, plural } from "../../format";
import { cx } from "../../ui";
import { motionAllowed } from "../../useFlip";
import { RemovedMark } from "./RemovedMark";
import { SOUND } from "./rows";
import { edgeGive, resisted } from "./spring";
import { useSpringBack } from "./useSpringBack";
import type { Slot } from "../model";

/** The input a model takes a recording in, part by part (H3 · Lip sync), and where in it each clip's part starts and lasts. */
export function recordingInput(recipe: RecipeInfo | undefined) {
  const spec = recipe?.inputs.find((i) => i.type === "audio" && i.role === "sound" && i.window);
  // the fewest seconds a clip takes (as the server's trim reads it), under which an empty clip the end falls in is set aside;
  // the most (the recording's panel's Clip length); and the settings that hold the clip before the words (its speech start)
  return spec && spec.type === "audio" && spec.window
    ? { id: spec.id, start: spec.window.start, seconds: spec.window.seconds, leastMs: (spec.window.fits?.min ?? 1) * 1000, mostMs: spec.window.fits ? (spec.window.fits.frames / spec.window.fits.fps - (spec.window.fits.pad ?? 0)) * 1000 : 15_000, lead: spec.window.fits?.less ?? [] }
    : null;
}

/**
 * Where a Lip sync clip carries on a run of its recording (a song cut into clips end to end): the number of the clip just
 * before it on the timeline, whose part of the same recording ends where its own starts; null when it starts a run or stands
 * alone. Inside a run no moment before the words is added (Speech starts at, TimelinePlan.recordingRun): the clip before sang
 * the song right up to the part, and that moment played those words twice (review S4, card #75).
 */
export function runFrom(clips: Clip[], recipes: RecipeInfo[], c: Clip, inputs: Record<string, unknown> = c.inputs): number | null {
  const i = clips.findIndex((x) => x.id === c.id);
  const prior = i > 0 ? clips[i - 1]! : undefined;
  const input = recordingInput(recipes.find((r) => r.id === c.recipe));
  if (!prior || !input || prior.recipe !== c.recipe || !inputs[input.id] || prior.inputs[input.id] !== inputs[input.id]) return null;
  const end = Number(prior.inputs[input.start]) + Number(prior.inputs[input.seconds]);
  return Math.abs(end - Number(inputs[input.start])) <= 0.05 ? i : null;
}

/** Why Speech starts at is greyed on a clip inside a run (runFrom): said in its "?". */
export const inRunSaid = (before: number) => `Does not apply here: this clip carries the recording on from clip ${before}, which sings right up to its part, so no moment before the words is added (it would play those words twice). It applies on the clip a run starts with.`;

/**
 * A Lip sync clip's voice, as its form holds it (the recording laid on its sound): undefined for a clip of a model that
 * takes none, null while it has none, else the recording's id. Its form as it stands (`inputs`, with what was typed and
 * not saved yet) when given.
 */
export function voiceOf(c: Clip, recipe: RecipeInfo | undefined, inputs: Record<string, unknown> = c.inputs): string | null | undefined {
  const input = c.kind === "video" ? recordingInput(recipe) : null;
  if (!input) return undefined;
  const v = inputs[input.id];
  return typeof v === "string" && v ? v : null;
}

/**
 * What a Lip sync clip without a voice can be switched to: its family's model that makes the clip's own sound, with no
 * recording and no source video to wait for (H3 · Video with audio).
 */
export function ownSoundModel(recipe: RecipeInfo | undefined, recipes: RecipeInfo[]): RecipeInfo | undefined {
  if (!recipe) return undefined;
  return recipes.find((r) => r.id !== recipe.id && r.family === recipe.family && r.output === "video" && !r.hidden && r.traits?.sound && !recordingInput(r) && !r.inputs.some((i) => i.type === "clip" && i.role === "source"));
}

/**
 * Where a recording's end, brought in to `toMs` from `curTo`, comes to rest: the server's own rule (trimIn) over its clips,
 * so that the band draws it there while it is dragged. A rendered clip, or one in the queue, is never shortened (the end goes
 * to its nearer end); an empty one is, down to the fewest seconds a clip takes. An end taken out rests where it is asked.
 */
export function recordingEndRest(clips: Clip[], input: NonNullable<ReturnType<typeof recordingInput>>, curTo: number, toMs: number): number {
  if (toMs >= curTo - 20 || !clips.length) return toMs;
  const parts = clips.map((c) => {
    const start = Number(c.inputs[input.start] ?? 0) * 1000;
    return { id: c.id, from: start, start, end: start + Number(c.inputs[input.seconds] ?? 0) * 1000, whole: Boolean(c.take || c.job), busy: Boolean(c.job) };
  });
  return trimIn(parts, toMs, input.leastMs).toMs;
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
export function RecordingBands({ timeline, slots, recipes, pps, onTrim, onBringBack, onSelect, onOpen, open = null }: {
  timeline: Timeline;
  slots: Slot[];
  recipes: RecipeInfo[];
  pps: number;
  /**
   * The recording's stretch changed: its In and Out, in ms of the recording. Settles true once the change is read back,
   * false when it is not made (asked first, failed, or another one asked for in its place).
   */
  onTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  /** A part cut out of its middle (its mark) brought back, by the clip after it. */
  onBringBack?(before: string): void;
  /** A click on a band without `onOpen`: its first clip opened (its Recording chapter). */
  onSelect(clip: string): void;
  /** A click on a band: the recording opened on the stage and in the column, as the source lane opens. */
  onOpen?(asset: string): void;
  /** The recording open (its asset's id): its band outlined. */
  open?: string | null;
}) {
  return (
    <>
      {(timeline.recordings ?? []).map((r) => (
        <Band key={r.asset.id} recording={r} slots={slots} recipes={recipes} pps={pps} onTrim={onTrim} onBringBack={onBringBack} onSelect={onSelect} onOpen={onOpen} open={open === r.asset.id} />
      ))}
    </>
  );
}

function Band({ recording, slots, recipes, pps, onTrim, onBringBack, onSelect, onOpen, open }: {
  recording: NonNullable<Timeline["recordings"]>[number];
  slots: Slot[];
  recipes: RecipeInfo[];
  pps: number;
  onTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  onBringBack?(before: string): void;
  onSelect(clip: string): void;
  onOpen?(asset: string): void;
  open: boolean;
}) {
  const [held, setHeld] = useState<{ kind: "slip" | "start" | "end"; x: number; fromMs: number; toMs: number; moved: boolean; drawFrom?: number; drawTo?: number } | null>(null);
  /**
   * The stretch released, drawn until its trim settles: back to the old one meanwhile, the band looked as if the drag had
   * not been taken, and invited a second one. Let go on the settle, taken or not (taken, its clips are read back by then):
   * waiting for its clips to change kept a trim the server took but left as it was drawn, and the next drag started from it.
   */
  const [sent, setSent] = useState<{ fromMs: number; toMs: number; kind: "slip" | "start" | "end"; drawTo?: number } | null>(null);
  /**
   * Past a limit (the recording's ends, a second at least between them) the part dragged follows the pointer with
   * resistance, `drawFrom` / `drawTo` where it is drawn (the stretch it gives stays at the limit); an end brought in onto a
   * rendered clip resists toward where it will rest (recordingEndRest) rather than jumping there once let go of. Let go of,
   * or over a clip's middle, it is carried to where it goes on the spring. Slipped, the band itself gives a little.
   */
  const back = useSpringBack<"slip" | "start" | "end">();
  const asset = recording.asset.id;
  const mine = slots.filter((s) => {
    const input = recordingInput(recipes.find((r) => r.id === s.clip.recipe));
    return Boolean(input && s.clip.inputs[input.id] === asset);
  });
  const input = recordingInput(recipes.find((r) => r.id === mine[0]?.clip.recipe));
  const at = (c: Clip) => (input ? Math.round(Number(c.inputs[input.start] ?? 0) * 1000) : 0);
  const fromMs = mine.length ? at(mine[0]!.clip) : 0;
  const toMs = mine.length && input ? at(mine.at(-1)!.clip) + Math.round(Number(mine.at(-1)!.clip.inputs[input.seconds] ?? 0) * 1000) : 0;
  if (!mine.length || !input) return null;
  const length = recording.asset.durationMs ?? toMs;
  const drawn = held ?? sent;
  const shown = drawn ?? { fromMs, toMs };
  // a drag starts from the stretch drawn: one released and not yet settled, else its clips'
  const base = sent ?? { fromMs, toMs };
  // drawn under its clips; while dragged its edges follow the pointer, at the track's scale
  const px = (ms: number) => (ms / 1000) * pps;
  // slipped, the band stays where its clips are (the recording slides under it), but for what it gives past a limit
  const edged = drawn && drawn.kind !== "slip";
  const carried = (kind: "slip" | "start" | "end") => (back.left.tag === kind ? back.left.px : 0);
  const slipped = (held?.kind === "slip" && held.drawFrom !== undefined ? -px(held.drawFrom - held.fromMs) : 0) - carried("slip");
  const lineFrom = held?.kind === "start" && held.drawFrom !== undefined ? held.drawFrom : shown.fromMs;
  const lineTo = held ? (held.kind === "end" && held.drawTo !== undefined ? held.drawTo : shown.toMs) : (sent?.drawTo ?? shown.toMs);
  const left = mine[0]!.left + (edged ? px(lineFrom - fromMs) : 0) + carried("start") + slipped;
  const right = mine.at(-1)!.left + mine.at(-1)!.width + (edged ? px(lineTo - toMs) : 0) + carried("end") + slipped;
  const stretch = `${mmss(shown.fromMs, { decimals: 1 })}–${mmss(shown.toMs, { decimals: 1 })}`;

  const down = (kind: "slip" | "start" | "end") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that cannot be captured is followed while it stays over the band
    }
    back.stop();
    setHeld({ kind, x: e.clientX, fromMs: base.fromMs, toMs: base.toMs, moved: false });
  };
  const clipsNow = mine.map((s) => s.clip);
  /** A click (a press let go without a move): the recording opened, else its first clip. */
  const opened = () => (onOpen ? onOpen(asset) : onSelect(mine[0]!.clip.id));
  /** Where an end let go of at `to` comes to rest: onto a rendered clip's nearer end. */
  const restOf = (to: number) => (to !== base.toMs ? recordingEndRest(clipsNow, input, toMs, to) : to);
  /** The part dragged as drawn now, in px along the track (what the spring still carries included). */
  const edgeNow = (h: NonNullable<typeof held>) => px(h.kind === "end" ? (h.drawTo ?? h.toMs) : (h.drawFrom ?? h.fromMs)) + carried(h.kind);
  const move = (e: ReactPointerEvent) => {
    if (!held || !onTrim) return;
    const dx = e.clientX - held.x;
    if (!held.moved && Math.abs(dx) < 4) return;
    const dms = Math.round(((dx / pps) * 1000) / 100) * 100;
    const raw = (dx / pps) * 1000;
    const give = edgeGive(px(base.toMs - base.fromMs));
    const free = motionAllowed();
    // how much further than `lo`..`hi` it is drawn for a pointer asking `asked`, in ms (0 within them)
    const past = (asked: number, lo: number, hi: number) => (resisted(px(asked), px(lo), px(hi), give, free) - px(Math.max(lo, Math.min(hi, asked)))) * (1000 / pps);
    let next: NonNullable<typeof held>;
    if (held.kind === "slip") {
      // the recording slides under its clips: left, the same length of it taken later on
      const span = base.toMs - base.fromMs;
      const from = Math.max(0, Math.min(length - span, base.fromMs - dms));
      next = { ...held, moved: true, fromMs: from, toMs: from + span, drawFrom: from + past(base.fromMs - raw, 0, length - span) };
    } else if (held.kind === "start") {
      const from = Math.max(0, Math.min(base.toMs - 1000, base.fromMs + dms));
      next = { ...held, moved: true, fromMs: from, drawFrom: from + past(base.fromMs + raw, 0, base.toMs - 1000) };
    } else {
      const lo = base.fromMs + 1000;
      const to = Math.max(lo, Math.min(length, base.toMs + dms));
      // brought in onto a rendered clip, it resists toward where it will rest (the clip's nearer end) instead
      const rest = restOf(to);
      const drawTo = rest === to ? to + past(base.toMs + raw, lo, length) : rest + past(Math.max(lo, Math.min(length, base.toMs + raw)), rest, rest);
      next = { ...held, moved: true, toMs: to, drawTo };
      // over a clip's middle, where it rests changes sides: carried across on the spring rather than jumping there
      if (held.moved && restOf(held.toMs) !== rest) back.jump(edgeNow(held), px(drawTo), "end");
    }
    back.seen(edgeNow(next));
    setHeld(next);
  };
  const up = () => {
    if (held?.moved) {
      let asked: Promise<boolean> | void = undefined;
      if (held.fromMs !== base.fromMs || held.toMs !== base.toMs) asked = onTrim?.(asset, held.fromMs, held.toMs);
      // where it is drawn from now: an end where it will rest, while the trim is on its way; else the stretch it had
      const rest = held.kind === "end" ? restOf(held.toMs) : held.fromMs;
      const after = asked ? rest : held.kind === "end" ? (sent?.drawTo ?? base.toMs) : base.fromMs;
      // drawn past a limit, or short of where it will rest: carried there from where it was let go of, on the spring
      back.jump(edgeNow(held), px(after), held.kind);
      // drawn meanwhile; settled, its clips' again, read back by then when taken (a newer release's own drawing is left
      // alone)
      if (asked) {
        const ours = { fromMs: held.fromMs, toMs: held.toMs, kind: held.kind, ...(held.kind === "end" ? { drawTo: rest } : {}) };
        setSent(ours);
        void asked.then(() => setSent((now) => (now === ours ? null : now)));
      }
    }
    else if (held && !held.moved) opened();
    setHeld(null);
  };
  const cancel = () => {
    back.stop();
    setHeld(null);
  };
  // an edge: 8 px lit on hover, 24 px to take (WCAG 2.5.8)
  const edge = "pointer-events-auto absolute top-0 bottom-0 w-2 cursor-ew-resize rounded-sm before:absolute before:inset-y-0 before:-inset-x-2 before:content-[''] hover:bg-accent/40";
  return (
    <div
      aria-label={`Recording ${recording.asset.name}: ${stretch}`}
      style={{ left, width: Math.max(12, right - left), top: SOUND.top - 2, height: SOUND.height + 4 }}
      data-open={open || undefined}
      className={cx("pointer-events-none absolute z-10 rounded-md", open ? "border-2 border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_22%,transparent)]" : "border-[1.5px]", !open && (held?.moved ? "border-accent" : "border-accent/60"))}
    >
      {onTrim && <span aria-hidden data-tip="Drag: where the recording starts (its clips made anew)" onPointerDown={down("start")} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} className={cx(edge, "-left-[4px]")} />}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Recording ${recording.asset.name}, ${stretch}${recording.parked ? `, ${recording.parked} set aside` : ""}`}
        aria-pressed={onOpen ? open : undefined}
        data-tip={`${recording.asset.name}: ${stretch} of it, made into ${plural(mine.length, "Lip sync clip")}. ${onOpen ? "Click to open it on the stage; drag" : "Drag"} it to slip (another part of it, its clips made anew), its edges to trim${recording.parked ? `; ${recording.parked} set aside past its end, back when it is made longer` : ""}`}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && opened()}
        onPointerDown={onTrim ? down("slip") : undefined}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onClick={onTrim ? undefined : opened}
        className={cx("pointer-events-auto absolute top-1 left-3 flex h-6 max-w-[calc(100%-24px)] items-center gap-1 rounded bg-panel/90 px-1.5 text-micro font-semibold text-accent", onTrim && "cursor-grab active:cursor-grabbing")}
      >
        <Mic size={11} className="shrink-0" />
        <span className="truncate">{recording.asset.name} · {stretch}{recording.parked ? ` · +${recording.parked}` : ""}{open ? " · open on the stage" : ""}</span>
      </span>
      {/* where a part was cut out of its middle (its clips removed): the clip after it starts after a cut */}
      {(recording.removed ?? []).map((p) => {
        const after = mine.find((s) => s.clip.id === p.before);
        return after ? <RemovedMark key={p.before} part={p} left={after.left - left} number={after.index + 1} onBringBack={onBringBack} /> : null;
      })}
      {onTrim && <span aria-hidden data-tip="Drag: where the recording ends (clips set aside, or brought back and added at its pauses)" onPointerDown={down("end")} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} className={cx(edge, "-right-[4px]")} />}
    </div>
  );
}
