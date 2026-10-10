import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { FRAME_SLACK_MS, joinFade, MIN_FADE_MS } from "@afflatus/core";
import type { Clip } from "../api";

/** How long before a clip ends the clip after starts running hidden, so that it takes over with frames ready and in step. */
export const PREROLL_MS = 800;
/** How early the cut to the clip after is made: a video frame at 48 a second plus the animation frame the check may be late by. */
const CUT_EARLY_MS = 24;

/**
 * How the clip after fades in over `from` as the player hands over, the same as the export (joinFade in @afflatus/core):
 * landed on, over the moments both show ("overlap", `blend` here); a continuation of a video, over `from` held on its last
 * frame ("hold", a dissolve here). Within both clips' lengths; null when there is no fade.
 */
export function fadeIn(c: Clip | undefined, from: Clip | undefined): { ms: number; mode: "hold" | "overlap" } | null {
  if (!c?.take || !from) return null;
  const f = joinFade({ landedMs: c.take.landedMs, joined: c.joined === "continue" && Boolean(from.take), seamless: Boolean(c.take.seamless), sharedMs: c.take.headMs - c.take.trimStartMs });
  if (!f) return null;
  const ms = Math.min(f.ms, c.lengthMs - FRAME_SLACK_MS, ...(f.mode === "overlap" ? [from.lengthMs - FRAME_SLACK_MS] : []));
  return ms >= MIN_FADE_MS ? { ms, mode: f.mode } : null;
}
/** Over the moments both show: the take landed on. */
export const blendOf = (c: Clip | undefined, from: Clip | undefined) => (fadeIn(c, from)?.mode === "overlap" ? fadeIn(c, from)!.ms : 0);
/** Dissolved in over the clip before held on its last frame: a continuation (DISSOLVE_MS: longer doubled a moving subject). */
export const dissolveOf = (c: Clip | undefined, from: Clip | undefined) => (fadeIn(c, from)?.mode === "hold" ? fadeIn(c, from)!.ms : 0);

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
  setFrozen: Dispatch<SetStateAction<Clip | null>>;
  setFading: Dispatch<SetStateAction<number>>;
  place(index: number, local: number, onward?: boolean): void;
  onPlaying(playing: boolean): void;
  onTime(ms: number): void;
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
  const { seq, at, playing, els, pos, said, masterRef, fadeOn, fadedIn, handReady, armed, thaw, setFrozen, setFading, place, onPlaying, onTime, tuneMusic, keyOf, startOf } = h;
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
      // watched on its own frames (see arm): it takes over when it shows its first one, or late at the latest; else as before
      const watched = armed.current;
      const due = handReady.current || (watched ? local >= c.lengthMs + 100 : local >= c.lengthMs - CUT_EARLY_MS && (behind <= 12 || local >= c.lengthMs + 100));
      if (due || el?.ended) {
        if (seq[at + 1]) {
          // a continuation dissolves in: this clip stops on its last frame and stays under it meanwhile
          const following = seq[at + 1]!;
          const dissolve = dissolveOf(following, c);
          if (dissolve && el) {
            el.pause();
            window.clearTimeout(thaw.current);
            setFrozen(c);
            thaw.current = window.setTimeout(() => setFrozen(null), dissolve + 60);
            const nextVideo = following.take ? els.current.get(following.take.id) : undefined;
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
      const nextEl = after?.take ? els.current.get(after.take.id) : undefined;
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
        nextEl.muted = after?.sound !== "own";
        nextEl.volume = 0;
        if (nextEl.playbackRate !== 1) nextEl.playbackRate = 1;
        // all but invisible, not invisible: a video at opacity 0 is not kept drawn, and shown it put its first frame up a display
        // refresh late at every join; at 0.4 % it is drawn and costs nothing to show (only this one: every hidden video drawn
        // made the frames come unevenly elsewhere). A fade or a dissolve brings it in itself
        if (!blend && !dissolveOf(after, c)) nextEl.style.opacity = "0.004";
        // started ahead by the delay it will lose; a clip that starts at its very first frame waits there, paused on it
        nextEl.currentTime = Math.max(0, expected + lag) / 1000;
        if (expected + lag >= 0) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        }
      }
      if (nextEl && fadeOn.current) {
        // one that waited on its first frame starts when it is due, as early as it will be late
        if (nextEl.paused && expected + lag >= 0 && remaining > 30) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        } else if (!nextEl.paused && !started.current.checked && t - started.current.at > 200 && expected >= 0) {
          // once, out of sight, when it has settled: how far off it runs teaches the next join, and a stray start is set right
          // with one seek here (never near the take-over, never by its speed)
          started.current.checked = true;
          const off = expected - nextEl.currentTime * 1000;
          startLag.current = Math.max(0, Math.min(200, lag + off * 0.7 + 4));
          if (Math.abs(off) > 20 && remaining > 300) nextEl.currentTime = (expected + startLag.current) / 1000;
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
        // the screen around the video does not need every frame's time
        if (t - said.current > 66) {
          said.current = t;
          onTime(c.atMs + Math.max(0, local));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, at, seq, place, onPlaying, onTime, tuneMusic]);
  return step;
}
