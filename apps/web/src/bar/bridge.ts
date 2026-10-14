import { create } from "zustand";
import type { Look } from "../api/types/designer";
import { useFormTarget, type FormTarget } from "../formTarget";
import type { ClipCast } from "./castTo";
import type { PinMirror } from "../timeline/model";
import type { TransitionKind } from "@afflatus/core";

/**
 * What the command bar asks of a screen that does the work itself: the timeline editor renders and exports
 * its own timeline (it saves what was typed in a clip's form first, and sends each clip's whole form), so the
 * bar opens the editor and leaves the request here; the editor takes it once its timeline is read. The bar
 * adds no behaviour: it presses the editor's own buttons.
 */
export type TimelineRequest =
  /** `machine`: on that ComfyUI this once (a Machine's id); left out, the timeline's own pick, else Auto. */
  | { timeline: string; do: "render"; clips: number[]; top?: boolean; machine?: string }
  | { timeline: string; do: "render-missing"; top?: boolean; machine?: string }
  /** The export dialog; `editor`: open on "For an editor". */
  | { timeline: string; do: "export"; editor?: boolean }
  /** The selected clip split at the playhead (S); said in the editor's note when the playhead is not inside it. */
  | { timeline: string; do: "split" }
  /** The selected clip plays its take before (-1) or after (1): Alt+[ and Alt+]; at either end it stays. */
  | { timeline: string; do: "take"; by: -1 | 1 }
  /** The editor's Undo (Ctrl+Z); said in its note when there is nothing to undo. */
  | { timeline: string; do: "undo" }
  /** Clip `clip` (counted from 1) selected and the playhead on its start, as a click on it in the track. */
  | { timeline: string; do: "select"; clip: number }
  /** The Finish dialog opened, as the editor's Finish button. */
  | { timeline: string; do: "finish" }
  /** What Needs attention lists, mended as its Fix all does; taken by the overview once its joins are measured. */
  | { timeline: string; do: "fix-all" };

/** A request the editor took, and its answer to the bar: the jobs a render queued (null: none, or an export). */
export interface TakenRequest {
  request: TimelineRequest;
  reply(jobs: string[] | null): void;
}

export const useTimelineRequest = create<{
  request: TimelineRequest | null;
  reply: ((jobs: string[] | null) => void) | null;
  /** Left for the editor; what it answers comes back (a request asked over it is answered null). */
  ask(r: TimelineRequest): Promise<string[] | null>;
  take(): TakenRequest | null;
}>((set, get) => ({
  request: null,
  reply: null,
  ask: (request) => new Promise((reply) => {
    get().reply?.(null);
    set({ request, reply });
  }),
  take: () => {
    const { request, reply } = get();
    set({ request: null, reply: null });
    return request ? { request, reply: reply ?? (() => {}) } : null;
  },
}));

/**
 * The clip selected in the open timeline editor, for the bar's `@name`: what it is made with, who is in it, and the
 * editor's own change of its cast (one step to undo). Null when no editor is open or no clip is selected.
 */
export interface SelectedClip extends ClipCast {
  timeline: string;
  id: string;
  /** Whether the clip has a cast of its own (else it follows the timeline's, which `look` then is). */
  own: boolean;
  setLook(look: Look): Promise<unknown>;
  /** Its pinned frames and what their Mirror says (pinMirrors), and the editor's own switch of one (one step to undo). */
  pins: PinMirror[];
  mirror(input: string, on: boolean): Promise<unknown>;
  /** The join before it, as its column says it: none (the first clip), it extends the clip before, or a cut; and the cut's transition. */
  cutIn: "none" | "extends" | "cut";
  transition: TransitionKind | null;
  /** The cut's transition set or taken off (null), as the column's join choice: one step to undo. */
  setTransition(kind: TransitionKind | null): Promise<unknown>;
  /** Slow motion of the whole clip as a new take, as its menu's ×2 and ×4; null when it has no take to slow. */
  slow: ((factor: 2 | 4) => void) | null;
  /** Its menu's Motion transfer in windows (a video brought in, made into the source lane); null when it is not one. */
  toSource: (() => void) | null;
}
export const useSelectedClip = create<{ clip: SelectedClip | null; set(clip: SelectedClip | null): void }>((set) => ({
  clip: null,
  set: (clip) => set({ clip }),
}));

/**
 * The open draft's form, once the Studio shows it: at once when it is on screen, else after `open` put it
 * there. Null when it did not come within a few seconds (no draft, a recipe that is gone).
 */
export function formWhenOpen(draft: string | null, open: () => void, waitMs = 4000): Promise<FormTarget | null> {
  const now = useFormTarget.getState().target;
  if (now && (!draft || now.draftId === draft)) return Promise.resolve(now);
  open();
  return new Promise((done) => {
    const stop = useFormTarget.subscribe((s) => {
      if (s.target && (!draft || s.target.draftId === draft)) {
        stop();
        clearTimeout(timer);
        done(s.target);
      }
    });
    const timer = setTimeout(() => {
      stop();
      done(null);
    }, waitMs);
  });
}

/**
 * What the bar asks of the Workflows screen, which does it with its own button: the file picker of "Import ComfyUI
 * workflow". Left here, the bar goes to /workflows and the screen takes it.
 */
export type WorkflowsRequest = { do: "import" };

/** The address of a saved workflow in the editor (the list's Edit, the bar's): it opens again on a reload, and Back returns to it. */
export const workflowEditHref = (id: string) => `/workflows/${encodeURIComponent(id)}/edit`;
export const useWorkflowsRequest = create<{ request: WorkflowsRequest | null; ask(r: WorkflowsRequest): void; take(): WorkflowsRequest | null }>((set, get) => ({
  request: null,
  ask: (request) => set({ request }),
  take: () => {
    const r = get().request;
    if (r) set({ request: null });
    return r;
  },
}));

/** Open the Projects panel from elsewhere, its search on `search` (a name to find). */
export const openProjects = (search?: string, reveal?: Reveal) => window.dispatchEvent(new CustomEvent("afflatus:projects", { detail: { search, reveal } }));
/** An item the Projects panel opens on: its project and folders unfolded, its row picked and in sight. */
export type Reveal = { asset: string; folder: string | null; group: string | null };
