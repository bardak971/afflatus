import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Whether the library is open over the editor's stage: kept from one visit to the next. Its own module, so that what
 * opens it from elsewhere on the screen (the track's footer) does not import the shelf and the library with it.
 */
export const useMediaOpen = create<{ open: boolean; set(open: boolean): void }>()(
  persist((set) => ({ open: false, set: (open) => set({ open }) }), { name: "afflatus.media-open" }),
);
