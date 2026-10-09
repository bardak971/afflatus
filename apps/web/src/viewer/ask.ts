/**
 * What the viewer is asked to do as it opens on an item: Trim, Compare and Details from a list shown outside it (a
 * tile's menu, the command bar) open the viewer on the item with that tool. The place that asks opens the viewer
 * right after; the viewer takes the ask once, for that item, and forgets one left too long (the viewer never came).
 */
export type ViewerAsk = "trim" | "compare" | "details";

let pending: { id: string; what: ViewerAsk; at: number } | null = null;

export function askViewer(id: string, what: ViewerAsk): void {
  pending = { id, what, at: Date.now() };
}

export function takeViewerAsk(id: string): ViewerAsk | null {
  if (!pending || pending.id !== id) return null;
  const { what, at } = pending;
  pending = null;
  return Date.now() - at < 5000 ? what : null;
}
