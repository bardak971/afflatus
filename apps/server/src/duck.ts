import { duckDbAt, type MusicPlan } from "@afflatus/core";
import { eachAtMost } from "./measures-api";
import { visible, type AssetRow, type Laid } from "./timelineModel";

/**
 * The music ducked under speech: one gain curve for a timeline, worked out on the server from where people speak in each
 * clip's own sound, and used alike by the player (the music's volume follows it) and the export (the music is multiplied by
 * it). Speech is told by its band: a clip's sound filtered to 300–3400 Hz (measureOf's `speech`). Measured 2026-10-08:
 * a voice reads -11 to -27 dB there, restaurant chatter -41 to -47, wind -51 to -62; over the whole band the wind was
 * loud enough (-28 to -37) to hold the music down all along, which a sidechain on the whole sound did.
 */

/** Gains a second in the curve. */
export const DUCK_RATE = 20;
/** Speech-band level over which a clip is taken to speak, in dB (its volume taken into account). */
const SPEECH_DB = -32;
/** How long the music stays down after the last word, how fast it goes down, how slowly it comes back (ms). */
const HOLD_MS = 300;
const ATTACK_MS = 80;
const RELEASE_MS = 500;

export interface DuckCurve { rate: number; gains: number[] }

/** A sound's speech-band levels, in dB, `rate` a second (null: it has no sound). `row`: its asset's row, when read already. */
export type SpeechOf = (assetId: string, row?: AssetRow) => Promise<{ rate: number; speech: number[] | null }>;

/** How many sounds' levels are read side by side: each a kept file, or, measured the first time, one ffmpeg. */
const SPEECH_AT_ONCE = 4;

/**
 * Where speech is heard along the timeline, then the music's gain there: down by `depth` dB under speech, eased in and
 * out. With a music plan, each clip's own depth (none, the music's, strong).
 */
export async function duckCurve(laid: Laid[], speechOf: SpeechOf, depth: number | MusicPlan): Promise<DuckCurve> {
  const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
  const n = Math.ceil((total / 1000) * DUCK_RATE);
  const talking = new Array<boolean>(n).fill(false);
  // what is heard: the clip's own sound from where it is seen, or the sound file put on it, from its start
  const heard = laid.flatMap((l) => {
    const p = l.p;
    if (p.clip.kind !== "video" || p.clip.sound === "muted" || p.clip.volume <= 0) return [];
    const own = p.clip.sound !== "file";
    const asset = own ? p.active?.asset : p.sound;
    return asset ? [{ l, asset, from: own && p.active ? visible(p.active).start : 0 }] : [];
  });
  // the sounds read a few at a time, with the rows the timeline was read with: one after the other, each reading its row
  // again, a 150-clip timeline took 141 statements and 43 ms
  const rows = new Map(heard.map((h) => [h.asset.id, h.asset]));
  const levels = await eachAtMost([...rows.keys()], SPEECH_AT_ONCE, (id) => speechOf(id, rows.get(id)));
  for (const { l, asset, from } of heard) {
    const p = l.p;
    const s = levels[asset.id];
    if (!s?.speech?.length) continue;
    const gainDb = 20 * Math.log10(p.clip.volume / 100);
    const first = Math.floor((l.atMs / 1000) * DUCK_RATE);
    const last = Math.min(n, Math.ceil(((l.atMs + l.lengthMs) / 1000) * DUCK_RATE));
    for (let k = first; k < last; k++) {
      const at = from + (k * 1000) / DUCK_RATE - l.atMs;
      const v = s.speech[Math.floor((at / 1000) * s.rate)];
      if (v !== undefined && v + gainDb > SPEECH_DB) talking[k] = true;
    }
  }
  const depths = typeof depth === "number" ? depth : talking.map((_, k) => duckDbAt(depth, (k * 1000) / DUCK_RATE));
  return { rate: DUCK_RATE, gains: eased(talking, depths) };
}

/** Down by `depthDb` while talking (held a little after), eased: quick down, slow up. A list: a depth per point. Exported for the tests. */
export function eased(talking: boolean[], depthDb: number | number[]): number[] {
  const lowOf = (db: number) => 10 ** (-Math.max(0, db) / 20);
  const low = typeof depthDb === "number" ? lowOf(depthDb) : 1;
  const step = 1000 / DUCK_RATE;
  const hold = Math.round(HOLD_MS / step);
  const down = 1 - Math.exp(-step / ATTACK_MS);
  const up = 1 - Math.exp(-step / RELEASE_MS);
  let since = Infinity;
  let g = 1;
  return talking.map((t, k) => {
    since = t ? 0 : since + 1;
    const target = since <= hold ? (typeof depthDb === "number" ? low : lowOf(depthDb[k] ?? 0)) : 1;
    g += (target - g) * (target < g ? down : up);
    return Math.round(g * 1000) / 1000;
  });
}

/** A gain along the timeline (the music plan's level times its ducking) as a mono 32-bit float WAV at `rate` Hz. */
export function gainWav(gainAt: (ms: number) => number, totalMs: number, rate = 8000): Uint8Array {
  const samples = Math.max(1, Math.ceil((totalMs / 1000) * rate));
  const data = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) data.writeFloatLE(gainAt((i * 1000) / rate), i * 4);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(32, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([head, data]));
}
