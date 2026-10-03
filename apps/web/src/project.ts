import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Which project the app is looking at: one project, the Inbox (what is in no project), or everything.
 * One choice for the whole app, kept per browser. The lists scope to it (library, drafts, timelines, the
 * timeline's shelf); forms never do.
 */
export type ProjectChoice = string | "none" | null;

export const useProject = create<{ id: ProjectChoice; set(id: ProjectChoice): void }>()(
  persist((set) => ({ id: null, set: (id) => set({ id }) }), { name: "afflatus.project" }),
);

/** The `project=` value for a list request: left out for everything, "none" for the Inbox, else the id. */
export const projectParam = (): string | undefined => useProject.getState().id ?? undefined;
/** What a new draft or timeline is made in: a project, or nothing (the Inbox, also while looking at everything). */
export const projectForNew = (): string | null => {
  const id = useProject.getState().id;
  return id && id !== "none" ? id : null;
};
