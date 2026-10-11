import { useEffect, useRef, useState } from "react";
import { DRAG_TYPE } from "../../dragging";

/**
 * The project's tree under the breadcrumb, opened by a click (`"click"`) or by itself while something is dragged
 * (`"drag"`), to drop it on a folder: an item of the library, or a file from the computer (the drop tray stays for the
 * other actions). On the timelines (`showTimelines`) the drop target is the New timeline card: a file dragged in does not
 * open the tree over it.
 */
export function useFolderDrag(showTimelines: boolean) {
  const [foldersOpen, setFoldersOpen] = useState<false | "click" | "drag">(false);
  const timelinesShown = useRef(showTimelines);
  timelinesShown.current = showTimelines;
  useEffect(() => {
    // after the drag has started (see dragging.ts): opened in the dragstart itself, the drag was sometimes cancelled
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setTimeout(() => setFoldersOpen((o) => o || "drag"), 0);
    const end = () => setFoldersOpen((o) => (o === "drag" ? false : o));
    // a file from the computer: the same panel, so that it can be dropped straight into a folder (the drop tray stays for the other actions)
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      if (!timelinesShown.current) setFoldersOpen((o) => o || "drag");
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) end();
    };
    const dropped = (e: DragEvent) => {
      if (!files(e)) return;
      depth = 0;
      end();
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", dropped);
    };
  }, []);
  return { foldersOpen, setFoldersOpen };
}
