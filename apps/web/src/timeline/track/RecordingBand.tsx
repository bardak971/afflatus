import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Mic } from "lucide-react";
import { madeAroundRecording, trimIn } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline } from "../../api";
import { clock as mmss, plural } from "../../format";
import { cx } from "../../ui";
import { motionAllowed } from "../../useFlip";
import { RemovedMark } from "./RemovedMark";
import { SOUND } from "./rows";
import { edgeGive, resisted } from "./spring";
import { useSpringBack } from "./useSpringBack";
import { PAD, type Slot } from "../model";

/**
 * The input a model takes a recording in, part by part, and where in it each clip's part starts and lasts: Lip sync's, made
 * around it, or the internal one of a form the recording plays over (Video with audio, card #72), under the same ids.
 */
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
  // the clip before in any form under the same recording (Lip sync, or one it plays over): the song runs on across it
  const theirs = prior ? recordingInput(recipes.find((r) => r.id === prior.recipe)) : null;
  if (!prior || !input || theirs?.id !== input.id || !inputs[input.id] || prior.inputs[input.id] !== inputs[input.id]) return null;
  const end = Number(prior.inputs[input.start]) + Number(prior.inputs[input.seconds]);
  return Math.abs(end - Number(inputs[input.start])) <= 0.05 ? i : null;
}

/** Why Speech starts at is greyed on a clip inside a run (runFrom): said in its "?". */
export const inRunSaid = (before: number) => `Does not apply here: this clip carries the recording on from clip ${before}, which sings right up to its part, so no moment before the words is added (it would play those words twice). It applies on the clip a run starts with.`;

/**
 * The input a Lip sync clip takes its voice in: the recording its form is made around. None on a form a recording only
 * plays over (Video with audio): it is put under one by the recording's cut, never asked for one.
 */
export function voiceInput(recipe: RecipeInfo | undefined) {
  return recipe && madeAroundRecording(recipe.inputs) ? recordingInput(recipe) : null;
}

/**
 * Whether a clip plays its recording over its picture (card #72): under a recording in a form not made around it (Video
 * with audio), the recording its take's sound, unchanged, and its mouth free. Never with no part of it to play (card #88).
 */
export function playsOver(c: Clip, recipes: RecipeInfo[]): boolean {
  return overPart(c, recipes) !== null;
}

/** The part of its recording a clip plays over its picture (playsOver), as "0:10.9–0:18.5" of the recording; null when none. */
export function overPart(c: Clip, recipes: RecipeInfo[]): string | null {
  const recipe = recipes.find((r) => r.id === c.recipe);
  const input = recordingInput(recipe);
  if (!recipe || !input || !c.inputs[input.id] || madeAroundRecording(recipe.inputs)) return null;
  const start = Number(c.inputs[input.start] ?? 0) * 1000;
  const seconds = Number(c.inputs[input.seconds] ?? 0) * 1000;
  return seconds > 0 ? `${mmss(start, { decimals: 1 })}–${mmss(start + seconds, { decimals: 1 })}` : null;
}

/**
 * A Lip sync clip's voice, as its form holds it (the recording laid on its sound): undefined for a clip of a model that
 * takes none, null while it has none, else the recording's id. Its form as it stands (`inputs`, with what was typed and
 * not saved yet) when given.
 */
export function voiceOf(c: Clip, recipe: RecipeInfo | undefined, inputs: Record<string, unknown> = c.inputs): string | null | undefined {
  const input = c.kind === "video" ? voiceInput(recipe) : null;
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
  return recipes.find((r) => r.id !== recipe.id && r.family === recipe.family && r.output === "video" && !r.hidden && r.traits?.sound && !madeAroundRecording(r.inputs) && !r.inputs.some((i) => i.type === "clip" && i.role === "source"));
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

/** The clips made of a recording, whatever their form, in their order on the timeline. */
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
 * aside or brought back, more made at its pauses), as the Recording chapter's In and Out do. A click anywhere on it opens
 * the recording at the moment clicked (card #140: only its name did, and a long timeline zoomed in was scrolled back to
 * the recording's start for every look); its clips are clicked on the Video row.
 */
export function RecordingBands({ timeline, slots, recipes, pps, onTrim, onBringBack, onSelect, onOpen, onMenu, open = null, passDrops = false }: {
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
  /**
   * A click on a band: the recording opened on the stage and in the column, as the source lane opens, its playhead at the
   * moment clicked (`atMs`, in the track's own time); none from the keyboard (where the playhead stands).
   */
  onOpen?(asset: string, atMs?: number): void;
  /** A right-click on a band: the menu of the clip under it, as its Audio cell, which the band covers, gave it. */
  onMenu?(e: ReactMouseEvent, atMs: number): void;
  /** The recording open (its asset's id): its band outlined. */
  open?: string | null;
  /** Something is dragged over the track: the bands let it through to the clips' Audio cells under them (their drops). */
  passDrops?: boolean;
}) {
  return (
    <>
      {(timeline.recordings ?? []).map((r) => (
        <Band key={r.asset.id} recording={r} slots={slots} recipes={recipes} pps={pps} onTrim={onTrim} onBringBack={onBringBack} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} open={open === r.asset.id} passDrops={passDrops} />
      ))}
    </>
  );
}

function Band({ recording, slots, recipes, pps, onTrim, onBringBack, onSelect, onOpen, onMenu, open, passDrops }: {
  recording: NonNullable<Timeline["recordings"]>[number];
  slots: Slot[];
  recipes: RecipeInfo[];
  pps: number;
  onTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  onBringBack?(before: string): void;
  onSelect(clip: string): void;
  onOpen?(asset: string, atMs?: number): void;
  onMenu?(e: ReactMouseEvent, atMs: number): void;
  open: boolean;
  passDrops: boolean;
}) {
  const [held, setHeld] = useState<{ kind: "slip" | "start" | "end"; x: number; atMs: number; fromMs: number; toMs: number; moved: boolean; drawFrom?: number; drawTo?: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
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
  const over = mine.filter((s) => playsOver(s.clip, recipes));
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
    setHeld({ kind, x: e.clientX, atMs: momentOf(e.clientX), fromMs: base.fromMs, toMs: base.toMs, moved: false });
  };
  const clipsNow = mine.map((s) => s.clip);
  /** The moment of the track under the pointer, in the track's own time (the band starts `left` px into the track). */
  const momentOf = (clientX: number) => Math.max(0, Math.round(((left + clientX - (box.current?.getBoundingClientRect().left ?? 0) - PAD) / pps) * 1000));
  /** A click (a press let go without a move): the recording opened at the moment clicked, else its first clip. */
  const opened = (atMs?: number) => (onOpen ? onOpen(asset, atMs) : onSelect(mine[0]!.clip.id));
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
    else if (held && !held.moved) opened(held.atMs);
    setHeld(null);
  };
  const cancel = () => {
    back.stop();
    setHeld(null);
  };
  // an edge: 8 px lit on hover, 24 px to take (WCAG 2.5.8)
  const edge = "pointer-events-auto absolute top-0 bottom-0 w-2 cursor-ew-resize rounded-sm before:absolute before:inset-y-0 before:-inset-x-2 before:content-[''] hover:bg-accent/40";
  return (
    // the whole band takes the press (a removed part's mark keeps its own): let go where it was pressed, the recording opens
    // there; dragged, it slips. The presses on its edges and on its name come up to it, so each is handled once
    <div
      ref={box}
      aria-label={`Recording ${recording.asset.name}: ${stretch}`}
      style={{ left, width: Math.max(12, right - left), top: SOUND.top - 2, height: SOUND.height + 4 }}
      data-open={open || undefined}
      data-recording-band={asset}
      onPointerDown={onTrim ? down("slip") : undefined}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClick={onTrim ? undefined : (e) => opened(momentOf(e.clientX))}
      onContextMenu={onMenu ? (e) => onMenu(e, momentOf(e.clientX)) : undefined}
      className={cx(
        "absolute z-10 rounded-md",
        passDrops ? "pointer-events-none" : "pointer-events-auto",
        onTrim && (held?.moved ? "cursor-grabbing" : "cursor-grab"),
        open ? "border-2 border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_22%,transparent)]" : "border-[1.5px]",
        !open && (held?.moved ? "border-accent" : "border-accent/60"),
      )}
    >
      {/* the parts of the clips it plays over (another form, card #72): hatched, the recording heard over them unchanged; under its name */}
      {over.map((s) => <span key={s.clip.id} aria-hidden data-plays-over={s.index + 1} style={{ left: s.left - left, width: s.width }} className="pointer-events-none absolute inset-y-0 bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--color-accent)_22%,transparent)_0_5px,transparent_5px_10px)]" />)}
      {onTrim && <span aria-hidden data-tip="Drag: where the recording starts (its clips made anew)" onPointerDown={down("start")} className={cx(edge, "-left-[4px]")} />}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Recording ${recording.asset.name}, ${stretch}${recording.parked ? `, ${recording.parked} set aside` : ""}`}
        aria-pressed={onOpen ? open : undefined}
        data-tip={`${recording.asset.name}: ${stretch} of it, under ${plural(mine.length, "clip")}${over.length ? ` (${over.length} it plays over)` : ""}. ${onOpen ? "Click anywhere on it to open it on the stage from there; drag" : "Drag"} it to slip (another part of it, its clips made anew), its edges to trim${recording.parked ? `; ${recording.parked} set aside past its end, back when it is made longer` : ""}`}
        // from the keyboard: opened where the playhead stands
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && opened()}
        // kept in view at the track's left while the band runs on past it (sticky inside the band, in the track's
        // scroller): a long timeline zoomed in showed it only at the recording's start
        className="sticky left-3 mt-1 ml-3 flex h-6 w-fit max-w-[calc(100%-24px)] items-center gap-1 rounded bg-panel/90 px-1.5 text-micro font-semibold text-accent"
      >
        <Mic size={11} className="shrink-0" />
        <span className="truncate">{recording.asset.name} · {stretch}{recording.parked ? ` · +${recording.parked}` : ""}{open ? " · open on the stage" : ""}</span>
      </span>
      {/* where a part was cut out of its middle (its clips removed): the clip after it starts after a cut */}
      {(recording.removed ?? []).map((p) => {
        const after = mine.find((s) => s.clip.id === p.before);
        return after ? <RemovedMark key={p.before} part={p} left={after.left - left} number={after.index + 1} onBringBack={onBringBack} /> : null;
      })}
      {onTrim && <span aria-hidden data-tip="Drag: where the recording ends (clips set aside, or brought back and added at its pauses)" onPointerDown={down("end")} className={cx(edge, "-right-[4px]")} />}
    </div>
  );
}
