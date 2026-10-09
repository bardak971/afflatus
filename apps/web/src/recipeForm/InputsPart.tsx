import type { ReactNode } from "react";
import type { InputSpec } from "@afflatus/core";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDragged } from "../dragging";
import { Segmented } from "../ui";
import { Part, useParts } from "./Part";

/** Whether an input of the form has a place for what is being dragged from the library. */
export function useTakes() {
  const dragged = useDragged((s) => s.types);
  return (i: InputSpec) =>
    (i.type === "image" && i.role !== "mask" && dragged.includes(DRAG_PICTURE)) ||
    (i.type === "clip" && dragged.includes(DRAG_VIDEO)) ||
    (i.type === "references" && dragged.includes(i.media === "video" ? DRAG_VIDEO : DRAG_PICTURE)) ||
    (i.type === "audio" && (dragged.includes(DRAG_SOUND) || dragged.includes(DRAG_HAS_SOUND)));
}

/**
 * The Inputs part: the frames the result is built on, and the references it is shown, as two tabs (the one
 * looked at is remembered). While something of the library is dragged, the tab that has a place for it comes
 * forward and the part opens: the place is there to be dropped on. While searching, what a screen adds (the
 * cast, a clip's pinned frames) steps aside: it is not a setting. The cast comes back when the search names it.
 */
export function InputsPart({ frames, refs, framesChosen, refsCount, summary, missing, look, lookHit, frameExtra, q, render }: {
  frames: InputSpec[];
  refs: InputSpec[];
  framesChosen: number;
  refsCount: number;
  summary: string;
  /** A picture the form must have is not chosen yet: the part stays open. */
  missing: boolean;
  look?: ReactNode;
  /** The search names the cast ("cast", "look", "people"): it shows while searching. */
  lookHit?: boolean;
  frameExtra?: { node: ReactNode; summary: string };
  q: string;
  render(i: InputSpec): ReactNode;
}) {
  const onRefs = useParts((st) => st.open["inputs:references"] ?? false);
  const setPart = useParts((st) => st.set);
  const takes = useTakes();
  const hasFrames = frames.length > 0 || Boolean(frameExtra);
  const hasRefs = refs.length > 0 || (Boolean(look) && (!q || Boolean(lookHit)));
  if (!hasFrames && !hasRefs) return null;
  const tab = hasFrames && hasRefs ? (onRefs ? "references" : "frames") : hasFrames ? "frames" : "references";
  // something dragged in: the tab that takes it comes forward
  const refsTake = refs.some(takes);
  const framesTake = frames.some(takes);
  // a picture the form must have is not there yet (an Inpaint's mask): its tab comes forward, as the part opens
  const shownTab = framesTake ? "frames" : refsTake ? "references" : missing && hasFrames ? "frames" : tab;
  return (
    <Part id="inputs" title="Inputs" summary={summary} needs={missing || framesTake || refsTake || Boolean(q)}>
      {hasFrames && hasRefs && !q && (
        <div className="w-full">
          <Segmented<"frames" | "references">
            label="Which inputs"
            value={shownTab}
            options={[
              { value: "frames", label: framesChosen ? `Frames · ${framesChosen}` : "Frames" },
              { value: "references", label: refsCount ? `References · ${refsCount}` : "References" },
            ]}
            onChange={(v) => setPart("inputs:references", v === "references")}
          />
        </div>
      )}
      {shownTab === "frames" && !q && frameExtra?.node}
      {(shownTab === "frames" || q) && frames.map(render)}
      {((shownTab === "references" && !q) || lookHit) && look}
      {(shownTab === "references" || q) && refs.map(render)}
    </Part>
  );
}
