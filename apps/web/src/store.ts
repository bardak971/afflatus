import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SystemLoad } from "./api";
import type { GroupBy } from "./screens/studio/grouping";

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

/**
 * Whether a card plays as the mouse rests on it: a video's own frames, and the sound of a video or a sound card. Kept per
 * browser, like the theme. Off, a video card shows its frame and a sound card its icon; the viewer still plays everything.
 */
export const useHoverPlay = create<{ video: boolean; sound: boolean; set(patch: { video?: boolean; sound?: boolean }): void }>()(
  persist((set) => ({ video: true, sound: true, set: (patch) => set(patch) }), { name: "afflatus.hover-play" }),
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
  /** What a click does in place of going to `href` (a reload). */
  act?(): void;
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
export const usePanelWidth = create<{ width: number; set(width: number): void }>()(
  persist((set) => ({ width: PANEL.usual, set: (width) => set({ width: Math.max(PANEL.least, Math.min(PANEL.most, Math.round(width))) }) }), { name: "afflatus.panel-width" }),
);

/** Where the library's grid is looking: everything, what is in no folder, one folder, or the bin. */
export type Place = { type: "all" } | { type: "unfiled" } | { type: "folder"; id: string } | { type: "bin" };

/**
 * The Studio's view. Kept here, not in the screen's module, so that what reads it from elsewhere (a tile's
 * menu, the drop tray, the timeline's media) does not import the screen, nor the screen them in a circle.
 */
/** How the screen was left: kept from one visit to the next, and while another screen is open. */
export type Display = "Stage" | "S" | "M" | "L";
/** What the grid shows while the form is open: this draft's outputs, the whole folder, the last two days. ("Kept" is in Filters now: a store left on it shows the folder, see useLibraryFilters.) */
export type Scope = "draft" | "all" | "recent";
export const useStudio = create<{
  form: boolean;
  /** The last grid size chosen: what a scope with no display of its own shows. */
  size: "S" | "M" | "L";
  /** The display each scope was left on (Stage: the newest large, the others in a strip). */
  displays: Partial<Record<Scope, Display>>;
  /** How the grid is cut into sections. */
  groupBy: GroupBy;
  /** The Timelines view: its order and the size of its cards. */
  timelineSort: "recent" | "name" | "length";
  timelineSize: "S" | "M" | "L";
  scope: Scope;
  place: Place;
  set(patch: Partial<{ form: boolean; size: "S" | "M" | "L"; displays: Partial<Record<Scope, Display>>; groupBy: GroupBy; timelineSort: "recent" | "name" | "length"; timelineSize: "S" | "M" | "L"; scope: Scope; place: Place }>): void;
}>()(persist((set) => ({ form: false, size: "M", displays: {}, groupBy: "none", timelineSort: "recent", timelineSize: "M", scope: "draft", place: { type: "all" }, set: (patch) => set(patch) }), { name: "afflatus.studio" }));
/** What a scope shows: what it was left on, else the stage for "This draft" and the last grid size elsewhere. */
export const displayOf = (v: { size: "S" | "M" | "L"; displays?: Partial<Record<Scope, Display>> }, scope: Scope): Display => v.displays?.[scope] ?? (scope === "draft" ? "Stage" : v.size);
/** The folder open in the library, for what is brought in from outside (a drop, an upload): null when none is. */
export const openFolderId = (): string | null => {
  const p = useStudio.getState().place;
  return p.type === "folder" ? p.id : null;
};
