import { Suspense, type ComponentProps } from "react";
import type { Viewer as Loaded } from "../Viewer";
import { lazyPart, loadViewer } from "../lazyParts";

// the viewer's code is a chunk of its own, fetched the first time an item is opened: the screens that open items take
// it from here, so that no file loaded with the app imports the Viewer itself (one such import puts it in the first load)
const Chunk = lazyPart(loadViewer, (m) => m.Viewer);

/** The Viewer, loaded on its first use; nothing is drawn in its place for the moment that takes. */
export function Viewer(props: ComponentProps<typeof Loaded>) {
  return (
    <Suspense fallback={null}>
      <Chunk {...props} />
    </Suspense>
  );
}
