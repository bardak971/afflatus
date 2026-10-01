import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SystemLoad } from "./api";

/** The machine's load, pushed by the server about every two seconds. */
export const useSystem = create<{ load: SystemLoad | null; set(load: SystemLoad | null): void }>((set) => ({
  load: null,
  set: (load) => set({ load }),
}));

/**
 * What this browser should tell you about, with a notification of its own (nothing leaves the computer).
 * Kept per browser: a notification is shown by the browser that asked for it.
 */
export const useNotify = create<{ whenEmpty: boolean; eachRender: boolean; set(patch: { whenEmpty?: boolean; eachRender?: boolean }): void }>()(
  persist((set) => ({ whenEmpty: false, eachRender: false, set: (patch) => set(patch) }), { name: "studai.notify" }),
);

/** Ask the browser for the right to show notifications. False when it was refused, or cannot. */
export async function allowNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/**
 * Things handed from one screen to another when a file is dropped: a workflow for the import screen
 * to open, a library item for the library to show. Each is taken once.
 */
export const useHandover = create<{ workflow: File | null; show: string | null; set(patch: { workflow?: File | null; show?: string | null }): void }>((set) => ({
  workflow: null,
  show: null,
  set: (patch) => set(patch),
}));

/**
 * Which draft this browser has open. Only the pointer lives here: the draft itself is on the server,
 * so it is the same from another browser or after a restart.
 */
export const useOpenDraft = create<{ id: string | null; open(id: string | null): void }>()(
  persist((set) => ({ id: null, open: (id) => set({ id }) }), { name: "studai.open-draft" }),
);
