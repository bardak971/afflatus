import { useDebounced } from "../hooks";

/**
 * The moment whose exact frame is shown under the mouse on a strip: asked for a moment after the mouse settles on it
 * (`hoverMs`), none at once when the mouse has left.
 */
export function usePeek(hoverMs: number | undefined): number | null {
  const settled = useDebounced(hoverMs === undefined ? null : Math.round(hoverMs), 90, true, null);
  return hoverMs === undefined ? null : settled;
}
