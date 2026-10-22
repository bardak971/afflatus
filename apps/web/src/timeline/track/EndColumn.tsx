import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { Film, Mic, Plus } from "lucide-react";
import { cx } from "../../ui";
import { NEW_CLIP } from "../model";
import { ROW, SOUND, SOURCE } from "./rows";

/**
 * Where the end column stands: after the last clip, moving with it; while the clips run past the view, pinned at the view's
 * right edge so that its drops stay in reach (it is then drawn over the clips, as a floating column). `end`: where the
 * clips end (px); `view`: the part of the track in view (its width 0 before it is measured).
 */
export function endColumnAt(end: number, pad: number, view: { left: number; width: number }): { left: number; pinned: boolean } {
  const after = end + pad;
  if (!view.width || end <= view.left + view.width) return { left: after, pinned: false };
  return { left: Math.max(pad, view.left + view.width - NEW_CLIP - 8), pinned: true };
}

/**
 * The end column (the lanes mock, 2026-10-22): the three drops that add their clips after the last one, one under the
 * other: "New clip" on the Video row, a voice recording on the Audio row (Lip sync clips cut at its pauses), a long video
 * on the Source row (Motion transfer, window by window). Each cell is a drop target of its own and answers right-click
 * (and a click) with its lane's menu; the Source cell only while the timeline has no source (its video is drawn on the
 * lane then).
 */
export function EndColumn({ left, pinned, busy, overRecording, overSource, onNewClip, onRecordingOver, onSourceOver, onRecordingMenu, onSourceMenu }: {
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
}) {
  // pinned over the clips: on the panel's ground, lifted, so that it reads as on top of them rather than as one of them
  const floating = pinned && "z-sticky bg-panel shadow-pop";
  const cell = (on: boolean) => cx("absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-line-strong px-2 text-left text-body whitespace-nowrap text-ink-2 hover:text-ink bg-panel", on && "outline outline-2 outline-accent");
  return (
    <>
      <button
        type="button"
        onClick={onNewClip}
        disabled={busy}
        data-end-column="video"
        style={{ left, width: NEW_CLIP, top: ROW.top, height: ROW.height }}
        className={cx("absolute flex flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink", floating)}
      >
        <Plus size={15} />
        <span className="text-xs font-semibold">New clip</span>
      </button>
      {onRecordingOver && (
        <button
          type="button"
          data-end-column="audio"
          aria-label="Voice recording: drop one here for Lip sync clips after the last clip, or click for its menu"
          onDragOver={onRecordingOver}
          onClick={onRecordingMenu}
          onContextMenu={onRecordingMenu}
          style={{ left, width: NEW_CLIP, top: SOUND.top, height: SOUND.height }}
          className={cx(cell(overRecording), floating)}
        >
          <Mic size={13} className="shrink-0" />
          <span className="truncate">Drop a voice recording: Lip sync, clip by clip</span>
        </button>
      )}
      {onSourceOver && (
        <button
          type="button"
          data-end-column="source"
          aria-label="Source: drop a long video here for Motion transfer clips after the last clip, or click for its menu"
          onDragOver={onSourceOver}
          onClick={onSourceMenu}
          onContextMenu={onSourceMenu}
          style={{ left, width: NEW_CLIP, top: SOURCE.top, height: SOURCE.height }}
          className={cx(cell(overSource), floating)}
        >
          <Film size={13} className="shrink-0" />
          <span className="truncate">Drop a long video: Motion transfer, window by window</span>
        </button>
      )}
    </>
  );
}
