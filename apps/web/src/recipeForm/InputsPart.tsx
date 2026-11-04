import { useEffect, useState, type ReactNode } from "react";
import type { InputSpec } from "@afflatus/core";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDragged } from "../dragging";
import { Segmented } from "../ui";
import { Part, useParts } from "./Part";

/**
 * The tab shown while something is dragged: the one open stays when it takes it (a picture dragged with References open
 * went to the Frames tab, 2026-10-14), else the one that does; nothing dragged, the one open.
 */
export function tabWhileDragging(open: "frames" | "references", framesTake: boolean, refsTake: boolean): "frames" | "references" {
  if ((open === "frames" && framesTake) || (open === "references" && refsTake)) return open;
  return framesTake ? "frames" : refsTake ? "references" : open;
}

/** Whether an input of the form has a place for what is being dragged from the library. */
function useTakes() {
  const dragged = useDragged((s) => s.types);
  return (i: InputSpec) =>
    (i.type === "image" && i.role !== "mask" && dragged.includes(DRAG_PICTURE)) ||
    (i.type === "clip" && dragged.includes(DRAG_VIDEO)) ||
    (i.type === "references" && dragged.includes(i.media === "video" ? DRAG_VIDEO : DRAG_PICTURE)) ||
    ((i.type === "audio" || i.type === "cues") && (dragged.includes(DRAG_SOUND) || dragged.includes(DRAG_HAS_SOUND)));
}

/**
 * The Inputs part: the frames the result is built on, and the references it is shown, as two tabs (the one
 * looked at is remembered). While something of the library is dragged, the tab that has a place for it comes
 * forward and the part opens: the place is there to be dropped on. While searching, what a screen adds (the
 * cast, a clip's pinned frames) steps aside: it is not a setting. The cast comes back when the search names it.
 */
/**
 * A row the form does not take, where it would be, greyed with why (card #277): a control image on a model no ControlNet is
 * made for, reference images on one that reads none. Said rather than left out, so that it is not looked for.
 */
function AbsentRow({ label, why }: { label: string; why: string }) {
  return (
    <div className="flex min-h-11 flex-col justify-center gap-0.5 opacity-60" aria-disabled="true">
      <span className="font-semibold text-ink-3">{label}</span>
      <span className="text-xs text-ink-2">Not on this model: {why}.</span>
    </div>
  );
}

export function InputsPart({ frames, refs, absent = [], framesChosen, refsCount, chosen, summary, missing, look, lookHit, lookWithFrames, frameExtra, q, render }: {
  /**
   * The cast is used by the frames alone (a Motion transfer: who goes into the picture made from the driving video), not by
   * a reference input or the words: no References tab holds it; it is picked in that picture's own box (pictureMaker.tsx).
   */
  lookWithFrames?: boolean;
  frames: InputSpec[];
  refs: InputSpec[];
  /** The control image and reference rows this form does not take (Recipe.absent): greyed in their tab, with why. */
  absent?: Array<{ id: string; label: string; why: string }>;
  framesChosen: number;
  refsCount: number;
  /** What the frames and references hold, as one string: told apart to see that something was put in. */
  chosen: string;
  summary: ReactNode;
  /** A picture the form must have is not chosen yet: the part stays open. */
  missing: boolean;
  look?: ReactNode;
  /** The search names the cast ("cast", "look", "people"): it shows while searching. */
  lookHit?: boolean;
  frameExtra?: {
    node?: ReactNode;
    summary: string;
    /** A line at the top of the chapter, whichever tab is open (a clip whose take that plays was made with other inputs). */
    head?: ReactNode;
    /** A line at the top of the References tab (a timeline clip: what it does with its person's picture). */
    refs?: ReactNode;
  };
  q: string;
  render(i: InputSpec): ReactNode;
}) {
  const onRefs = useParts((st) => st.open["inputs:references"] ?? false);
  const setPart = useParts((st) => st.set);
  const takes = useTakes();
  // a control image goes with the frames (a picture the result is built on), reference images with the references
  const absentFrames = absent.filter((a) => a.id !== "references");
  const absentRefs = absent.filter((a) => a.id === "references");
  const hasFrames = frames.length > 0 || Boolean(frameExtra?.node) || (absentFrames.length > 0 && !q);
  const hasRefs = refs.length > 0 || (Boolean(look) && !lookWithFrames && (!q || Boolean(lookHit))) || (absentRefs.length > 0 && !q);
  const tab = hasFrames && hasRefs ? (onRefs ? "references" : "frames") : hasFrames ? "frames" : "references";
  // something dragged in: the tab that takes it comes forward
  const refsTake = refs.some(takes);
  const framesTake = frames.some(takes);
  // a tab clicked wins over the one brought forward for a missing input: a lip sync's recording, which the form must
  // have, held the Frames tab, and its References could not be opened at all
  const [picked, setPicked] = useState<"frames" | "references" | null>(null);
  // a picture the form must have is not there yet (an Inpaint's mask): its tab comes forward, as the part opens
  const shownTab = tabWhileDragging(picked ?? (missing && hasFrames ? "frames" : tab), framesTake, refsTake);
  // The part opens by itself while a picture is missing or something it takes is dragged. When that ends because a
  // picture was put in (dropped, picked), it stays open on the tab it was put in: folding away the slot just filled
  // hid the picture with its Change and Remove (and a reference dropped from the Frames tab went back behind it).
  // `since` is what the inputs held when it opened by itself, and the tab shown last; `stay` holds it open for the
  // drawing in which it would fold, until the store says open (the effect), so that it never folds and reopens.
  const opened = missing || framesTake || refsTake;
  const [since, setSince] = useState<{ chosen: string; tab: "frames" | "references" } | null>(null);
  const [stay, setStay] = useState<"frames" | "references" | null>(null);
  if (opened && (since === null || since.tab !== shownTab)) setSince({ chosen: since?.chosen ?? chosen, tab: shownTab });
  if (!opened && since !== null) {
    setSince(null);
    if (since.chosen !== chosen) setStay(since.tab);
  }
  useEffect(() => {
    if (!stay) return;
    setPart("inputs:references", stay === "references");
    setPart("inputs", true);
    setStay(null);
  }, [stay, setPart]);
  const tabNow = stay ?? shownTab;
  if (!hasFrames && !hasRefs) return null;
  return (
    <Part id="inputs" title="Inputs" summary={summary} needs={opened || Boolean(stay) || Boolean(q)}>
      {!q && frameExtra?.head}
      {hasFrames && hasRefs && !q && (
        <div className="w-full">
          <Segmented<"frames" | "references">
            label="Which inputs"
            value={tabNow}
            options={[
              { value: "frames", label: framesChosen ? `Frames · ${framesChosen}` : "Frames" },
              { value: "references", label: refsCount ? `References · ${refsCount}` : "References" },
            ]}
            onChange={(v) => {
              setPicked(v);
              setPart("inputs:references", v === "references");
            }}
          />
        </div>
      )}
      {tabNow === "frames" && !q && frameExtra?.node}
      {(tabNow === "frames" || q) && frames.map(render)}
      {tabNow === "frames" && !q && absentFrames.map((a) => <AbsentRow key={a.id} label={a.label} why={a.why} />)}
      {tabNow === "references" && !q && frameExtra?.refs}
      {((tabNow === "references" && !q) || lookHit) && look}
      {(tabNow === "references" || q) && refs.map(render)}
      {tabNow === "references" && !q && absentRefs.map((a) => <AbsentRow key={a.id} label={a.label} why={a.why} />)}
    </Part>
  );
}
