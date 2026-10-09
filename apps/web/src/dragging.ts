import { useState, type DragEvent } from "react";
import { create } from "zustand";

/**
 * Dragging an item of the library: what the drag carries, and the places it can be dropped on. While
 * one is dragged, every place that takes it shows its border, so that it is seen where it can go
 * before the pointer gets there.
 */

export const DRAG_TYPE = "application/x-afflatus-asset";
/** Timelines dragged from the Studio's Timelines view (their ids, comma-separated): onto a folder, to list them there. */
export const DRAG_TIMELINE = "application/x-afflatus-timeline";
/** Also set, by what is dragged: a drop target can only see these names while something hovers over it, not the item. */
export const DRAG_PICTURE = "application/x-afflatus-picture";
export const DRAG_VIDEO = "application/x-afflatus-video";
export const DRAG_SOUND = "application/x-afflatus-sound";
/** A video that has sound: it can stand for a sound where one is asked for. */
export const DRAG_HAS_SOUND = "application/x-afflatus-has-sound";
export const dragKind = (kind: "image" | "video" | "audio") => (kind === "image" ? DRAG_PICTURE : kind === "video" ? DRAG_VIDEO : DRAG_SOUND);

/** What is being dragged right now, as the names it carries. Empty when nothing of the library is. */
export const useDragged = create<{ types: string[] }>(() => ({ types: [] }));

if (typeof window !== "undefined") {
  const ours = (t: string) => t.startsWith("application/x-afflatus-");
  // in the bubbling phase: by then the item that is dragged has said what it carries
  window.addEventListener("dragstart", (e) => {
    const types = [...(e.dataTransfer?.types ?? [])].filter(ours);
    // after the drag has started: a page that changes in the dragstart itself sometimes makes Chrome cancel the drag
    setTimeout(() => useDragged.setState({ types }), 0);
  });
  const done = () => useDragged.getState().types.length && useDragged.setState({ types: [] });
  window.addEventListener("dragend", done);
  // an item that is redrawn while it is dragged never says it ended: the drop says so
  window.addEventListener("drop", done, true);
}

/**
 * How a drop box leans in when what is dragged is over it: a hair larger, at once (--t-pop), and back as quickly
 * when the pointer leaves. Its edges and wash change with it; under "reduce motion" it only changes colour.
 */
export const LEAN_MOTION = "transition-[scale,border-color,background-color,color] duration-(--t-pop) ease-(--ease-snap) motion-reduce:transition-none";

/**
 * A place that takes library items of some kinds (and, when `file` is given, a file from the
 * computer). `wanted` is true while such an item is being dragged anywhere; `over` while it is above
 * this place. `zone` is the border and the wash to draw for both. `lean` is the same for a drop box of
 * the form, which draws its own edges: dashed while something it takes is dragged, solid with the wash and
 * a little larger under the pointer (with LEAN_MOTION); nothing otherwise, its own resting edge then.
 */
export function useDropZone(types: string[], take: (id: string) => void, file?: (file: File) => void) {
  const [over, setOver] = useState(false);
  const wanted = useDragged((s) => types.some((t) => s.types.includes(t)));
  const fits = (e: DragEvent) => types.some((t) => e.dataTransfer.types.includes(t)) || (Boolean(file) && e.dataTransfer.types.includes("Files"));
  return {
    over,
    wanted,
    zone: over ? "border-accent bg-accent-wash text-ink" : wanted ? "border-accent" : "",
    lean: over ? "border-solid border-accent bg-accent-wash text-ink motion-safe:scale-[1.03]" : wanted ? "border-dashed border-accent" : "",
    props: {
      onDragOver: (e: DragEvent) => {
        if (!fits(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      // only when the pointer leaves the place itself: going over its picture or its words is still over it, and
      // a box that let go and leaned in again at each of them would shake
      onDragLeave: (e?: DragEvent) => {
        if (e && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!fits(e)) return;
        e.preventDefault();
        setOver(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped) file?.(dropped);
        else {
          // several ticked items dragged together: a place for one takes the first
          const id = e.dataTransfer.getData(DRAG_TYPE).split(",")[0];
          if (id) take(id);
        }
      },
    },
  };
}
