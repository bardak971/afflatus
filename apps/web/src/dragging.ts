import { useState, type DragEvent } from "react";
import { create } from "zustand";

/**
 * Dragging an item of the library: what the drag carries, and the places it can be dropped on. While
 * one is dragged, every place that takes it shows its border, so that it is seen where it can go
 * before the pointer gets there.
 */

export const DRAG_TYPE = "application/x-studai-asset";
/** Also set, by what is dragged: a drop target can only see these names while something hovers over it, not the item. */
export const DRAG_PICTURE = "application/x-studai-picture";
export const DRAG_VIDEO = "application/x-studai-video";
export const DRAG_SOUND = "application/x-studai-sound";
/** A video that has sound: it can stand for a sound where one is asked for. */
export const DRAG_HAS_SOUND = "application/x-studai-has-sound";
export const dragKind = (kind: "image" | "video" | "audio") => (kind === "image" ? DRAG_PICTURE : kind === "video" ? DRAG_VIDEO : DRAG_SOUND);

/** What is being dragged right now, as the names it carries. Empty when nothing of the library is. */
export const useDragged = create<{ types: string[] }>(() => ({ types: [] }));

if (typeof window !== "undefined") {
  const ours = (t: string) => t.startsWith("application/x-studai-");
  // in the bubbling phase: by then the item that is dragged has said what it carries
  window.addEventListener("dragstart", (e) => useDragged.setState({ types: [...(e.dataTransfer?.types ?? [])].filter(ours) }));
  const done = () => useDragged.getState().types.length && useDragged.setState({ types: [] });
  window.addEventListener("dragend", done);
  // an item that is redrawn while it is dragged never says it ended: the drop says so
  window.addEventListener("drop", done, true);
}

/**
 * A place that takes library items of some kinds (and, when `file` is given, a file from the
 * computer). `wanted` is true while such an item is being dragged anywhere; `over` while it is above
 * this place. `zone` is the border and the wash to draw for both.
 */
export function useDropZone(types: string[], take: (id: string) => void, file?: (file: File) => void) {
  const [over, setOver] = useState(false);
  const wanted = useDragged((s) => types.some((t) => s.types.includes(t)));
  const fits = (e: DragEvent) => types.some((t) => e.dataTransfer.types.includes(t)) || (Boolean(file) && e.dataTransfer.types.includes("Files"));
  return {
    over,
    wanted,
    zone: over ? "border-accent bg-accent-wash text-ink" : wanted ? "border-accent" : "",
    props: {
      onDragOver: (e: DragEvent) => {
        if (!fits(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
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
