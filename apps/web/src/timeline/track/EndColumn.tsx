import { useEffect, useReducer, useRef, type DragEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Film, Mic, Plus } from "lucide-react";
import { cx, IconButton } from "../../ui";
import { NEW_CLIP } from "../model";
import { ROW, SOUND, SOURCE } from "./rows";

/** The end column's width while pinned: a strip of icons, so that it hides no more of the clips under it than this. */
export const STRIP = 36;

/**
 * Where the end column stands: after the last clip, moving with it, in full where all of it fits in the view; else the
 * slim strip (`pinned`; at 344 px the column covered half the track at 1280 px zoomed in, and Fit all, which had to leave
 * room for all of it, gave the clips under half the track): after the last clip while it fits there, else pinned at the
 * view's right edge so that its drops stay in reach, drawn over the clips. `end`: where the clips end (px); `view`: the
 * part of the track in view (its width 0 before it is measured).
 */
export function endColumnAt(end: number, pad: number, view: { left: number; width: number }): { left: number; pinned: boolean } {
  const after = end + pad;
  const right = view.left + view.width;
  if (!view.width || after + NEW_CLIP <= right) return { left: after, pinned: false };
  return { left: Math.max(pad, Math.min(after, right - STRIP)), pinned: true };
}

/** What each cell says: the full column's words, the strip's tips. */
const WORDS = {
  video: "New clip",
  audio: "Drop a voice recording: Lip sync, clip by clip",
  source: "Drop a long video: Motion transfer, window by window",
};
const LABELS = {
  audio: "Voice recording: drop one here for Lip sync clips after the last clip, or click for its menu",
  source: "Source: drop a long video here for Motion transfer clips after the last clip, or click for its menu",
};

type Props = {
  left: number;
  pinned: boolean;
  busy: boolean;
  overRecording: boolean;
  overSource: boolean;
  onNewClip(): void;
  /** Undefined: that drop is not offered (no model takes a recording; no source lane). */
  onRecordingOver?(e: DragEvent): void;
  onSourceOver?(e: DragEvent): void;
  onRecordingMenu?(e: ReactMouseEvent): void;
  onSourceMenu?(e: ReactMouseEvent): void;
};

/**
 * The end column where it stands in the part of the track in view. The track's scroll is heard here rather than in the
 * Track: held there as state, every step of a sideways scroll (and of a drag's auto-scroll) drew the whole track again,
 * its lanes and their waves, for this column alone (1.6 s of script per 5 s of scrolling at 150 clips, against 0.03 s
 * in 0.5.2). The view is kept in a ref, and the column drawn again only when where it stands changes: never while it
 * sits after the last clip, once a step while it is pinned at the view's right edge.
 */
export function EndColumnLive({ scroller, end, pad, ...props }: Omit<Props, "left" | "pinned"> & {
  /** The track's scrolling box. */
  scroller: RefObject<HTMLDivElement | null>;
  /** Where the clips end (px), and the track's padding. */
  end: number;
  pad: number;
}) {
  const view = useRef({ left: 0, width: 0 });
  const at = useRef({ end, pad });
  at.current = { end, pad };
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => {
      const now = { left: el.scrollLeft, width: el.clientWidth };
      const was = view.current;
      if (now.left === was.left && now.width === was.width) return;
      view.current = now;
      const a = endColumnAt(at.current.end, at.current.pad, was);
      const b = endColumnAt(at.current.end, at.current.pad, now);
      if (a.left !== b.left || a.pinned !== b.pinned) redraw();
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    sized?.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      sized?.disconnect();
    };
  }, [scroller]);
  const column = endColumnAt(end, pad, view.current);
  return <EndColumn {...props} left={column.left} pinned={column.pinned} />;
}

/**
 * The end column (the lanes mock, 2026-10-22): the three drops that add their clips after the last one, one under the
 * other: "New clip" on the Video row, a voice recording on the Audio row (Lip sync clips cut at its pauses), a long video
 * on the Source row (Motion transfer, window by window). Each cell is a drop target of its own and answers right-click
 * (and a click) with its lane's menu; the Source cell only while the timeline has no source (its video is drawn on the
 * lane then). Pinned over the clips, it is the slim strip (EndStrip).
 */
export function EndColumn(props: Props) {
  if (props.pinned) return <EndStrip {...props} />;
  const { left, busy, overRecording, overSource, onNewClip, onRecordingOver, onSourceOver, onRecordingMenu, onSourceMenu } = props;
  const cell = (on: boolean) => cx("absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-line-strong px-2 text-left text-body whitespace-nowrap text-ink-2 hover:text-ink bg-panel", on && "outline outline-2 outline-accent");
  return (
    <>
      <button
        type="button"
        onClick={onNewClip}
        disabled={busy}
        data-end-column="video"
        style={{ left, width: NEW_CLIP, top: ROW.top, height: ROW.height }}
        className="absolute flex flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink"
      >
        <Plus size={15} />
        <span className="text-xs font-semibold">{WORDS.video}</span>
      </button>
      {onRecordingOver && (
        <button
          type="button"
          data-end-column="audio"
          data-paste="recording"
          aria-label={LABELS.audio}
          onDragOver={onRecordingOver}
          onClick={onRecordingMenu}
          onContextMenu={onRecordingMenu}
          style={{ left, width: NEW_CLIP, top: SOUND.top, height: SOUND.height }}
          className={cell(overRecording)}
        >
          <Mic size={13} className="shrink-0" />
          <span className="truncate">{WORDS.audio}</span>
        </button>
      )}
      {onSourceOver && (
        <button
          type="button"
          data-end-column="source"
          data-paste="source"
          aria-label={LABELS.source}
          onDragOver={onSourceOver}
          onClick={onSourceMenu}
          onContextMenu={onSourceMenu}
          style={{ left, width: NEW_CLIP, top: SOURCE.top, height: SOURCE.height }}
          className={cell(overSource)}
        >
          <Film size={13} className="shrink-0" />
          <span className="truncate">{WORDS.source}</span>
        </button>
      )}
    </>
  );
}

/**
 * The end column while the clips run past the view (the owner, 2026-10-22: "go for the slim strip"): a strip of icons at
 * the view's right edge, on the panel's ground behind a hairline, so that it hides no more of the last clip in view than
 * its own width. Each icon keeps its row's height, its words in the tip, its drop and its menu. A recording or a long video
 * dragged over its cell widens that cell leftwards to show its words, so that the drop says what it will do.
 */
function EndStrip({ left, busy, overRecording, overSource, onNewClip, onRecordingOver, onSourceOver, onRecordingMenu, onSourceMenu }: Props) {
  const top = ROW.top - 4;
  const bottom = (onSourceOver ? SOURCE.top + SOURCE.height : SOUND.top + SOUND.height) + 4;
  // anchored at the strip's right edge, so that a widened cell grows over the clips and never past the view
  const cell = (row: { top: number; height: number }, on: boolean) => ({
    style: { top: row.top - top, height: row.height, right: (STRIP - 28) / 2, width: on ? NEW_CLIP : 28 },
    className: cx("absolute gap-1.5 overflow-hidden border-dashed bg-panel transition-[width] duration-150 ease-out motion-reduce:transition-none", on && "outline outline-2 outline-accent"),
  });
  return (
    <div data-end-strip style={{ left, width: STRIP, top, height: bottom - top }} className="absolute z-sticky border-l border-line bg-panel">
      <IconButton size={28} tone="outline" label={WORDS.video} onClick={onNewClip} disabled={busy} data-end-column="video" {...cell(ROW, false)}>
        <Plus size={15} />
      </IconButton>
      {onRecordingOver && (
        <IconButton size={28} tone="outline" label={LABELS.audio} tip={WORDS.audio} onDragOver={onRecordingOver} onClick={onRecordingMenu} onContextMenu={onRecordingMenu} data-end-column="audio" data-paste="recording" {...cell(SOUND, overRecording)}>
          <Mic size={13} className="shrink-0" />
          {overRecording && <span className="truncate text-body">{WORDS.audio}</span>}
        </IconButton>
      )}
      {onSourceOver && (
        <IconButton size={28} tone="outline" label={LABELS.source} tip={WORDS.source} onDragOver={onSourceOver} onClick={onSourceMenu} onContextMenu={onSourceMenu} data-end-column="source" data-paste="source" {...cell(SOURCE, overSource)}>
          <Film size={13} className="shrink-0" />
          {overSource && <span className="truncate text-body">{WORDS.source}</span>}
        </IconButton>
      )}
    </div>
  );
}
