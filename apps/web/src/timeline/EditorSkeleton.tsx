import { useQueryClient } from "@tanstack/react-query";
import type { Timeline, TimelineBrief } from "../api";
import { useEditorColumn } from "../store";
import { HEIGHT, ROW } from "./track/rows";

/** Where the frame's shape of each timeline opened lately is kept, for its placeholder on the next visit. */
const ASPECTS = "afflatus.timeline-aspects";
/** How many timelines' shapes are kept: the last ones opened. */
const KEPT = 50;

/**
 * Remembers the shape of a timeline's frame, as the editor shows it, so that its placeholder has that shape next time
 * (a timeline whose frame comes from its first clip has no width in the timelines' list). In this browser only: a
 * convenience, never relied on (storage can be off or full).
 */
export function rememberAspect(id: string, width: number, height: number) {
  try {
    const all = JSON.parse(localStorage.getItem(ASPECTS) ?? "{}") as Record<string, number>;
    const ratio = Math.round((width / height) * 1000) / 1000;
    if (all[id] === ratio) return;
    delete all[id];
    all[id] = ratio;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - KEPT))) delete all[old];
    localStorage.setItem(ASPECTS, JSON.stringify(all));
  } catch {
    // no storage here: the placeholder stays landscape
  }
}

/**
 * The shape of a timeline's frame (width over height) before the timeline has come: the timeline itself or the
 * timelines' list when either is cached, else the shape it had when it was last opened here; null when nothing is known.
 */
function useKnownAspect(id: string | undefined): number | null {
  const client = useQueryClient();
  if (!id) return null;
  const sized = (w?: number | null, h?: number | null) => (w && h ? w / h : null);
  const own = client.getQueryData<Timeline>(["timelines", id]);
  if (own && sized(own.width, own.height)) return sized(own.width, own.height);
  for (const [, data] of client.getQueriesData<{ items: TimelineBrief[] }>({ queryKey: ["timelines", "list"] })) {
    const brief = data?.items.find((t) => t.id === id);
    if (brief && sized(brief.width, brief.height)) return sized(brief.width, brief.height);
  }
  try {
    const ratio = (JSON.parse(localStorage.getItem(ASPECTS) ?? "{}") as Record<string, number>)[id];
    return typeof ratio === "number" && ratio > 0 ? ratio : null;
  } catch {
    return null;
  }
}

/** The clips of the placeholder track, left to right: their widths in pixels, as a few clips of a few seconds draw. */
const CLIPS = [150, 190, 120, 170, 140];

/**
 * The timeline editor before its timeline (or its code) has come: the header, the player, the transport, the track
 * with a few clip boxes and the right column, each where the editor puts it and at its size, with the loading shine.
 * The editor then lands in the same places: nothing jumps. Light on purpose: it is also what the app shows while the
 * editor's own code loads, so it reads only the column's width (from the store), the track's rows and the frame's
 * shape when it is known (useKnownAspect): a 9:16 timeline's frame is tall from the start, landscape only when nothing is known.
 */
export function EditorSkeleton({ id }: { id?: string }) {
  const width = useEditorColumn((st) => st.width);
  const aspect = useKnownAspect(id) ?? 16 / 9;
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
              {/* tall: as high as the stage, its width from the shape; wide: as wide as the stage allows, at most 960 px */}
              <span style={{ aspectRatio: aspect }} className={`m-skeleton max-h-full rounded-[10px]! ${aspect < 1 ? "h-full max-w-full" : "w-full max-w-[min(100%,960px)]"}`} />
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
