import { useEffect } from "react";
import type { PlaceId } from "./table";

/**
 * Which places of the keys sheet are open now, said by the screens themselves: each mounts `useKeysHere` while its
 * keys act, so the sheet's "Here now" is what is on screen, not a guess read off the page. `over` marks a place
 * drawn over the screen (the viewer opened large, the mask painter): the screen's own places under it do not act then.
 */
export interface Here {
  place: PlaceId;
  /** The viewer's item: its image or video keys first. */
  kind?: "image" | "video" | "audio";
  over?: boolean;
}

const open = new Set<Here>();

/** The places open now, the one opened last first. */
export function hereNow(): Here[] {
  return [...open].reverse();
}

/** While mounted (and `on`), the place is open: its keys are listed under "Here now". */
export function useKeysHere(place: PlaceId, on = true, extra: { kind?: Here["kind"]; over?: boolean } = {}): void {
  const { kind, over } = extra;
  useEffect(() => {
    if (!on) return;
    const me: Here = { place, kind, over };
    open.add(me);
    return () => {
      open.delete(me);
    };
  }, [place, on, kind, over]);
}
