import { memo, useEffect, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type Ref, type RefObject } from "react";
import { Link2, Mic, Scissors, TriangleAlert, VolumeX, X } from "lucide-react";
import { STRIP_FRAMES, stripUrl, thumbUrl, type Clip, type RecipeInfo } from "../../api";
import { est, phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { Bar, Chip, cx } from "../../ui";
import { useQueueOf } from "../../screens/studio/queueOf";
import { useRunningOf } from "../useRunning";
import { modelsDiffer, TRANSITION_MS, TRANSITIONS, transitionSpan, type Transition } from "@afflatus/core";
import { canExtend, fileVersion, PAD, pinInputs, pinMirrors, playAt, titleOf, type PinWhere, type Slot, type TimeRange } from "../model";
import { change, DRIFT } from "../lookDrift";
import { SWATCH } from "../transitionLook";
import { flipped, MirrorMark } from "../MirrorMark";
import { motionAllowed } from "../../useFlip";
import { HINTS, type PinPlace } from "./peek";
import { ROW, SOUND } from "./rows";
import type { Motion } from "./useMotionMarks";
import { edgeGive, resisted } from "./spring";
import type { Over } from "./useTrackDrop";
import { useSpringBack } from "./useSpringBack";
import { Wave } from "./Wave";

/**
 * An edge being dragged: the clip, which edge, and the length drawn for now (past a limit, a little more: useStretch).
 * `settling`: let go of past a limit, it springs back to it, the trim already sent.
 */
export type Stretch = { clip: string; side: "start" | "end"; lengthMs: number; settling?: boolean };

/** What a clip on the track does when it is clicked, dragged or pressed: read at that moment, so that the clips need not draw again when only these change. */
export interface TrackClipActs {
  /** A pointer's x, in the track's own pixels. */
  xOf(clientX: number): number;
  slots: Slot[];
  totalMs: number;
  pps: number;
  range: TimeRange | null;
  /** The pointer leaves the clip, or presses on it: a pinned picture's card goes. */
  leaveTip(): void;
  /** The pointer resting on one of its pinned pictures (null: leaving it). */
  restPin(clip: string, where: PinPlace | null, el?: HTMLImageElement): void;
  /** Something is dragged over the clip. */
  overClip(e: DragEvent, s: Slot): void;
  /** Something is dragged over the join before it (its dot, its transition). */
  overJoin(e: DragEvent, s: Slot): void;
  /** Something is dragged over the Audio cell of a Lip sync clip that has no voice: a recording becomes its voice. */
  overVoice(e: DragEvent, s: Slot): void;
  /** Right-click on that cell: Choose a recording for it, Open an audio file, Switch it to its family's Video with audio. */
  onVoiceMenu(clip: Clip, e: React.MouseEvent): void;
  /** Its edges: drag to shorten it (or to give back what was cut). */
  startPull(e: ReactPointerEvent, s: Slot, side: "start" | "end"): void;
  movePull(e: ReactPointerEvent): void;
  endPull(): void;
  onSelect(clip: string): void;
  onPick?(clip: string): void;
  onRange(range: TimeRange | null): void;
  onSeek(playMs: number, trackMs?: number): void;
  onMenu?(clip: Clip, e: React.MouseEvent): void;
  onSoundMenu?(clip: Clip, e: React.MouseEvent): void;
  /** A right-click on one of its pinned pictures: that frame's menu (Mirror, Open, Remove). */
  onPinMenu?(clip: Clip, where: PinWhere, e: React.MouseEvent): void;
  onStop(job: string): void;
  onJoin?(clip: Clip, joined: "continue" | "cut"): void;
  /** The join before a clip, opened in the column (a click on its dot or its transition). */
  onOpenJoin?(clip: Clip): void;
  /** A new clip put in after `after` (the + on a join, the mock's insert): its model then chosen in the column. */
  onNewClip?(after: string): void;
  /** A cut's transition set (its length dragged by an edge). */
  onTransition?(clip: string, transition: Transition | null): void;
  /** Render a clip that has nothing to play yet. */
  render(clip: Clip): void;
  /** The clip itself moved along the track by the pointer (useClipDrag): pressed, moved, let go of, taken back by the browser. */
  clipDown(e: ReactPointerEvent<HTMLElement>, s: Slot): void;
  clipMove(e: ReactPointerEvent): void;
  clipUp(e: ReactPointerEvent): void;
  clipCancel(): void;
  /** Its wrapper, which the drag moves; and whether a click is the end of a drag (then not a click). */
  mount(clip: string): Ref<HTMLDivElement>;
  dragged(): boolean;
}

/**
 * One clip on the track: its frames at their length, its number and title, what is pinned to it, its render
 * or its state, its edges to trim it by, the join before it, and its sound under it. Memoised: it draws again
 * only when what it shows changes (its render's progress is read by its own small parts).
 */
/** A clip's edges are drawn to trim it by: it is selected, rendered and not in the queue. */
export const trimmable = (s: Slot | undefined, selected: string | null) => Boolean(s && s.clip.id === selected && !s.planned && !s.clip.job);

/**
 * The "+" on the join before `s` is left out: the selected clip's edge to trim it by is drawn under it (the start of `s`, a
 * video, or the end of the clip before). Drawn over the edge's top, it took the press there and put a clip in instead.
 */
export const joinCovered = (slots: Slot[], s: Slot, selected: string | null) =>
  (trimmable(s, selected) && s.clip.kind === "video") || trimmable(slots[s.index - 1], selected);

/** How long a clip's film strip waits for its motion before it is asked for all the same. */
const STRIP_WAIT_MS = 8000;

export const TrackClip = memo(function TrackClip({ s, prev, prevRecipe, recipe, misfit, on, edged, picked, rendering, stretch, over, pinOn, ownSound, fileSound, renderMs, lift, moving, near, voice, acts }: {
  s: Slot;
  /**
   * A Lip sync clip's voice: the recording's name, null while it has none (said in amber on its face and in its Audio cell,
   * which then takes one); undefined for a clip of any other model.
   */
  voice?: string | null;
  /** It is the clip moved by the pointer: held, or landing in its slot after the release. */
  lift?: "held" | "landing";
  /** A clip is being moved: the joins are not drawn meanwhile (each says how its clip follows the one before, which changes). */
  moving: boolean;
  /** The pointer is near the join before it: its "+" shows. */
  near: boolean;
  /** A trim edge is drawn on the join before it (joinCovered): no "+" there. */
  edged: boolean;
  /** The clip before it on the track, and its model. */
  prev: Clip | undefined;
  prevRecipe: RecipeInfo | undefined;
  recipe: RecipeInfo | undefined;
  /** Of another aspect ratio than the timeline. */
  misfit: boolean;
  on: boolean;
  picked: boolean;
  /** It is the clip that renders now. */
  rendering: boolean;
  stretch: Stretch | null;
  /** What a drop on it would do, while something is dragged over it. */
  over: Over | null;
  /** Its pinned picture whose card shows, if any. */
  pinOn?: PinPlace | null;
  /** How its take's own sound and its sound file sound, once measured. */
  ownSound: Motion | undefined;
  fileSound: Motion | undefined;
  /** Nothing to play yet and it can be rendered from here: about how long it takes (null: no figure yet). undefined: it cannot. */
  renderMs: number | null | undefined;
  acts: RefObject<TrackClipActs>;
}) {
  const a = () => acts.current;
  const c = s.clip;
  const live = rendering;
  const pins = pinInputs(recipe);
  const carries = s.index > 0 && c.joined === "continue";
  const opens = !carries && pins.start && typeof c.inputs[pins.start] === "string" ? (c.inputs[pins.start] as string) : null;
  const ends = pins.end && typeof c.inputs[pins.end] === "string" ? (c.inputs[pins.end] as string) : null;
  // the film strip waits for the clip's motion (or a few seconds, when it cannot be had): a first opening asks for every
  // clip's strip at once, and forty pictures took the browser's six connections, so the measures the tracks snap to and
  // the editor's other reads waited behind them
  const [waited, setWaited] = useState(false);
  /**
   * A transition's length while one of its edges is dragged (`held`), the length it gives and the length drawn: past what
   * it may be, a little more, with resistance; let go of there, drawn on until it has sprung back (`back`).
   */
  const [pulling, setPulling] = useState<{ ms: number; drawnMs: number; held: boolean } | null>(null);
  const back = useSpringBack();
  const sprung = back.left.tag === null;
  useEffect(() => {
    if (pulling && !pulling.held && sprung) setPulling(null);
  }, [pulling, sprung]);
  useEffect(() => {
    if (ownSound || waited) return;
    const t = setTimeout(() => setWaited(true), STRIP_WAIT_MS);
    return () => clearTimeout(t);
  }, [ownSound, waited]);
  // the frames along the clip: as many as fit, each from the moment it stands at
  const video = c.take?.asset;
  const cells: number[] = [];
  if (video?.durationMs && video.width && video.height && (ownSound || waited)) {
    const count = Math.max(1, Math.round(s.width / Math.max(24, ROW.height * (video.width / video.height))));
    const from = stretch?.clip === c.id && stretch.side === "start" ? c.take!.endMs - s.lengthMs : c.take!.startMs;
    for (let k = 0; k < count; k++) cells.push(Math.min(STRIP_FRAMES - 1, Math.max(0, Math.floor(((from + ((k + 0.5) / count) * s.lengthMs) / video.durationMs) * STRIP_FRAMES))));
  }
  const pinned = over?.kind === "pin" && over.clip === c.id ? over.where : null;
  // the face of the take that plays, slid from the clip before's past what the drift table warns of (Face Match's figure
  // against the person's picture): a small dot on the clip, its figures in the hover card (card #18). Nothing while it holds
  const face = c.take?.measure?.face;
  const before = prev?.take?.measure?.face;
  const slid = change(face, before, 0.05);
  const drifts = slid !== null && slid < DRIFT.face;
  const through = pins.mid && pins.midAt && typeof c.inputs[pins.mid] === "string" ? { asset: c.inputs[pins.mid] as string, part: Math.max(0.15, Math.min(0.85, (Number(c.inputs[pins.midAt] ?? 2.5) * 1000) / Math.max(1, s.lengthMs))) } : null;
  // which of its pinned pictures are mirrored at render time: shown flipped, a ↔ on their corner
  const mirrored = new Set(pinMirrors(c, recipe, c.inputs, carries).filter((m) => m.on).map((m) => m.where));
  const pinMenu = (where: PinWhere) => (e: React.MouseEvent) => {
    const { onPinMenu, onSelect } = a();
    if (!onPinMenu) return;
    // the frame's menu, not the clip's under it
    e.stopPropagation();
    e.preventDefault();
    onSelect(c.id);
    onPinMenu(c, where, e);
  };
  // not rendered yet, a model that makes its own sound says so, neutral: what will be heard there once it is
  const heard = c.kind === "still" || s.planned ? (c.sound === "file" ? c.soundAsset?.name || "Audio file" : s.planned && recipe?.traits?.sound && voice === undefined ? "own sound, once rendered" : "") : c.sound === "file" ? c.soundAsset?.name || "Audio file" : c.sound === "muted" ? "Muted" : video?.hasSound ? "Own audio" : "Silent";
  return (
    // its parts in one wrapper at the track's origin, laid out from its slot: a clip moved by the pointer moves them together
    <div ref={acts.current.mount(c.id)} className={cx("absolute top-0 left-0", lift && "z-sticky")}>
      {/* a div that acts as a button, not a button: the stop button of a render sits inside it, and a button holds no button */}
      <div
        role="button"
        tabIndex={0}
        onDragOver={(e) => a().overClip(e, s)}
        onPointerLeave={() => a().leaveTip()}
        onPointerDown={(e) => {
          a().leaveTip();
          // moved by the pointer itself, not by the browser's drag picture (review 4, P7); not while an edge is pulled
          if (!stretch || stretch.settling) a().clipDown(e, s);
        }}
        onPointerMove={(e) => a().clipMove(e)}
        onPointerUp={(e) => a().clipUp(e)}
        onPointerCancel={() => a().clipCancel()}
        onKeyDown={(e) => {
          // Ctrl+Enter is the editor's (it renders the selected clip)
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ") || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          a().onSelect(c.id);
        }}
        onClick={(e) => {
          const { onPick, onRange, range, onSelect, xOf, onSeek, slots, totalMs, pps, dragged } = a();
          if (dragged()) return;
          // Ctrl: the clip is picked (or dropped) for a render of several together
          if ((e.ctrlKey || e.metaKey) && onPick) {
            onPick(c.id);
            return;
          }
          // Shift: the range reaches to cover this clip too (or starts as this clip)
          if (e.shiftKey && c.lengthMs > 0) {
            onRange(range ? { inMs: Math.min(range.inMs, c.atMs), outMs: Math.max(range.outMs, c.atMs + c.lengthMs) } : { inMs: c.atMs, outMs: c.atMs + c.lengthMs });
            return;
          }
          onSelect(c.id);
          const x = xOf(e.clientX);
          onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
        }}
        onContextMenu={(e) => {
          const { onMenu, onSelect } = a();
          if (!onMenu) return;
          onSelect(c.id);
          onMenu(c, e);
        }}
        aria-pressed={on}
        data-hint={HINTS.clip}
        // a clip that has its picture is read over it: the colours of the dark stage
        data-stage={s.planned ? undefined : ""}
        aria-label={`Clip ${s.index + 1}, ${titleOf(c, recipe)}${s.planned ? ", not rendered yet" : `, ${(c.lengthMs / 1000).toFixed(1)} seconds`}`}
        style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: ROW.top, height: ROW.height }}
        className={cx(
          "absolute touch-none overflow-hidden rounded-lg border-2 text-left",
          lift === "held" ? "cursor-grabbing shadow-pop" : "cursor-grab",
          on ? "border-accent" : picked ? "border-accent/60" : s.planned ? (c.failed ? "border-dashed border-warn/50" : "border-dashed border-line-strong") : "border-line-strong",
          picked && "ring-2 ring-accent/40",
          s.planned && "bg-raised",
        )}
      >
        {cells.length > 0 && (
          <span className="absolute inset-0 flex">
            {cells.map((frame, k) => (
              <span key={k} className="h-full grow bg-raised" style={{ backgroundImage: `url(${stripUrl(video!.id)}&v=${fileVersion(video!)})`, backgroundSize: `${STRIP_FRAMES * 100}% 100%`, backgroundPosition: `${(frame / (STRIP_FRAMES - 1)) * 100}% 0` }} />
            ))}
          </span>
        )}
        {c.kind === "still" && c.still && <img src={thumbUrl(c.still.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
        {live && <ClipLive clip={c.id} />}
        {/* its number only: the frames stay clean (the prompt is in its hover card and its panel) */}
        <span className="absolute top-1 left-1.5 rounded bg-ground/85 px-1.5 py-px text-meta font-bold">{s.index + 1}</span>
        {/* nothing to play yet: what it will be, in its own words, beside its number (clear of its pinned pictures) */}
        {s.planned && !c.job && s.width > 100 && (
          <span className={cx("absolute top-1.5 left-9 truncate text-meta text-ink-2", voice !== undefined && s.width > 150 ? "right-30" : "right-2")}>{titleOf(c, recipe)}</span>
        )}
        {/* a Lip sync clip's voice on its face: amber while it has none, told apart before it is clicked; its recording's name once it has one */}
        {voice !== undefined && s.width > 64 && (
          <span className="absolute top-1 right-1.5 flex max-w-[45%] justify-end">
            {voice === null ? (
              <Chip size="xs" tone="attention" tip={`Clip ${s.index + 1} needs a voice recording: drop one on its Audio cell`}><Mic size={10} />needs a voice</Chip>
            ) : (
              // the icon outside the cut name: inside a truncated chip it took a line of its own
              <Chip size="xs" tip={`Its voice: ${voice}`} className="max-w-full min-w-0 shrink!"><Mic size={10} className="shrink-0" /><span className="min-w-0 truncate">{voice}</span></Chip>
            )}
          </span>
        )}
        <span className="absolute inset-x-1.5 bottom-1 flex items-end justify-between gap-1">
          {c.job ? (
            <span className="flex min-w-0 grow flex-col gap-1 rounded bg-ground/85 px-1.5 py-1 text-meta">
              <span className="flex items-center gap-1">
                <span className="min-w-0 grow truncate font-semibold">{live ? <ClipPhase clip={c.id} /> : "Queued"}</span>
                <button
                  type="button"
                  aria-label={live ? `Stop the render of clip ${s.index + 1}` : `Remove clip ${s.index + 1} from the queue`}
                  data-hint={live ? "click: stop the render" : "click: remove it from the queue"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    a().onStop(c.job!.id);
                  }}
                  // 16 px drawn in the queued box, 24 px to take (WCAG 2.5.8)
                  className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-2 before:absolute before:-inset-1 before:content-[''] hover:bg-hover hover:text-ink"
                >
                  <X size={10} />
                </button>
              </span>
              {live ? <ClipBar clip={c.id} /> : <Bar value={0} />}
            </span>
          ) : (
            <>
              {s.planned && renderMs !== undefined && s.width > 70 ? (
                // the render it is waiting for, from here: Render (Retry after a failure, its reason on hover) and about how long
                <span className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-tip={c.failed ? `The render failed: ${c.failed}` : "Render this clip"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      a().render(c);
                    }}
                    className={cx("flex h-6 shrink-0 items-center rounded-chip px-2 text-meta font-bold hover:brightness-110", c.failed ? "bg-warn-wash text-warn-ink" : "border border-line-strong bg-raised text-ink")}
                  >
                    {c.failed ? "Retry" : "Render"}
                  </button>
                  <span className={cx("truncate font-mono text-micro", c.failed ? "text-warn-ink" : "text-ink-3")}>{c.failed ? "failed" : est(renderMs)}</span>
                </span>
              ) : (
                // a length is never cut short ("3.0 s" read as "3", a count or a clip number): the tags beside it give way first
                <span className={cx("rounded bg-ground/85 px-1.5 py-px text-meta", c.failed && s.planned ? "truncate text-warn-ink" : s.planned ? "truncate text-ink-2" : "shrink-0 font-semibold whitespace-nowrap")}>
                  {/* said whole in the room there is, never cut mid-word ("Not rendere…") */}
                  {s.planned ? (c.failed ? (s.width > 150 ? "The render failed" : "Failed") : s.width > 150 ? "Not rendered yet" : s.width > 96 ? "Not rendered" : "…") : `${(s.lengthMs / 1000).toFixed(1)} s`}
                </span>
              )}
              {/* one row high: a tag that does not fit wraps out of sight whole ("St…" and "other…" said nothing), the warning
                  first so it is the one kept; the length beside them never shrinks */}
              <span className="flex h-[18px] min-w-0 flex-wrap items-center justify-end gap-1 overflow-hidden">
                {misfit && s.width > 100 && <span className="rounded bg-ground/85 px-1.5 py-px text-micro whitespace-nowrap text-attention-ink" data-tip="Not the timeline's aspect ratio: it is fitted into the frame">other ratio</span>}
                {c.kind === "still" && s.width > 100 && <span className="rounded bg-ground/85 px-1.5 py-px text-micro whitespace-nowrap text-ink-2">Still</span>}
                {c.kind === "video" && !recipe && c.take && s.width > 96 && <span className="rounded bg-ground/85 px-1.5 py-px text-micro whitespace-nowrap text-ink-2">Imported</span>}
                {c.takes.length > 1 && s.width > 110 && <span className="rounded bg-ground/85 px-1.5 py-px text-micro whitespace-nowrap text-ink-2">take {c.takes.findIndex((x) => x.id === c.take?.id) + 1} of {c.takes.length}</span>}
              </span>
              {drifts && (
                <span
                  aria-label={`The face drifts: ${face!.toFixed(2)} against ${before!.toFixed(2)} in clip ${s.index}`}
                  data-tip={`The face drifts from clip ${s.index}'s: ${face!.toFixed(2)} against ${before!.toFixed(2)} (Face Match, against the person's picture). Another take may hold it`}
                  className="absolute top-1.5 right-1.5 z-3 h-2.5 w-2.5 rounded-full bg-attention ring-2 ring-ground/70"
                />
              )}
            </>
          )}
        </span>
        {/* pictures pinned to its start, its end and its middle: resting on one shows it large (PinPeek) */}
        {opens && <img src={thumbUrl(opens)} alt="" data-pin draggable={false} onPointerEnter={(e) => a().restPin(c.id, "start", e.currentTarget)} onPointerLeave={() => a().restPin(c.id, null)} onContextMenu={pinMenu("start")} className={cx(pinLook(pinOn === "start", "left-3.5"), flipped(mirrored.has("start")))} />}
        {ends && <img src={thumbUrl(ends)} alt="" data-pin draggable={false} onPointerEnter={(e) => a().restPin(c.id, "end", e.currentTarget)} onPointerLeave={() => a().restPin(c.id, null)} onContextMenu={pinMenu("end")} className={cx(pinLook(pinOn === "end", "right-3.5"), flipped(mirrored.has("end")))} />}
        {through && <img src={thumbUrl(through.asset)} alt="" data-pin draggable={false} onPointerEnter={(e) => a().restPin(c.id, "mid", e.currentTarget)} onPointerLeave={() => a().restPin(c.id, null)} onContextMenu={pinMenu("mid")} className={cx(pinLook(pinOn === "mid", "-translate-x-1/2"), flipped(mirrored.has("mid")))} style={{ left: `${through.part * 100}%` }} />}
        {/* a mirrored frame's ↔, on its top right corner (the frames are 28 px, 14 px in from the clip's edge, 24 px down) */}
        {opens && mirrored.has("start") && <MirrorMark className="top-[18px] left-9" onMenu={pinMenu("start")} />}
        {ends && mirrored.has("end") && <MirrorMark className="top-[18px] right-2" onMenu={pinMenu("end")} />}
        {through && mirrored.has("mid") && <MirrorMark className="top-[18px]" style={{ left: `calc(${through.part * 100}% + 8px)` }} onMenu={pinMenu("mid")} />}
        {pinned && <span aria-hidden className={cx("absolute inset-y-0 w-2 bg-accent", pinned === "start" ? "left-0" : pinned === "end" ? "right-0" : "left-1/2 -translate-x-1/2")} />}
      </div>

      {/* its edges: drag to shorten */}
      {on && !s.planned && !c.job && (
        <>
          {c.kind === "video" && (
            <span role="separator" aria-label="Drag to trim the start of the clip" data-hint="drag: trim the start" onPointerDown={(e) => a().startPull(e, s, "start")} onPointerMove={(e) => a().movePull(e)} onPointerUp={() => a().endPull()} onPointerCancel={() => a().endPull()} className={cx(EDGE_HIT, "rounded-l-lg", moving ? "z-10" : "z-20")} style={{ left: s.left + 1, top: ROW.top, height: ROW.height }} />
          )}
          <span role="separator" aria-label="Drag to trim the end of the clip" data-hint={c.kind === "still" ? "drag: change the still's duration" : "drag: trim the end"} onPointerDown={(e) => a().startPull(e, s, "end")} onPointerMove={(e) => a().movePull(e)} onPointerUp={() => a().endPull()} onPointerCancel={() => a().endPull()} className={cx(EDGE_HIT, "rounded-r-lg", moving ? "z-10" : "z-20")} style={{ left: s.left + s.width - 11.5, top: ROW.top, height: ROW.height }} />
        </>
      )}

      {/* how it starts: flowing on from the clip before, or a cut, with its transition; a click opens the join in the column
          (without that panel, it switches extend and cut, when the model can extend) */}
      {s.index > 0 && prev && !moving && (() => {
        const canCarry = canExtend(c, prev, recipe);
        const carries = c.joined === "continue" && canCarry;
        const opens = Boolean(acts.current.onOpenJoin);
        const toggles = !opens && c.join !== "stale" && canCarry && Boolean(acts.current.onJoin);
        // extending across two video models: allowed, said by a dot (the face may change there)
        const differ = carries && modelsDiffer(prevRecipe, recipe);
        const t = carries ? null : c.transition;
        const span = transitionSpan(t, "cut", prev.lengthMs, c.lengthMs);
        const pps = a().pps;
        const shownMs = pulling ? pulling.drawnMs + (back.left.px / pps) * 1000 : span;
        const pillW = t && shownMs ? Math.max(34, (shownMs / 1000) * pps) : 0;
        // the longest it is drawn: what plays at most between these two clips (each half within its clip), the length it
        // gives held within TRANSITION_MS as before (a longer one plays as long as this)
        const playsMost = (t && transitionSpan({ ...t, ms: TRANSITION_MS.most }, "cut", prev.lengthMs, c.lengthMs)) || TRANSITION_MS.most;
        const dropping = over?.kind === "join" && over.clip === c.id;
        const pull = (e: ReactPointerEvent) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          back.stop();
          setPulling({ ms: span, drawnMs: span, held: true });
        };
        const pullTo = (e: ReactPointerEvent) => {
          if (!pulling?.held) return;
          const asked = (Math.abs(a().xOf(e.clientX) - s.left) * 2 * 1000) / pps;
          const ms = Math.round(Math.max(TRANSITION_MS.least, Math.min(TRANSITION_MS.most, asked)) / 10) * 10;
          // past its least or what plays at most, its edges follow the pointer with resistance (in px of its width)
          const px = (x: number) => (x / 1000) * pps;
          const over = resisted(px(asked), px(TRANSITION_MS.least), px(playsMost), edgeGive(pillW), motionAllowed()) - px(Math.max(TRANSITION_MS.least, Math.min(playsMost, asked)));
          const drawnMs = Math.min(ms, playsMost) + (over / pps) * 1000;
          back.seen(px(drawnMs));
          setPulling({ ms, drawnMs, held: true });
        };
        const pullEnd = () => {
          if (!pulling?.held) return;
          if (t && pulling.ms !== span) a().onTransition?.(c.id, { ...t, ms: pulling.ms });
          // what it plays once set; drawn there from where it was let go of, on the spring
          const rest = t ? transitionSpan({ ...t, ms: pulling.ms }, "cut", prev.lengthMs, c.lengthMs) : 0;
          if (!rest || Math.abs(pulling.drawnMs - rest) < 1) return setPulling(null);
          back.jump((pulling.drawnMs / 1000) * pps, (rest / 1000) * pps, "length");
          setPulling({ ms: pulling.ms, drawnMs: rest, held: false });
        };
        const words = t ? `${TRANSITIONS[t.kind].label} ${((pulling?.ms ?? span) / 1000).toFixed(2)} s` : "";
        const hint = c.join === "stale"
          ? `Clip ${s.index + 1} no longer follows clip ${s.index}`
          : carries
            ? `${c.join === "fresh" ? "Extends" : "Will extend"} clip ${s.index}${differ ? ": two models, the face may change here" : ""}${opens ? ". Click: open the join" : toggles ? ". Click: make it a cut" : ""}`
            : `A cut${t ? ` with ${words}` : ""}${opens ? ". Click: open the join" : toggles ? `. Click: extend clip ${s.index}` : recipe && c.kind === "video" ? ": this model cannot extend a clip" : ""}`;
        return (
          <>
            {t && pillW > 0 && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={`The transition before clip ${s.index + 1}: ${words}`}
                data-hint={`${words}. Click: open the join · drag an edge: its length`}
                onClick={() => a().onOpenJoin?.(c)}
                onDragOver={(e) => a().overJoin(e, s)}
                style={{ left: s.left - pillW / 2, width: pillW, top: ROW.top + 9, height: ROW.height - 18, background: SWATCH[t.kind] }}
                className={cx("absolute z-9 rounded-md border border-white/40 shadow-sm", dropping && "outline-2 outline-accent")}
              >
                {(["left", "right"] as const).map((side) => (
                  <span key={side} onPointerDown={pull} onPointerMove={pullTo} onPointerUp={pullEnd} onPointerCancel={() => {
                    back.stop();
                    setPulling(null);
                  }} className={cx("absolute inset-y-0 w-3 cursor-ew-resize", side === "left" ? "-left-1.5" : "-right-1.5")} />
                ))}
              </span>
            )}
            <button
              type="button"
              onClick={() => (opens ? a().onOpenJoin?.(c) : toggles ? a().onJoin?.(c, c.joined === "continue" ? "cut" : "continue") : a().onSelect(c.id))}
              onDragOver={(e) => a().overJoin(e, s)}
              data-hint={hint}
              aria-label={c.join === "stale" ? `The join before clip ${s.index + 1} no longer holds` : carries ? `The join before clip ${s.index + 1}: it extends clip ${s.index}${differ ? ", across two models" : ""}` : `The join before clip ${s.index + 1}: a cut${t ? `, ${words}` : ""}`}
              style={{ left: s.left - 12, top: ROW.top + ROW.height / 2 - 12 }}
              className={cx(
                "absolute z-10 flex h-6 w-6 items-center justify-center rounded-full border",
                (toggles || opens) && "hover:scale-110 hover:border-accent",
                dropping && "scale-125 border-accent ring-2 ring-accent/40",
                c.join === "stale" ? "border-attention bg-attention-wash text-attention-ink" : carries ? (c.join === "fresh" ? "border-accent bg-accent-wash text-accent" : "border-dashed border-accent bg-panel text-accent") : "border-line-strong bg-raised text-ink-3",
              )}
            >
              {c.join === "stale" ? <TriangleAlert size={11} /> : carries ? <Link2 size={11} /> : <Scissors size={10} />}
              {differ && c.join !== "stale" && <span aria-hidden className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border border-panel bg-attention" />}
            </button>
            {/* a clip put in here: shown while the pointer is within 20 px of the join (Track's `near`) or on the "+", the model
                chosen in the column after, each said beside it as seamless or a cut (the rethink's insert, page 2 of its mock) */}
            {acts.current.onNewClip && !edged && (
              <button
                type="button"
                aria-label={`Put a new clip between clip ${s.index} and clip ${s.index + 1}`}
                data-hint={`A new clip between clip ${s.index} and clip ${s.index + 1}: its model is chosen in the column`}
                onClick={() => a().onNewClip?.(prev.id)}
                style={{ left: s.left - 12, top: ROW.top + 1 }}
                className={cx("absolute z-10 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-title leading-none font-bold text-ground transition-opacity hover:opacity-100 focus-visible:opacity-100", near ? "opacity-100" : "opacity-0")}
              >
                +
              </button>
            )}
          </>
        );
      })()}

      {/* its sound; a Lip sync clip without a voice: amber, dashed, the drop for that one clip's voice */}
      {voice === null ? (
        <button
          type="button"
          onClick={() => a().onSelect(c.id)}
          onDragOver={(e) => a().overVoice(e, s)}
          onContextMenu={(e) => {
            const { onVoiceMenu, onSelect } = a();
            onSelect(c.id);
            onVoiceMenu(c, e);
          }}
          aria-label={`Audio of clip ${s.index + 1}: no voice yet. Drop the voice for clip ${s.index + 1} here`}
          data-voice-cell={c.id}
          style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: SOUND.top, height: SOUND.height }}
          className={cx(
            "absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-attention/60 bg-attention-wash px-1.5 text-left text-body whitespace-nowrap text-attention-ink",
            over?.kind === "voice" && over.clip === c.id && "outline outline-2 outline-accent",
          )}
        >
          <Mic size={12} className="shrink-0" />
          {s.width > 64 && <span className="truncate">Drop the voice for clip {s.index + 1} here</span>}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => a().onSelect(c.id)}
          onDragOver={(e) => a().overClip(e, s)}
          onContextMenu={(e) => {
            const { onSoundMenu, onSelect } = a();
            if (!onSoundMenu) return;
            onSelect(c.id);
            onSoundMenu(c, e);
          }}
          aria-label={`Audio of clip ${s.index + 1}: ${heard || "none yet"}`}
          style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: SOUND.top, height: SOUND.height }}
          className={cx(
            "absolute flex items-center gap-1 overflow-hidden rounded px-1.5 text-micro",
            c.sound === "file" ? "bg-picture/20 text-picture" : c.sound === "muted" || heard === "Silent" || !heard || s.planned ? "bg-raised text-ink-3" : "bg-good/15 text-good",
            over?.kind === "sound" && over.clip === c.id && "outline outline-2 outline-accent",
          )}
        >
          {/* how loud it is along the clip: its own sound over the part that plays, or the sound file from its start */}
          {c.sound === "own" && video && c.take && <Wave sound={ownSound?.sound ?? null} rate={ownSound?.rate ?? 10} fromMs={c.take.startMs} toMs={c.take.endMs} />}
          {c.sound === "file" && c.soundAsset && <Wave sound={fileSound?.sound ?? null} rate={fileSound?.rate ?? 10} fromMs={0} toMs={s.lengthMs} />}
          {(c.sound === "muted" || heard === "Silent") && <VolumeX size={10} className="relative shrink-0" />}
          {s.width > 64 && <span className="relative truncate">{heard}</span>}
        </button>
      )}
    </div>
  );
});

/** The live preview of the clip that renders, over its frames: only this draws again at every step. */
function ClipLive({ clip }: { clip: string }) {
  const job = useRunningOf(clip);
  return job ? <LivePreview job={job} className="pointer-events-none absolute inset-0 h-full w-full object-cover" /> : null;
}
function ClipPhase({ clip }: { clip: string }) {
  const phase = useQueueOf((q) => (q.running?.clipId === clip ? q.running.phase : null));
  return <>{phase ? phaseLabel(phase) : "Queued"}</>;
}
function ClipBar({ clip }: { clip: string }) {
  const progress = useQueueOf((q) => (q.running?.clipId === clip ? q.running.progress : 0)) ?? 0;
  const steps = useQueueOf((q) => (q.running?.clipId === clip ? q.running.steps : undefined)) ?? undefined;
  return <Bar value={progress * 100} steps={steps} loading={!progress} />;
}

/**
 * A trim edge: 10 px drawn on the clip's edge, 26 px to take (8 px more on each side, over WCAG 2.5.8's 24). Drawn only on
 * the selected clip, and above the join's dot (z-20 against its z-10): the dot is drawn later and sat over the middle of
 * both edges at the join, so a press meant to trim opened the join instead. The dot keeps its rim past the edges, and its
 * whole self on every other join and with no clip selected. While a clip is moved (no dots then) they go back under it, the
 * clip lifted at z-sticky passing over them.
 */
const EDGE_HIT = "absolute w-2.5 cursor-ew-resize bg-accent before:absolute before:inset-y-0 before:-inset-x-2 before:content-['']";

/** A pinned picture on a clip: framed in the colour of pictures, ringed in the accent while its card shows. */
const pinLook = (on: boolean, place: string) =>
  cx("absolute top-6 h-7 w-7 rounded border-2 object-cover transition-shadow", place, on ? "border-accent ring-[3px] ring-accent/30" : "border-picture");
