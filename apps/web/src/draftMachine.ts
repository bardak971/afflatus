import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The machine each draft generates on, when one was picked (Generate's machine slice): by draft id, a machine's id. A
 * draft not named generates where it would end first (Auto). Kept in this browser: a draft set to the second GPU stays on
 * it, and picking it for one idea does not move the others.
 */
export const useDraftMachine = create<{ of: Record<string, string>; set(draft: string, machine: string | null): void }>()(
  persist(
    (set) => ({
      of: {},
      set: (draft, machine) =>
        set((s) => {
          const of = { ...s.of };
          if (machine) of[draft] = machine;
          else delete of[draft];
          return { of };
        }),
    }),
    { name: "afflatus.draft-machine" },
  ),
);
