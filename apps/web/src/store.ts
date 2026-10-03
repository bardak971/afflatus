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
  persist((set) => ({ whenEmpty: false, eachRender: false, set: (patch) => set(patch) }), { name: "afflatus.notify" }),
);

/** Ask the browser for the right to show notifications. False when it was refused, or cannot. */
export async function allowNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/** A banner shown over whatever screen is open: something failed, or finished. Clicking it goes to where it is. */
export interface Banner {
  id: string;
  tone: "bad" | "good";
  title: string;
  text?: string;
  /** Where a click on it leads. */
  href: string;
  /** What the link is called. */
  go: string;
}
export const useBanners = create<{ items: Banner[]; push(b: Banner): void; dismiss(id: string): void }>((set) => ({
  items: [],
  push: (b) => set((s) => (s.items.some((x) => x.id === b.id) ? s : { items: [...s.items.slice(-4), b] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

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
  persist((set) => ({ id: null, open: (id) => set({ id }) }), { name: "afflatus.open-draft" }),
);

/**
 * Whether forms explain their settings in full, a line under each control, or keep the explanations
 * behind a small ? that tells on hover. On at first: a form explains itself until it is known.
 */
export const useExplain = create<{ on: boolean; set(on: boolean): void }>()(// version 1: the explanations start folded behind the ? (they started open before: that stored value is dropped)
persist((set) => ({ on: false, set: (on) => set({ on }) }), { name: "afflatus.explain", version: 1, migrate: () => ({ on: false }) }));

/** How wide the side panel that holds a form is, in pixels: dragged by its edge, remembered. */
export const PANEL = { least: 380, most: 720, usual: 440 };
/** The timeline's media shelf: how wide, and whether it is folded to a rail. */
export const SHELF = { least: 160, usual: 224, most: 560 };
export const useShelfWidth = create<{ width: number; collapsed: boolean; set(width: number): void; fold(collapsed: boolean): void }>()(
  persist((set) => ({ width: SHELF.usual, collapsed: false, set: (width) => set({ width: Math.max(SHELF.least, Math.min(SHELF.most, Math.round(width))) }), fold: (collapsed) => set({ collapsed }) }), { name: "afflatus.shelf" }),
);

export const usePanelWidth = create<{ width: number; set(width: number): void }>()(
  persist((set) => ({ width: PANEL.usual, set: (width) => set({ width: Math.max(PANEL.least, Math.min(PANEL.most, Math.round(width))) }) }), { name: "afflatus.panel-width" }),
);
