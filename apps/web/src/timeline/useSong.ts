import { useEffect, useRef, type MutableRefObject } from "react";
import type { Clip } from "../api";

/**
 * Whether a clip's video is heard through its own sound: its sound "own", and not played as parts (Clip.soundParts, the song
 * under Lip sync clips from its recording, useSong). Muted for good otherwise: unmuted at a take-over, a playing video's
 * picture stalls for a few frames.
 */
export const heardByVideo = (c: Clip | undefined) => c?.sound === "own" && !c.soundParts;

/** A stretch of what is heard, on the timeline's clock: a part of a clip, a few seconds at most (as the server cuts it). */
export interface Piece {
  /** On the timeline, in ms. */
  fromMs: number;
  toMs: number;
  asset: string;
  /** Where its sound is read from, in seconds of `asset`, at `fromMs`. */
  atS: number;
  /** Its level: its part's gain and its clip's volume (0 to 1 and over), the player's own applied over all. */
  gain: number;
}

/** The longest piece fetched at once: well under what the server cuts (six seconds), a few hundred kilobytes. */
const PIECE_MS = 4000;
/** How far ahead the pieces are fetched and scheduled. */
const AHEAD_MS = 6000;
/** How soon after an anchoring the first piece starts: time for the sound card to take it. */
const START_MS = 40;
/**
 * How far the picture may stray from the sound before the sound is put back on it. Above what a cut's switch strays by (the
 * picture switches when the clip after shows its first frame: up to 42 ms early, measured 2026-10-27), so that a cut never
 * moves the song; a stalled video is caught back within a moment.
 */
const STRAY_MS = 150;
/** After a clip comes on screen, its video's clock is not read for this long: it is still settling from the switch. */
const SETTLE_MS = 400;

/**
 * What is heard of the clips as pieces on the timeline's clock: each clip's parts (Clip.soundParts) placed at its start,
 * cut to PIECE_MS. Clips with none are heard through their video, as before.
 */
export function piecesOf(seq: Clip[]): Piece[] {
  const out: Piece[] = [];
  for (const c of seq) {
    for (const p of c.soundParts ?? []) {
      const level = 10 ** (p.gainDb / 20) * (c.volume / 100);
      for (let a = p.fromMs; a < Math.min(p.toMs, c.lengthMs) - 0.5; a += PIECE_MS) {
        const b = Math.min(p.toMs, c.lengthMs, a + PIECE_MS);
        out.push({ fromMs: c.atMs + a, toMs: c.atMs + b, asset: p.asset, atS: p.atS + (a - p.fromMs) / 1000, gain: level });
      }
    }
  }
  return out;
}

/** A piece's name, the same whenever the clips are read again: what was started is not started twice. */
export const pieceKey = (p: Piece) => `${p.asset}@${p.atS.toFixed(6)}@${p.fromMs.toFixed(3)}-${p.toMs.toFixed(3)}`;

/** A piece's sound as the server cuts it (a few hundred kilobytes, kept by the browser): never a whole song decoded here. */
export const pieceUrl = (p: Pick<Piece, "asset" | "atS" | "fromMs" | "toMs">) => `/api/assets/${p.asset}/slice?from=${p.atS.toFixed(6)}&ms=${(p.toMs - p.fromMs).toFixed(3)}&v=1`;

/**
 * Which pieces to start for the sound card, the timeline standing at `nowMs`: those ending past it and starting before
 * `aheadMs`, each from where it is due (its start, or `nowMs` + START_MS when it is under way), with how far into it.
 */
export function due(pieces: Piece[], nowMs: number, aheadMs: number, started: Set<string>): Array<{ piece: Piece; atMs: number; intoMs: number }> {
  const from = nowMs + START_MS;
  return pieces
    .filter((p) => !started.has(pieceKey(p)) && p.toMs > from + 1 && p.fromMs < nowMs + aheadMs)
    .map((p) => ({ piece: p, atMs: Math.max(p.fromMs, from), intoMs: Math.max(0, from - p.fromMs) }));
}

/**
 * The song under Lip sync clips played as one track (card #131): each clip's parts (the server's timelineSong.ts) played on
 * the sound card's clock, end to end, the clips' videos muted (heardByVideo). The export lays the same parts, so both sound
 * the same: at a cut the picture switches on its own timing (up to 42 ms early) while the song runs on to the sample, where
 * the videos' own sounds skipped 56 ms of it (Timeline 6's clip 7 to 8, 2026-10-27). Anchored to the playhead at Play, a
 * seek or a loop (`seeks` counts them), and put back on the picture should it stray past STRAY_MS. Fetched a few seconds
 * ahead, a piece at a time. Music and clips without parts are left to their elements.
 */
export function useSong(o: {
  seq: Clip[];
  at: number;
  playing: boolean;
  els: MutableRefObject<Map<string, HTMLVideoElement>>;
  masterRef: MutableRefObject<number>;
  /** Where the timeline stands now (ms), read off the clip on screen. */
  where: () => number;
  /** How many seeks there have been (a seek, a loop back, a step): each puts the song back on the playhead. */
  seeks: MutableRefObject<number>;
}) {
  const { seq, at, playing, masterRef, where, seeks } = o;
  const ctx = useRef<AudioContext | null>(null);
  const master = useRef<GainNode | null>(null);
  const sounds = useRef(new Map<string, Promise<AudioBuffer | null>>());
  const seqRef = useRef(seq);
  seqRef.current = seq;
  const whereRef = useRef(where);
  whereRef.current = where;
  /** When the clip on screen came on it (performance.now()): its clock is read once it has settled. */
  const cameOn = useRef(0);
  useEffect(() => {
    cameOn.current = performance.now();
  }, [at]);

  const pieces = useRef<Piece[]>([]);
  pieces.current = piecesOf(seq);
  const any = pieces.current.length > 0;

  const fetchSound = (audio: AudioContext, url: string) => {
    let got = sounds.current.get(url);
    if (!got) {
      got = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((bytes) => audio.decodeAudioData(bytes))
        .catch(() => {
          sounds.current.delete(url);
          return null;
        });
      sounds.current.set(url, got);
      // the last forty pieces (a few minutes of song): those behind the playhead go
      while (sounds.current.size > 40) sounds.current.delete(sounds.current.keys().next().value!);
    }
    return got;
  };

  useEffect(() => {
    if (!playing || !any || typeof AudioContext === "undefined") return;
    ctx.current ??= new AudioContext();
    const audio = ctx.current;
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    if (!master.current) {
      master.current = audio.createGain();
      master.current.connect(audio.destination);
    }
    const out = master.current;
    /** The timeline's moment at the sound card's: anchored at (`t`, `c`). */
    let anchor = { t: 0, c: 0 };
    let started = new Set<string>();
    let playingNodes: AudioBufferSourceNode[] = [];
    let seen = seeks.current;
    let gen = 0;
    const stopAll = () => {
      for (const n of playingNodes) {
        try {
          n.stop();
        } catch {
          // never started, or over
        }
      }
      playingNodes = [];
      started = new Set();
      gen++;
    };
    const anchorAt = (t: number) => {
      stopAll();
      anchor = { t, c: audio.currentTime };
    };
    const songMs = () => anchor.t + (audio.currentTime - anchor.c) * 1000;
    const schedule = () => {
      const now = songMs();
      for (const { piece, atMs, intoMs } of due(pieces.current, now, AHEAD_MS, started)) {
        started.add(pieceKey(piece));
        const mine = gen;
        void fetchSound(audio, pieceUrl(piece)).then((buffer) => {
          if (!buffer || mine !== gen) return;
          // its moment on the sound card; late (a slow fetch), it starts now, that far into it
          let when = anchor.c + (atMs - anchor.t) / 1000;
          let into = intoMs / 1000;
          if (when < audio.currentTime + 0.005) {
            into += audio.currentTime + 0.005 - when;
            when = audio.currentTime + 0.005;
          }
          const length = (piece.toMs - piece.fromMs) / 1000 - into;
          if (length <= 0.001) return;
          const node = audio.createBufferSource();
          node.buffer = buffer;
          const gain = audio.createGain();
          gain.gain.value = piece.gain;
          node.connect(gain).connect(out);
          node.onended = () => {
            playingNodes = playingNodes.filter((n) => n !== node);
          };
          node.start(when, into, length);
          playingNodes.push(node);
        });
      }
    };
    anchorAt(whereRef.current());
    schedule();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      out.gain.value = Math.max(0, masterRef.current);
      if (seeks.current !== seen) {
        seen = seeks.current;
        anchorAt(whereRef.current());
      } else if (performance.now() - cameOn.current > SETTLE_MS && Math.abs(whereRef.current() - songMs()) > STRAY_MS) {
        anchorAt(whereRef.current());
      }
      schedule();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pieces and the playhead are read through refs as it plays
  }, [playing, any]);

  useEffect(() => () => {
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
    master.current = null;
  }, []);
}
