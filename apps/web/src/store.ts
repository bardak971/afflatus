import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { NotifyKind, SystemLoad } from "./api";
import { useProject, type ProjectChoice } from "./project";
import type { GroupBy } from "./screens/studio/grouping";

/** The machine's load, pushed by the server about every two seconds: the first ComfyUI's, and every one's by machine id. */
export const useSystem = create<{ load: SystemLoad | null; loads: Record<string, SystemLoad | null>; set(load: SystemLoad | null, loads?: Record<string, SystemLoad | null>): void }>((set) => ({
  load: null,
  loads: {},
  set: (load, loads = {}) => set({ load, loads }),
}));

/** With several ComfyUIs, the machine whose meters the status bar shows: the one whose chip was last clicked (null: the one of the render shown, else the first). */
export const useMeteredMachine = create<{ id: string | null; set(id: string | null): void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}));

/** Whether the live connection (live.ts) has been down for a few seconds: the status bar says so until it is back. */
export const useLive = create<{ down: boolean; set(down: boolean): void }>((set) => ({
  down: false,
  set: (down) => set({ down }),
}));

/** The kinds of notice this browser shows as a notification of its own: a kind not named is not shown. */
export type BrowserTicks = Partial<Record<NotifyKind, boolean>>;
type NotifyState = { browser: BrowserTicks; banner: boolean };

/**
 * This browser's notices from before they were per kind (version 0): "after each render" was a render done or failed,
 * "when the queue is empty" the queue's own; carried over, so that nobody loses their choice.
 */
export function notifyMigrate(old: unknown, version: number): NotifyState {
  const o = (old && typeof old === "object" ? old : {}) as Partial<NotifyState> & { whenEmpty?: boolean; eachRender?: boolean };
  if (version >= 1) return { browser: o.browser ?? {}, banner: o.banner ?? true };
  return { banner: o.banner ?? true, browser: { renderDone: Boolean(o.eachRender), renderFailed: Boolean(o.eachRender), queueEmpty: Boolean(o.whenEmpty) } };
}

/**
 * What this browser should tell you about, with a notification of its own (the server's notices, per kind: nothing more
 * leaves the computer), and whether the app's own banner says when renders finish while another screen is open (`banner`;
 * failures are always said). Kept per browser: a notification is shown by the browser that asked for it.
 */
export const useNotify = create<NotifyState & { set(patch: { browser?: BrowserTicks; banner?: boolean }): void }>()(
  persist(
    (set) => ({
      browser: {},
      banner: true,
      set: (patch) => set((s) => ({ ...(patch.banner === undefined ? {} : { banner: patch.banner }), ...(patch.browser ? { browser: { ...s.browser, ...patch.browser } } : {}) })),
    }),
    { name: "afflatus.notify", version: 1, migrate: notifyMigrate },
  ),
);

/**
 * Whether a card plays as the mouse rests on it: a video's own frames, and the sound of a video or a sound card. Kept per
 * browser, like the theme. Off, a video card shows its frame and a sound card its icon; the viewer still plays everything.
 */
export const useHoverPlay = create<{ video: boolean; sound: boolean; set(patch: { video?: boolean; sound?: boolean }): void }>()(
  persist((set) => ({ video: true, sound: true, set: (patch) => set(patch) }), { name: "afflatus.hover-play" }),
);

/**
 * Whether Compare (X) opens on the original and what a pass made of it, when there is one: on a result, its source is
 * pinned beside it; on a picture something was made from, the newest of those comes beside it. Off: Compare pins the item
 * and the arrow keys bring the next one of the list, as before. Kept per browser.
 */
export const useCompareResult = create<{ on: boolean; set(on: boolean): void }>()(
  persist((set) => ({ on: true, set: (on) => set({ on }) }), { name: "afflatus.compare-result" }),
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
  /** Where a click on it leads. Left out (with `go`): it leads nowhere, what it is about being on screen already. */
  href?: string;
  /** What the link is called. */
  go?: string;
  /** What a click does in place of going to `href` (a reload). */
  act?(): void;
  /**
   * A button of its own beside the words (Undo, Retry): what it says, the key shown with it, what it does. `undo`: Ctrl+Z
   * presses it while the banner is up (the newest such banner), on a screen whose own Ctrl+Z does nothing else.
   */
  action?: { label: string; key?: string; undo?: boolean; run(): void };
  /** What closing it also does (a failure marked read, so that a reload does not bring it back). */
  onDismiss?(): void;
}
/** How many banners show at once: past it, the oldest good news goes first. Bad news is never dropped unread. */
const BANNERS = 5;
export const useBanners = create<{ items: Banner[]; push(b: Banner): void; dismiss(id: string): void }>((set) => ({
  items: [],
  // the same id again: that banner said anew in its place (a fold of a batch counting up, "3 done" → "4 done")
  push: (b) =>
    set((s) => {
      const was = s.items.find((x) => x.id === b.id);
      if (was) return was.title === b.title && was.text === b.text ? s : { items: s.items.map((x) => (x === was ? b : x)) };
      const items = [...s.items, b];
      while (items.length > BANNERS) {
        const old = items.findIndex((x) => x.tone === "good");
        if (old < 0) break;
        items.splice(old, 1);
      }
      return { items };
    }),
  dismiss: (id) =>
    set((s) => {
      s.items.find((x) => x.id === id)?.onDismiss?.();
      return { items: s.items.filter((x) => x.id !== id) };
    }),
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
 * so it is the same from another browser or after a restart. `under`: the project looked at when it was
 * opened (a draft of another project opened since is followed there; a project switched to since gets its own
 * draft, see `draftForProject`). `last`: the draft last open in each project ("none": the Inbox).
 */
export const useOpenDraft = create<{ id: string | null; under?: ProjectChoice; last: Record<string, string>; open(id: string | null): void; remember(project: string, id: string): void }>()(
  persist(
    (set) => ({
      id: null,
      last: {},
      open: (id) => set({ id, under: useProject.getState().id }),
      remember: (project, id) => set((s) => (s.last[project] === id ? s : { last: { ...s.last, [project]: id } })),
    }),
    { name: "afflatus.open-draft" },
  ),
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

/**
 * The timeline editor's right column (the Overview, a clip's inspector, the music): its own width, which can go
 * narrower than the form's panel so that a 1280 px screen keeps its stage, and folded to a strip by hand only (never
 * by itself: the clip is watched while its form is worked). Both remembered.
 */
/**
 * The editor's right column. Usual: wide enough that a form's rows hold on one line (the resolution's four chips, the
 * shapes): at 380 they broke onto a second one.
 */
export const EDITOR_COLUMN = { least: 320, most: 720, usual: 420 };
/** The usual width before it was 420: a column left at it (never dragged) takes the new one. */
const OLD_USUAL = 380;
export const useEditorColumn = create<{ width: number; folded: boolean; set(width: number): void; fold(folded: boolean): void }>()(
  persist(
    (set) => ({
      width: EDITOR_COLUMN.usual,
      folded: false,
      set: (width) => set({ width: Math.max(EDITOR_COLUMN.least, Math.min(EDITOR_COLUMN.most, Math.round(width))) }),
      fold: (folded) => set({ folded }),
    }),
    {
      name: "afflatus.editor-column",
      version: 1,
      migrate: (saved, version) => {
        const s = (saved ?? {}) as { width?: number; folded?: boolean };
        return version < 1 && s.width === OLD_USUAL ? { ...s, width: EDITOR_COLUMN.usual } : s;
      },
    },
  ),
);

/** Where the library's grid is looking, inside the project worked in: the whole of it ("all"), what is in no folder (the Inbox's loose items), one folder, or the bin (every project's). */
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
// The address says whether the form is open when the app is loaded ("/create" open, "/" closed), over what was
// remembered: a reload keeps what the address showed, and a link to either lands as it says.
if (typeof window !== "undefined" && (window.location.pathname === "/" || window.location.pathname === "/create")) useStudio.setState({ form: window.location.pathname === "/create" });
// the bin is visited, not worked in: the app opens on the project, not on the bin it was left in
if (typeof window !== "undefined" && useStudio.getState().place.type === "bin") useStudio.setState({ place: { type: "all" } });
/** What a scope shows: what it was left on, else the stage for "This draft" and the last grid size elsewhere. */
export const displayOf = (v: { size: "S" | "M" | "L"; displays?: Partial<Record<Scope, Display>> }, scope: Scope): Display => v.displays?.[scope] ?? (scope === "draft" ? "Stage" : v.size);
/** The folder open in the library, for what is brought in from outside (a drop, an upload): null when none is. */
export const openFolderId = (): string | null => {
  const p = useStudio.getState().place;
  return p.type === "folder" ? p.id : null;
};
