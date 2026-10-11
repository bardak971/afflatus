import { Suspense, useEffect, useRef, useState } from "react";
import { kindOfType, type Kind } from "./dropZones";
import { lazyPart, loadDropTrayBody } from "./lazyParts";

const Body = lazyPart(loadDropTrayBody, (m) => m.DropTrayBody);

/** What is being dragged over the window, told from the first file's type (its name cannot be read until it is dropped). */
const kindOf = (e: DragEvent): Kind | null =>
  kindOfType([...(e.dataTransfer?.items ?? [])].find((i) => i.kind === "file")?.type, Boolean(e.dataTransfer?.types.includes("Files")));

/**
 * A file dragged in from the computer, anywhere in the app: a tray comes up with what can be done with
 * it, and it is dropped on one of them. The tray sits at the bottom so that the page's own places to drop
 * (a picture slot in a form, the timeline) stay in reach. Here, what is dragged is followed; the tray itself
 * (DropTrayBody.tsx) is fetched with the Studio's other chunks while the page is idle, and drawn from the first drag.
 */
export function DropTray() {
  const [kind, setKind] = useState<Kind | null>(null);
  const [dragged, setDragged] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current++;
      setKind(kindOf(e));
      setDragged(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setKind(null);
    };
    // a file let go of outside every place to drop must not make the browser open it
    const hold = (e: DragEvent) => files(e) && e.preventDefault();
    const end = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
      depth.current = 0;
      setKind(null);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", hold);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", hold);
      window.removeEventListener("drop", end);
    };
  }, []);

  return dragged ? (
    <Suspense fallback={null}>
      <Body kind={kind} />
    </Suspense>
  ) : null;
}
