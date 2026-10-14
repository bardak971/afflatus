/**
 * A transition on a cut between two clips: how the picture goes from one to the other. It belongs to the join (the clip
 * after keeps it, as it keeps how it meets the clip before), and it is centred on the cut: the clip before plays to its end
 * and the clip after from its start, as without it, so no clip moves on the timeline (the source's sound under bound clips
 * stays in step). Over its first half the clip after is held on its first frame, over its second half the clip before on
 * its last one. The same sums in the export (ffmpeg's xfade) and in the player.
 */
import { FRAME_SLACK_MS, MIN_FADE_MS } from "./joins";

export const TRANSITION_KINDS = ["dissolve", "dip-black", "dip-white", "flash", "wipe-left", "wipe-right", "slide-left", "slide-right", "circle", "zoom"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TransitionInfo {
  label: string;
  /** Its length when it is first put on a join. */
  ms: number;
  /** xfade's own transition, or "custom" with an expression (the export's). */
  xfade: string;
  /** Over the cut: a colour the picture passes through (no overlap of the two clips), or both pictures mixed. */
  through: "colour" | "both";
}

export const TRANSITIONS: Record<TransitionKind, TransitionInfo> = {
  dissolve: { label: "Cross dissolve", ms: 500, xfade: "fade", through: "both" },
  "dip-black": { label: "Dip to black", ms: 600, xfade: "fadeblack", through: "colour" },
  "dip-white": { label: "Dip to white", ms: 600, xfade: "fadewhite", through: "colour" },
  flash: { label: "Flash", ms: 250, xfade: "custom", through: "colour" },
  "wipe-left": { label: "Wipe left", ms: 500, xfade: "wipeleft", through: "both" },
  "wipe-right": { label: "Wipe right", ms: 500, xfade: "wiperight", through: "both" },
  "slide-left": { label: "Slide left", ms: 500, xfade: "slideleft", through: "both" },
  "slide-right": { label: "Slide right", ms: 500, xfade: "slideright", through: "both" },
  circle: { label: "Circle open", ms: 600, xfade: "circleopen", through: "both" },
  zoom: { label: "Zoom in", ms: 500, xfade: "zoomin", through: "both" },
};

/** The lengths a transition can be given. */
export const TRANSITION_MS = { least: 80, most: 2000 } as const;

/** A cut's transition as a clip keeps it: its kind, its length, and whether the sound fades out and in over it or runs straight on. */
export interface Transition {
  kind: TransitionKind;
  ms: number;
  sound: "on" | "fade";
}

/** A transition as stored (JSON), or as a request carries it: checked, its length held within TRANSITION_MS; null when it is not one. */
export function transitionOf(raw: unknown): Transition | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.kind !== "string" || !(TRANSITION_KINDS as readonly string[]).includes(x.kind)) return null;
  const kind = x.kind as TransitionKind;
  const ms = typeof x.ms === "number" && Number.isFinite(x.ms) ? Math.round(Math.max(TRANSITION_MS.least, Math.min(TRANSITION_MS.most, x.ms))) : TRANSITIONS[kind].ms;
  return { kind, ms, sound: x.sound === "fade" ? "fade" : "on" };
}

/** A new transition of this kind, at its usual length. */
export const newTransition = (kind: TransitionKind): Transition => ({ kind, ms: TRANSITIONS[kind].ms, sound: "on" });

/**
 * How long a transition plays at a join, between a clip of `beforeMs` and one of `afterMs` (what each plays): each half
 * within its clip, less a frame. 0 when there is none: not a cut, no clip before, or too short to be seen.
 */
export function transitionSpan(t: Transition | null | undefined, joined: "continue" | "cut", beforeMs: number | undefined, afterMs: number): number {
  if (!t || joined !== "cut" || beforeMs === undefined) return 0;
  const ms = Math.min(t.ms, 2 * (beforeMs - FRAME_SLACK_MS), 2 * (afterMs - FRAME_SLACK_MS));
  return ms >= MIN_FADE_MS ? Math.round(ms) : 0;
}

/**
 * Two video models meet at a join that extends: the motion carries on, but each model draws the person its own way, so
 * the face can change there (a VACE bridge across it was tried, 2026-10-14, and did not help). Said on the join, never refused.
 */
export const modelsDiffer = (before: { family?: string | null } | undefined, after: { family?: string | null } | undefined) =>
  Boolean(before?.family && after?.family && before.family !== after.family);
