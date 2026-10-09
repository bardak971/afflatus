import { useEditorColumn } from "../store";
import { HEIGHT, ROW } from "./track/rows";

/** The clips of the placeholder track, left to right: their widths in pixels, as a few clips of a few seconds draw. */
const CLIPS = [150, 190, 120, 170, 140];

/**
 * The timeline editor before its timeline (or its code) has come: the header, the player, the transport, the track
 * with a few clip boxes and the right column, each where the editor puts it and at its size, with the loading shine.
 * The editor then lands in the same places: nothing jumps. Light on purpose: it is also what the app shows while the
 * editor's own code loads, so it reads only the column's width (from the store) and the track's rows.
 */
export function EditorSkeleton() {
  const width = useEditorColumn((st) => st.width);
  const folded = useEditorColumn((st) => st.folded);
  return (
    <div aria-busy="true" aria-label="Loading the timeline" className="flex min-w-0 grow flex-col">
      {/* the header (TimelineHeader): the name, its length and clips, then Undo, Redo, Finish and Export */}
      <div className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line px-3">
        <span className="m-skeleton h-6 w-44" />
        <span className="m-skeleton h-5 w-28 rounded-full!" />
        <span className="grow" />
        <span className="m-skeleton h-9 w-10" />
        <span className="m-skeleton h-9 w-10" />
        <span className="m-skeleton h-9 w-24" />
        <span className="m-skeleton h-9 w-24" />
      </div>
      <div className="flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col">
          <div className="relative flex min-h-0 grow">
            {/* the media shelf's tab, then the player's stage with the frame in it */}
            <div className="w-10 shrink-0 border-r border-line bg-panel" />
            <div data-stage className="flex min-h-0 min-w-0 grow items-center justify-center bg-stage p-6">
              <span className="m-skeleton aspect-video max-h-full w-full max-w-[min(100%,960px)] rounded-[10px]!" />
            </div>
          </div>
          {/* the transport (Transport): the jumps and play round the clock */}
          <div className="flex h-[54px] shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
            <span className="m-skeleton h-8 w-8" />
            <span className="m-skeleton h-9 w-9 rounded-full!" />
            <span className="m-skeleton h-8 w-8" />
            <span className="m-skeleton ml-2 h-4 w-24" />
          </div>
          {/* the track (Track): the row names, the clips in the video row, and the zoom bar under it */}
          <div className="flex shrink-0 flex-col border-t border-line bg-panel">
            <div className="flex">
              <div className="w-[64px] shrink-0 border-r border-line" style={{ height: HEIGHT }} />
              <div className="relative min-w-0 grow overflow-hidden" style={{ height: HEIGHT }}>
                <div className="absolute flex gap-1" style={{ top: ROW.top, height: ROW.height, left: 8 }}>
                  {CLIPS.map((w, i) => <span key={i} className="m-skeleton h-full shrink-0" style={{ width: w }} />)}
                </div>
              </div>
            </div>
            <div className="h-8 border-t border-line" />
          </div>
        </div>
        {/* the right column at its width (or folded to its strip): the Overview's cards */}
        {folded ? (
          <div className="w-10 shrink-0 border-l border-line bg-panel" />
        ) : (
          <div style={{ width }} className="flex shrink-0 flex-col gap-3 border-l border-line bg-panel p-4">
            <span className="m-skeleton h-24 rounded-[10px]!" />
            <span className="m-skeleton h-32 rounded-[10px]!" />
            <span className="m-skeleton h-20 rounded-[10px]!" />
          </div>
        )}
      </div>
    </div>
  );
}
