import { useEffect, useRef, type MutableRefObject } from "react";
import type { Clip } from "../api";

type Fill = NonNullable<Clip["soundFill"]>;

/** How far ahead a fill is scheduled: near enough that the video's clock and the sound card's have not drifted apart. */
const AHEAD_S = 0.25;

/**
 * When a clip's fill (Clip.soundFill) is to start, in seconds from now, its video standing at `videoMs` (its own time):
 * null when it is further off than AHEAD_S, or already past its start (a seek into it: the next play of it fills it).
 */
export function fillStartsIn(fill: Fill, videoMs: number): number | null {
  const s = (fill.fromMs - videoMs) / 1000;
  return s >= 0 && s <= AHEAD_S ? s : null;
}

/** How loud a fill plays: its gain to the take's level, the clip's volume, the player's. */
export const fillGain = (fill: Fill, volume: number, master: number) => Math.max(0, 10 ** (fill.gainDb / 20) * (volume / 100) * master);

/** The moment of its recording a fill plays, as the server cuts it (a few kilobytes): never the whole song decoded here. */
export const fillUrl = (fill: Fill) => `/api/assets/${fill.asset}/slice?from=${fill.songS.toFixed(6)}&ms=${fill.ms.toFixed(3)}&v=1`;

/**
 * The end of a take whose own sound stops short of its frames before a cut, filled from its recording as the export lays it
 * (the server's timelineSoundFill.ts): 30 ms of silence in the middle of a sung line on Timeline 6's clip 7 (2026-10-27).
 * Each fill's moment of the recording is fetched and decoded once, and played on the sound card's clock at the moment the
 * video will reach it: an element started then would take about as long to start as the gap lasts. Within about a frame
 * of the video (its clock is read once per screen frame); stopped by a pause, a seek away, or a step back before it. The
 * clips' own sound, the hand-overs of joins that carry on (never filled) and the music are left as they are.
 */
export function useSoundFill(o: { seq: Clip[]; at: number; playing: boolean; els: MutableRefObject<Map<string, HTMLVideoElement>>; masterRef: MutableRefObject<number> }) {
  const { seq, at, playing, els, masterRef } = o;
  const ctx = useRef<AudioContext | null>(null);
  /** Each fill's sound, decoded, by its slice's address. */
  const sounds = useRef(new Map<string, Promise<AudioBuffer | null>>());
  /** The fill scheduled, by its take (stopped on a pause or a seek; let go once it has played). */
  const queued = useRef<{ take: string; node: AudioBufferSourceNode } | null>(null);
  const seqRef = useRef(seq);
  seqRef.current = seq;
  const atRef = useRef(at);
  atRef.current = at;

  const urls = [...new Set(seq.flatMap((c) => (c.soundFill ? [fillUrl(c.soundFill)] : [])))].sort().join(" ");
  // each fill's sound fetched and decoded while it plays (the sound card made on the first play: a page may make sound after a click only)
  useEffect(() => {
    if (!playing || !urls || typeof AudioContext === "undefined") return;
    ctx.current ??= new AudioContext();
    const audio = ctx.current;
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    for (const url of urls.split(" ")) {
      if (sounds.current.has(url)) continue;
      const decoding = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((bytes) => audio.decodeAudioData(bytes))
        .catch(() => {
          // not kept: asked again at the next play
          sounds.current.delete(url);
          return null;
        });
      sounds.current.set(url, decoding);
    }
  }, [playing, urls]);

  useEffect(() => {
    const stop = () => {
      try {
        queued.current?.node.stop();
      } catch {
        // never started, or over
      }
      queued.current = null;
    };
    if (!playing) {
      stop();
      return;
    }
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const audio = ctx.current;
      const c = seqRef.current[atRef.current];
      const q = queued.current;
      if (q) {
        // its clip left the screen other than onward (a seek, a clip before), or its video was put back well before the fill
        const onIt = c?.take?.id === q.take;
        const el = els.current.get(q.take);
        if (!onIt && seqRef.current[atRef.current - 1]?.take?.id !== q.take) stop();
        else if (onIt && c.soundFill && el && el.currentTime * 1000 < c.soundFill.fromMs - AHEAD_S * 1000 - 50) stop();
        return;
      }
      const fill = c?.soundFill;
      if (!audio || !c?.take || !fill || c.sound !== "own") return;
      const el = els.current.get(c.take.id);
      if (!el || el.paused || fillStartsIn(fill, el.currentTime * 1000) === null) return;
      const take = c.take.id;
      const sound = sounds.current.get(fillUrl(fill));
      if (!sound) return;
      // held while its sound is got ready, so that one fill is scheduled once
      const holding = { take, node: audio.createBufferSource() };
      queued.current = holding;
      void sound.then((buffer) => {
        if (queued.current !== holding) return;
        // read again now that the sound is ready: the video went on meanwhile
        const inS = buffer && seqRef.current[atRef.current]?.take?.id === take ? fillStartsIn(fill, el.currentTime * 1000) : null;
        if (inS === null) {
          queued.current = null;
          return;
        }
        const node = holding.node;
        node.buffer = buffer;
        const gain = audio.createGain();
        gain.gain.value = fillGain(fill, c.volume, masterRef.current);
        node.connect(gain).connect(audio.destination);
        node.onended = () => {
          if (queued.current?.node === node) queued.current = null;
        };
        node.start(audio.currentTime + inS, 0, fill.ms / 1000);
      });
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the loop reads the clips and the clip on screen through refs
  }, [playing]);

  useEffect(() => () => {
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
  }, []);
}
