import { useEffect, useRef, type RefObject } from "react";
import type { Clip, Timeline } from "../api";
import { useTimelineRequest } from "../bar/bridge";
import type { Banner } from "../store";
import type { Slot } from "./model";
import type { PlayerHandle } from "./Player";
import type { useClipEdits } from "./useClipEdits";
import type { useTimelineMutations } from "./useTimelineMutations";
import { plural } from "../format";
import { failedBanner } from "../sayFailed";

type Mutations = ReturnType<typeof useTimelineMutations>;

/**
 * What the command bar asked of this timeline (render clips by number, render what is missing, export, finish, split,
 * a take before or after, undo, a clip selected): done here, as the buttons and the keys do it, once the timeline and its
 * forms are read. The Export dialog is opened through the ref it returns, which the editor fills.
 */
export function useBarRequests({ id, t, shown, clips, slots, missing, ready, render, undo, redo, say, setNote, setSelected, select, setFin, setCursor, player, selectedNow, splitNow, takeNow }: {
  id: string;
  t: Timeline | undefined;
  /** The timeline as it is shown (with the edits not saved yet): the forms are read once it is there. */
  shown: ReturnType<typeof useClipEdits>["shown"];
  clips: Clip[];
  slots: Slot[];
  /** What is left to render. */
  missing: Clip[];
  ready: ReturnType<typeof useClipEdits>["ready"];
  render: Mutations["render"];
  undo: Mutations["undo"];
  redo: Mutations["redo"];
  say(b: Banner): void;
  setNote(text: string | null, more?: string): void;
  setSelected(clip: string | null): void;
  select(clip: string | null): void;
  setFin(open: boolean): void;
  setCursor(ms: number | null): void;
  player: RefObject<PlayerHandle | null>;
  selectedNow: RefObject<string | null>;
  splitNow: RefObject<(only?: string | null) => void>;
  takeNow: RefObject<(by: -1 | 1) => void>;
}) {
  const openExport = useRef<(() => void) | null>(null);
  const request = useTimelineRequest((r) => r.request);
  useEffect(() => {
    if (!request || request.timeline !== id || !t || !shown) return;
    // Fix all is the overview's, which measures the joins: the clip's panel gives way to it, and it takes the request
    if (request.do === "fix-all" && clips.length) return setSelected(null);
    const asked = useTimelineRequest.getState().take();
    if (request.do === "fix-all") {
      asked?.reply(null);
      return say({ id: `bar-fix:${Date.now()}`, tone: "good", title: `${t.name}: nothing to fix`, text: "It has no clip yet.", href: `/timelines/${id}`, go: "Open the timeline" });
    }
    if (request.do === "export") {
      asked?.reply(null);
      return openExport.current?.();
    }
    // the Finish dialog, as the Finish button opens it
    if (request.do === "finish") {
      asked?.reply(null);
      return setFin(true);
    }
    // the selected clip split at the playhead, or playing its take before or after: as S and Alt+[ ] do it, said in the note
    if (request.do === "split" || request.do === "take") {
      asked?.reply(null);
      if (request.do === "split") splitNow.current(selectedNow.current);
      else takeNow.current(request.by);
      return;
    }
    // the bar's `> undo`, as Ctrl+Z here: the header says what was undone, or that there is nothing to
    if (request.do === "undo") {
      asked?.reply(null);
      if (!t.undo) return setNote("Nothing to undo");
      if (!undo.isPending && !redo.isPending) undo.mutate();
      return;
    }
    // the bar's `> clip 3`: the clip selected and the playhead on its start, as a click on it in the track
    if (request.do === "select") {
      asked?.reply(null);
      const slot = slots[request.clip - 1];
      if (!slot) return setNote(`${t.name} has no clip ${request.clip}`);
      select(slot.clip.id);
      player.current?.seek(slot.planned ? slot.startMs : slot.clip.atMs);
      // a clip with nothing rendered: the playhead stands on its slot, as when it is clicked there
      if (slot.planned) setCursor(slot.startMs);
      return;
    }
    const list = request.do === "render-missing" ? missing : clips.filter((c, i) => request.clips.includes(i + 1) && c.kind === "video" && !c.job && ready(c).input);
    if (!list.length) {
      asked?.reply(null);
      say({ id: `bar-render:${Date.now()}`, tone: "bad", title: request.do === "render-missing" ? `${t.name} has no clip left to render` : `Nothing to render in clip${request.clips.length > 1 ? "s" : ""} ${request.clips.join(", ")}`, text: request.do === "render" ? "A clip renders when it is a video clip with its form filled, and is not already in the queue." : undefined, href: `/timelines/${id}`, go: "Open the timeline" });
      return;
    }
    // (the promise, not the mutation's own callbacks: those are dropped when the editor is left before the answer)
    render.mutateAsync({ clips: list }).then(
      (made) => {
        asked?.reply(made.ids);
        // sent to the top of the queue: the bar says so once they are there
        if (!request.top) say({ id: `bar-render:${Date.now()}`, tone: "good", title: `${plural(list.length, "clip")} of ${t.name} queued`, href: "/queue", go: "Open queue" });
      },
      (err: unknown) => {
        asked?.reply(null);
        say(failedBanner({ id: "bar-render", href: `/timelines/${id}`, go: "Open the timeline" }, `Clips of ${t.name} could not be rendered`, err));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request: the rest is read as it stands then
  }, [request, id, t, shown]);
  return openExport;
}
