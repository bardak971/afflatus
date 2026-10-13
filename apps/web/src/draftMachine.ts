import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The machine each draft generates on, and each timeline renders its clips on, when one was picked (the machine slice of
 * Generate and New take): by draft id or timelineKey, a machine's id. One not named renders where it would end first
 * (Auto). Kept in this browser: a draft set to the second GPU stays on it, and picking it for one idea moves no other.
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

/** A timeline's key in that store: its clips render on the machine picked for the whole timeline. */
export const timelineKey = (id: string) => `timeline:${id}`;
