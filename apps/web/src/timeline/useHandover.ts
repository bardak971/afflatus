import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { FRAME_SLACK_MS, joinFade, MIN_FADE_MS, soundHandover, TRANSITIONS, transitionSpan } from "@afflatus/core";
import type { Clip } from "../api";
import { heardByVideo } from "./useSong";

/**
 * How long before a clip ends the clip after starts running hidden, so that it takes over with frames ready and in step. Over
 * 800 ms the two decodes at once dropped every other frame of the clip seen in its last 0.6 s (12 to 18 frames before each
 * hand-over, check:player); 300 ms drops 2, and still leaves the sound's hand-over (SOUND_HANDOVER_MS) a clip already running.
 */
const PREROLL_MS = 300;
/** How early the cut to the clip after is made: a video frame at 48 a second plus the animation frame the check may be late by. */
const CUT_EARLY_MS = 24;
/**
 * How long this clip may stay on its last frame for a clip after that is still behind its start: on a loaded machine it began
 * late (its video starts slowly) and showing it at once put a frame of its hidden run-up on screen (card #48). Past this it
 * is shown anyway, should it have stalled: a still picture is worse than one moment seen twice.
 */
const HOLD_MS = 300;

/**
 * How the clip after fades in over `from` as the player hands over, the same as the export (joinFade in @afflatus/core):
 * landed on, over the moments both show ("overlap", `blend` here); a continuation of a video, over `from` held on its last
 * frame ("hold", a dissolve here). Within both clips' lengths; null when there is no fade.
 */
export function fadeIn(c: Clip | undefined, from: Clip | undefined): { ms: number; mode: "hold" | "overlap" } | null {
  // a cut's transition plays over the join in its place, as in the export
  if (!c?.take || !from || crossingOf(c, from)) return null;
  const f = joinFade({ landedMs: c.take.landedMs, joined: c.joined === "continue" && Boolean(from.take), seamless: Boolean(c.take.seamless), sharedMs: c.take.headMs - c.take.trimStartMs, moving: c.take.joinKind === "window" });
  if (!f) return null;
  const ms = Math.min(f.ms, c.lengthMs - FRAME_SLACK_MS, ...(f.mode === "overlap" ? [from.lengthMs - FRAME_SLACK_MS] : []));
  return ms >= MIN_FADE_MS ? { ms, mode: f.mode } : null;
}
/** Over the moments both show: the take landed on. */
export const blendOf = (c: Clip | undefined, from: Clip | undefined) => (fadeIn(c, from)?.mode === "overlap" ? fadeIn(c, from)!.ms : 0);
/** Dissolved in over the clip before held on its last frame: a continuation (DISSOLVE_MS: longer doubled a moving subject). */
export const dissolveOf = (c: Clip | undefined, from: Clip | undefined) => (fadeIn(c, from)?.mode === "hold" ? fadeIn(c, from)!.ms : 0);

/**
 * How many ms before a seamless join into `c` (or one whose head carries `from`'s own sound, an LTX join) its sound takes over from `from`'s, as the export hands it (core soundHandover):
 * `c` runs hidden over its head meanwhile (PREROLL_MS), the same moments as `from`'s last ones, whose own sound ends silent.
 */
export function soundHandoverOf(c: Clip | undefined, from: Clip | undefined): number {
  // the song played as one track on either side (useSong): nothing to hand over, it runs on
  if (!c?.take || !from?.take || c.joined !== "continue" || c.transition || c.soundParts || from.soundParts) return 0;
  return soundHandover({
    seamless: Boolean(c.take.seamless),
    carried: Boolean(c.take.carried),
    bothOwnSound: c.sound === "own" && from.sound === "own" && Boolean(c.take.asset.hasSound) && Boolean(from.take.asset.hasSound),
    shownFromMs: c.take.startMs,
    beforeMs: from.lengthMs,
    guessedHead: Boolean(c.take.laidSound && !c.take.headSung),
  });
}

/**
 * The cut's transition into `c` from `from`, as the export plays it (core transitionSpan): its length, and whether the two
 * pictures are mixed over it ("both": the clip after waits on its first frame, the clip before stays on its last one).
 */
export function crossingOf(c: Clip | undefined, from: Clip | undefined): { ms: number; both: boolean; fadeSound: boolean } | null {
  if (!c?.transition || !from) return null;
  const ms = transitionSpan(c.transition, c.joined, from.lengthMs, c.lengthMs);
  return ms ? { ms, both: TRANSITIONS[c.transition.kind].through === "both", fadeSound: c.transition.sound === "fade" } : null;
}

/** What the player keeps of the hand-over between two clips, by the refs and setters it shares with it. */
export interface Handover {
  seq: Clip[];
  at: number;
  playing: boolean;
  els: MutableRefObject<Map<string, HTMLVideoElement>>;
  /** Where the clip on screen is, and when that was last worked out (a picture has no clock of its own). */
  pos: MutableRefObject<{ key: string; local: number; at: number }>;
  said: MutableRefObject<number>;
  masterRef: MutableRefObject<number>;
  /** The clip after is running, hidden (see PREROLL_MS); its fade has begun; it has shown its first frame; it is watched on its own frames. */
  fadeOn: MutableRefObject<boolean>;
  fadedIn: MutableRefObject<boolean>;
  handReady: MutableRefObject<boolean>;
  armed: MutableRefObject<boolean>;
  thaw: MutableRefObject<number>;
  /** The transition into the clip after has begun (started once, see crossingOf). */
  crossOn: MutableRefObject<boolean>;
  /** Plays a cut's transition from `from` to `to`, `intoMs` into it (Player: its keyframes on both and on the veil). */
  cross(from: Clip, to: Clip, ms: number, intoMs: number): void;
  setFrozen: Dispatch<SetStateAction<Clip | null>>;
  setFading: Dispatch<SetStateAction<number>>;
  place(index: number, local: number, onward?: boolean): void;
  onPlaying(playing: boolean): void;
  onTime(ms: number): void;
  /** Where the moment must be said the frame it is reached, not at the next of onTime's few a second (a range's Out). */
  stopAt?: () => number | null;
  tuneMusic(global: number, force?: boolean): void;
  keyOf(c: Clip): string;
  startOf(c: Clip): number;
}

/**
 * The player's frame loop while it plays: the clip on screen followed on its video's clock, the clip after started early and
 * hidden so that it takes over in step, faded or dissolved in as the export does, the playhead and the music run on. Looked
 * at on every frame; the video's own clock also calls it (the step it hands back), because a browser stops drawing frames for
 * a tab that is not in front while the video goes on playing.
 */
export function useHandover(h: Handover) {
  const { seq, at, playing, els, pos, said, masterRef, fadeOn, fadedIn, handReady, armed, thaw, crossOn, cross, setFrozen, setFading, place, onPlaying, onTime, tuneMusic, keyOf, startOf } = h;
  /**
   * How late a video runs after it is told to play from a moment: it is started that much ahead. Learned at every join
   * (60 to 85 ms measured). Kept in step by its speed instead, it was in step at the take-over but its frames then came
   * unevenly (one display refresh, then five) for most of a second after it, at every join (2026-10-08).
   */
  const startLag = useRef(70);
  /** When the clip after was started, and whether it was checked once since. */
  const started = useRef({ at: 0, checked: false });
  const step = useRef<() => boolean>(() => false);
  useEffect(() => {
    if (!playing) return;
    let frameId = 0;
    /** Since when this clip has been held on its last frame for the clip after (HOLD_MS); 0 while it is not. */
    let heldSince = 0;
    step.current = () => {
      const c = seq[at];
      if (!c) return true;
      const el = c.take ? els.current.get(c.take.id) : undefined;
      if (c.take && !el) return true;
      const t = performance.now();
      const local = el ? el.currentTime * 1000 - startOf(c) : pos.current.local + (t - pos.current.at);
      // a frame early rather than late: late, the clip before shows the moment the clip after opens on, and it is seen twice.
      // When the clip after runs (it was started early), the change waits until it is at its start: a video a frame or two
      // behind would show a moment again; this one has real frames past its end (the ones they share) to show meanwhile
      const following = seq[at + 1];
      const followEl = following?.take ? els.current.get(following.take.id) : undefined;
      // how far it is behind the moment this one shows (they show the same moments around the change)
      const behind = followEl && !followEl.paused && fadeOn.current ? startOf(following!) + (local - c.lengthMs) - followEl.currentTime * 1000 : 0;
      // watched on its own frames (see arm): it takes over when it shows its first one; else at the cut once in step
      const watched = armed.current;
      const inStep = !watched && local >= c.lengthMs - CUT_EARLY_MS && behind <= 12;
      // this clip has nothing more of its own to show, or is late: the change is made then, unless the clip after still runs
      // short of its start (its first frame not shown, or more than a frame behind). This one then stays on its last frame
      // until it gets there, HOLD_MS at most: a frame read off its own clock, never a margin a loaded machine can lose
      const over = Boolean(el?.ended) || local >= c.lengthMs + 100;
      const short = Boolean(followEl && fadeOn.current && !followEl.paused) && (watched ? !handReady.current : behind > 12);
      if (over && short && !heldSince) heldSince = t;
      const due = handReady.current || inStep || (over && (!short || t - heldSince >= HOLD_MS));
      if (due) {
        if (seq[at + 1]) {
          // a continuation dissolves in: this clip stops on its last frame and stays under it meanwhile
          const following = seq[at + 1]!;
          const dissolve = dissolveOf(following, c);
          // a transition that mixes both pictures: this clip stays on its last frame for its second half (the export's hold)
          if (crossingOf(following, c)?.both && el) el.pause();
          if (dissolve && el) {
            el.pause();
            window.clearTimeout(thaw.current);
            setFrozen(c);
            thaw.current = window.setTimeout(() => setFrozen(null), dissolve + 60);
            const nextVideo = following.take ? els.current.get(following.take.id) : undefined;
            // design: the dissolve is the video's own (the export draws it), so it plays with reduced motion too
            nextVideo?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dissolve, easing: "linear" });
          }
          // shown at once, before the page redraws: waiting for the redraw held this clip's last frame a frame or two longer (the
          // clip after then appeared ahead, a frame skipped). The page's own state takes over at its next redraw (see Player)
          const nextShown = following.take ? els.current.get(following.take.id) : undefined;
          if (!dissolve && nextShown) nextShown.style.opacity = "1";
          // it takes over where this one got to: the playhead runs on without a step
          place(at + 1, Math.max(0, local - c.lengthMs), true);
        } else {
          pos.current = { key: keyOf(c), local: c.lengthMs, at: t };
          onTime(c.atMs + c.lengthMs);
          onPlaying(false);
        }
        return false;
      }
      // the clip after starts running a little early, hidden and muted, so that it has frames decoded and is in
      // step at the moment it takes over (a video started cold at the cut shows black for a frame, then rushes).
      // It runs exactly where it must be to arrive at its start when this clip ends: started ahead of that, the
      // take-over had to seek it back, which stalled the picture and held the playhead at every join
      const after = seq[at + 1];
      const blend = blendOf(after, c);
      const remaining = c.lengthMs - local;
      // a cut's transition into the clip after: started when its first half begins; one that mixes both pictures holds the
      // clip after on its first frame until the cut (the export's hold), so it is not run ahead into its own frames
      const crossing = crossingOf(after, c);
      const holdFirst = Boolean(crossing?.both);
      if (crossing && after && !crossOn.current && remaining <= crossing.ms / 2 && remaining > 0) {
        crossOn.current = true;
        cross(c, after, crossing.ms, crossing.ms / 2 - remaining);
      }
      const nextEl = after?.take ? els.current.get(after.take.id) : undefined;
      // a seamless join's sound: the clip after, running hidden over its head (the same moments), is heard over this clip's last
      // moments, which its own sound leaves silent (soundHandoverOf, as the export hands it)
      const handSound = soundHandoverOf(after, c);
      const handed = handSound > 0 && Boolean(nextEl) && fadeOn.current && !nextEl!.paused && remaining <= handSound;
      if (handed && after) {
        const want = Math.max(0, Math.min(1, (after.volume / 100) * masterRef.current));
        if (Math.abs(nextEl!.volume - want) > 0.005) nextEl!.volume = want;
      }
      // the sound faded out and in over the halves, when the transition asks (its own sound, as the export fades it)
      if (el && !el.muted) {
        const into = crossingOf(c, seq[at - 1]);
        const base = Math.max(0, Math.min(1, (c.volume / 100) * masterRef.current));
        const gain = Math.min(crossing?.fadeSound ? Math.max(0, remaining) / (crossing.ms / 2) : 1, into?.fadeSound ? Math.max(0, local) / (into.ms / 2) : 1, 1);
        const want = handed ? 0 : base * gain;
        if (Math.abs(el.volume - want) > 0.005) el.volume = want;
      }
      const expected = after ? startOf(after) - remaining : 0;
      const lag = startLag.current;
      /**
       * The take-over on the clip after's own clock: the moment it puts its first frame on screen it is shown (in that very
       * frame), and the step below hands over. Decided on this clip's clock instead, the change waited for the next redraw
       * and this clip's last frame stayed up two refreshes too long, at every join (2026-10-08). Not for a fade or a dissolve.
       */
      const arm = (v: HTMLVideoElement, first: number) => {
        if (blend || dissolveOf(after, c) || !("requestVideoFrameCallback" in v)) return;
        armed.current = true;
        const watch = (_now: number, meta: { mediaTime: number }) => {
          if (!fadeOn.current || handReady.current) return;
          if (meta.mediaTime * 1000 >= first - 4) {
            v.style.opacity = "1";
            // heard from the same frame (it ran silent by its volume)
            if (after) v.volume = Math.max(0, Math.min(1, (after.volume / 100) * masterRef.current));
            handReady.current = true;
          } else v.requestVideoFrameCallback(watch);
        };
        v.requestVideoFrameCallback(watch);
      };
      if (nextEl && !fadeOn.current && remaining <= PREROLL_MS) {
        fadeOn.current = true;
        // silent by its volume, not muted: unmuted at the take-over, a playing video starts its sound and its picture stalled
        // there for two or three frames (its first frame stayed up ~45 ms, measured 2026-10-08); a volume change costs nothing
        nextEl.muted = !heardByVideo(after);
        nextEl.volume = 0;
        if (nextEl.playbackRate !== 1) nextEl.playbackRate = 1;
        // all but invisible, not invisible: a video at opacity 0 is not kept drawn, and shown it put its first frame up a display
        // refresh late at every join; at 0.4 % it is drawn and costs nothing to show (only this one: every hidden video drawn
        // made the frames come unevenly elsewhere). A fade or a dissolve brings it in itself
        if (!blend && !dissolveOf(after, c)) nextEl.style.opacity = "0.004";
        // started ahead by the delay it will lose; a clip that starts at its very first frame waits there, paused on it (and
        // one a transition holds, on its first frame shown)
        nextEl.currentTime = (holdFirst && after ? startOf(after) : Math.max(0, expected + lag)) / 1000;
        if (expected + lag >= 0 && !holdFirst) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        }
      }
      if (nextEl && fadeOn.current) {
        // one that waited on its first frame starts when it is due, as early as it will be late
        if (nextEl.paused && (holdFirst ? remaining <= lag : expected + lag >= 0 && remaining > 30)) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        } else if (!holdFirst && !nextEl.paused && !started.current.checked && t - started.current.at > 200 && expected >= 0) {
          // once, out of sight, when it has settled: how far off it runs teaches the next join. It is not set right here
          // with a seek: started PREROLL_MS before the take-over and settled 200 ms later, it is 100 ms at most from being
          // shown, and a seek that close stalls its picture at the take-over (never by its speed either)
          started.current.checked = true;
          const off = expected - nextEl.currentTime * 1000;
          startLag.current = Math.max(0, Math.min(200, lag + off * 0.7 + 4));
        }
      }
      // over its last frames, a clip that fades in over this one shows, over the moments they share
      if (nextEl && blend && !fadedIn.current && remaining <= blend) {
        fadedIn.current = true;
        setFading(Math.max(40, remaining));
      }
      // the playhead runs on: a clip that took over a few ms behind its start shows its first frames meanwhile
      if (local > -400) {
        pos.current = { key: keyOf(c), local: Math.max(0, local), at: t };
        tuneMusic(c.atMs + Math.max(0, local));
        // the screen around the video does not need every frame's time; a range's Out does: said the frame it is reached
        // (as onTime's own check, 15 ms before it), or the loop or the stop came up to 22 frames late (card #55)
        const now = c.atMs + Math.max(0, local);
        const out = h.stopAt?.() ?? null;
        if (t - said.current > 66 || (out !== null && now >= out - 15)) {
          said.current = t;
          onTime(now);
        }
      }
      return true;
    };
    const tick = () => {
      if (step.current()) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    // a picture has no video to keep time when the tab is not in front
    const slow = setInterval(() => step.current(), 250);
    return () => {
      cancelAnimationFrame(frameId);
      clearInterval(slow);
      step.current = () => false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the frame loop starts again only on what changes what plays; the rest is read through refs
  }, [playing, at, seq, place, onPlaying, onTime, tuneMusic, cross]);
  return step;
}
