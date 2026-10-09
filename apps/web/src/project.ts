import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Which project the app works in: one project, or the Inbox ("none": what is in no project). One choice for the whole app,
 * kept per browser. The lists scope to it (library, drafts, timelines, the timeline's shelf) and what is made lands in it;
 * forms never scope. There is no "everything" place: finding across projects is the command bar's job.
 */
export type ProjectChoice = string;

/**
 * Before version 1 the choice could be null, "everything". A browser left there works in the Inbox from now on: what was
 * made while looking at everything landed in no project, which is the Inbox already.
 */
export const migrateProject = (stored: unknown): { id: ProjectChoice } => {
  const id = (stored as { id?: unknown } | null)?.id;
  return { id: typeof id === "string" && id ? id : "none" };
};

export const useProject = create<{ id: ProjectChoice; set(id: ProjectChoice | null): void }>()(
  persist(
    // null is taken as the Inbox too: a caller from when it meant "everything" lands somewhere real
    (set) => ({ id: "none", set: (id) => set({ id: id || "none" }) }),
    { name: "afflatus.project", version: 1, migrate: (stored) => migrateProject(stored) },
  ),
);

/** The `project=` value for a list request: "none" for the Inbox, else the project's id. */
export const projectParam = (): string | undefined => useProject.getState().id || undefined;
/** What a new draft or timeline is made in: the project worked in, or nothing (the Inbox). */
export const projectForNew = (): string | null => {
  const id = useProject.getState().id;
  return id && id !== "none" ? id : null;
};
