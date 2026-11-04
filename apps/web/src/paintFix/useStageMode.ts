import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the Stage draws over a picture: the mask painted for a fix (Inpaint), or the frame dragged out (Outpaint). */
export type StageMode = "paint" | "outpaint";

/**
 * Which picture the Stage works on in place, and how: Inpaint (I) and Outpaint (R) set it rather than opening a draft, and
 * the viewer showing that picture draws Paint and fix over it (ViewerMedia.tsx). One at a time for the whole app: a second
 * picture asked for takes the place of the first. Esc, or another item shown, leaves it.
 */
export const useStageMode = create<{ on: { asset: string; mode: StageMode } | null; set(asset: string, mode: StageMode): void; leave(): void }>((set) => ({
  on: null,
  set: (asset, mode) => set({ on: { asset, mode } }),
  leave: () => set({ on: null }),
}));

/**
 * The drafts opened from Paint and fix's ⚙ (Open the full form): what they render on the picture they were opened on comes
 * back as versions of it too, as the bar's own Fix does. Kept in this browser (a draft opened elsewhere renders new items),
 * by draft id; a draft whose picture was changed in its form renders new items again (versionOfDraft).
 */
export const useVersionDrafts = create<{ of: Record<string, string>; mark(draft: string, picture: string): void }>()(
  persist(
    (set) => ({
      of: {},
      // the last few dozen only: an old draft opened again renders new items, which is what it did before
      mark: (draft, picture) => set((s) => ({ of: Object.fromEntries([...Object.entries(s.of).filter(([d]) => d !== draft), [draft, picture]].slice(-KEPT_DRAFTS)) })),
    }),
    { name: "afflatus-version-drafts" },
  ),
);

/** An outpaint the Stage's frame can drive: one that takes the sides (shape Custom); another is left to its form. */
export const outpaintsByFrame = (tool: { inputs: Array<{ id: string }> } | undefined): boolean => Boolean(tool?.inputs.some((i) => i.id === "padLeft"));

/** How many such drafts this browser remembers. */
const KEPT_DRAFTS = 50;

/** The picture a draft's render is a version of: the one it was opened from, while its source slot still holds it. */
export function versionOfDraft(draft: string, source: unknown): string | undefined {
  const picture = useVersionDrafts.getState().of[draft];
  return picture && source === picture ? picture : undefined;
}
