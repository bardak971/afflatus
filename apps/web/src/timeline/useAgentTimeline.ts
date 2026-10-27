import { useEffect } from "react";
import { useTimelineEdits } from "../agentEdits";
import { useBanners } from "../store";

/**
 * A change an MCP token made to the timeline open here (a "timelineEdit" live event, agentEdits.ts): the timeline itself is
 * read again on the "timeline" event that comes with it, the selection, the zoom and what is typed kept as they are; this
 * says it in a toast whose Undo takes that step alone back (the timeline's own Undo, refused once the timeline changed
 * after it). The clips it touched stay ringed (Track) until the user selects them, or the change is undone.
 */
export function useAgentTimeline(id: string, o: { undo(step: string): void; selected: string | null }) {
  const say = useBanners((b) => b.push);
  const seq = useTimelineEdits((s) => s.seq);
  useEffect(() => {
    const e = useTimelineEdits.getState().last;
    if (!seq || !e || e.id !== id || e.going) return;
    const step = e.step;
    say({
      id: `agent-timeline:${id}`, tone: "good", title: `${e.by} changed the timeline`, text: e.said,
      // not on Ctrl+Z: the editor's own Undo is there, and takes the same step back while it is the last one
      ...(step ? { action: { label: "Undo", run: () => {
        useTimelineEdits.getState().forget(e);
        o.undo(step);
      } } } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each edit heard once; the undo is read when it is clicked
  }, [seq]);
  // a clip the user selects is theirs again: its ring goes
  useEffect(() => {
    if (o.selected) useTimelineEdits.getState().clear(id, [o.selected]);
  }, [id, o.selected]);
}
