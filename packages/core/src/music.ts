/**
 * The music under a timeline, as one plan: where in the video it starts (with a clip), which part of the song plays
 * (from `fromMs` of it), and what each clip asks of the music under it (its own level, ducking, fades, muted). The
 * same sums in the browser (the player's music volume follows them) and on the server (the export multiplies the music
 * by them), so that the two agree.
 */

/** What a clip asks of the music under it; a field left out is as the rest of the video. */
export interface ClipMusic {
  /** Its level there, 0 to 150 % of the music's own volume. */
  volume?: number;
  /** Ducking under speech there: none, or deeper than the rest. */
  duck?: "off" | "strong";
  /** Faded in at the clip's start, out at its end (CLIP_FADE_MS). */
  fadeIn?: boolean;
  fadeOut?: boolean;
  muted?: boolean;
}

/** The music's own settings, for the whole video. */
export interface MusicBase {
  /** 0 to 100. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  duck: boolean;
  duckDb: number;
  /** Where in the song it plays from. */
  fromMs: number;
  /** The song's length; 0 when unknown (taken as long enough). */
  durationMs: number;
  /** The clip it starts with; null (or a clip no longer there): with the first one. */
  startClip: string | null;
}

/** A clip as the plan sees it: where it plays on the timeline's clock. */
export interface MusicClip {
  id: string;
  atMs: number;
  lengthMs: number;
  music: ClipMusic | null;
}

/** The music under one clip: its level (1 = the music's own), how deep it ducks (0: not at all), its own fades. */
export interface MusicSpan {
  clip: string;
  atMs: number;
  lengthMs: number;
  level: number;
  duckDb: number;
  fadeIn: boolean;
  fadeOut: boolean;
  muted: boolean;
}

export interface MusicPlan {
  /** Where on the timeline's clock it starts and stops (the video's end, or the song's): nothing plays outside. */
  startMs: number;
  endMs: number;
  /** The moment of the song heard at `startMs`. */
  fromMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  spans: MusicSpan[];
}

/** How long a level change at a clip boundary takes (centred on it): no click, no audible slide. */
export const MUSIC_RAMP_MS = 50;
/** A clip's own fade in or out of the music. */
export const CLIP_FADE_MS = 500;
/** The most a clip can raise the music, in %. */
export const CLIP_MUSIC_MOST = 150;
/** "Strong" ducking: this much deeper than the music's own. */
export const strongDuckDb = (db: number) => Math.min(40, db + 10);

/** A clip's music settings as stored and sent: only what differs from the rest; null when nothing does. */
export function clipMusicOf(raw: unknown): ClipMusic | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ClipMusic = {};
  // 100 % is the music's own level: as the rest
  const volume = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.max(0, Math.min(CLIP_MUSIC_MOST, Math.round(r.volume))) : 100;
  if (volume !== 100) out.volume = volume;
  if (r.duck === "off" || r.duck === "strong") out.duck = r.duck;
  if (r.fadeIn === true) out.fadeIn = true;
  if (r.fadeOut === true) out.fadeOut = true;
  if (r.muted === true) out.muted = true;
  return Object.keys(out).length ? out : null;
}

/** The plan for a timeline: `clips` in play order, the ones with nothing to play (no length) included or not. */
export function musicPlan(base: MusicBase, clips: MusicClip[]): MusicPlan {
  const playing = clips.filter((c) => c.lengthMs > 0);
  const total = playing.length ? playing.at(-1)!.atMs + playing.at(-1)!.lengthMs : 0;
  const start = (base.startClip && clips.find((c) => c.id === base.startClip)?.atMs) || 0;
  const startMs = Math.min(total, start);
  const songLeft = base.durationMs > 0 ? Math.max(0, base.durationMs - base.fromMs) : Infinity;
  const endMs = Math.max(startMs, Math.min(total, startMs + songLeft));
  const spans: MusicSpan[] = [];
  for (const c of playing) {
    const a = Math.max(c.atMs, startMs);
    const b = Math.min(c.atMs + c.lengthMs, endMs);
    if (b <= a) continue;
    const m = c.music ?? {};
    const duckDb = m.duck === "off" ? 0 : m.duck === "strong" ? strongDuckDb(base.duckDb) : base.duck ? base.duckDb : 0;
    spans.push({ clip: c.id, atMs: a, lengthMs: b - a, level: (m.volume ?? 100) / 100, duckDb, fadeIn: Boolean(m.fadeIn), fadeOut: Boolean(m.fadeOut), muted: Boolean(m.muted) });
  }
  return { startMs, endMs, fromMs: base.fromMs, volume: base.volume, fadeInMs: base.fadeInMs, fadeOutMs: base.fadeOutMs, spans };
}

/** How far into the song it can start: its end less the video under the music (0 when the song is shorter, or of unknown length). */
export function mostFromMs(base: Pick<MusicBase, "durationMs" | "startClip">, clips: MusicClip[]): number {
  if (!base.durationMs) return 0;
  const total = clips.reduce((sum, c) => sum + Math.max(0, c.lengthMs), 0);
  const start = (base.startClip && clips.find((c) => c.id === base.startClip)?.atMs) || 0;
  return Math.max(0, base.durationMs - (total - Math.min(total, start)));
}

/** The span playing at a moment of the timeline. */
export function spanAt(plan: MusicPlan, ms: number): MusicSpan | undefined {
  return plan.spans.find((s) => ms >= s.atMs && ms < s.atMs + s.lengthMs);
}

/** A span's own level at a moment of it: muted, its volume, its fades. */
function spanLevel(s: MusicSpan, ms: number): number {
  if (s.muted) return 0;
  const fade = Math.min(CLIP_FADE_MS, s.lengthMs / 2);
  const inn = s.fadeIn && fade > 0 ? Math.min(1, Math.max(0, (ms - s.atMs) / fade)) : 1;
  const out = s.fadeOut && fade > 0 ? Math.min(1, Math.max(0, (s.atMs + s.lengthMs - ms) / fade)) : 1;
  return s.level * inn * out;
}

/**
 * How loud the music is at a moment of the timeline, before ducking: its volume, its own fades from where it starts to
 * where it stops, and the clip's level there; a change at a clip boundary ramps over MUSIC_RAMP_MS. 0 to 1.5.
 */
export function musicLevel(plan: MusicPlan, ms: number): number {
  if (ms < plan.startMs || ms >= plan.endMs) return 0;
  const inn = plan.fadeInMs > 0 ? Math.min(1, (ms - plan.startMs) / plan.fadeInMs) : 1;
  const out = plan.fadeOutMs > 0 ? Math.min(1, (plan.endMs - ms) / plan.fadeOutMs) : 1;
  const whole = (plan.volume / 100) * inn * out;
  const i = plan.spans.findIndex((s) => ms < s.atMs + s.lengthMs);
  const s = plan.spans[i];
  if (!s) return 0;
  const half = MUSIC_RAMP_MS / 2;
  // near a boundary with the clip before or after: from the one's level to the other's
  const prev = plan.spans[i - 1];
  const next = plan.spans[i + 1];
  const edge = prev && ms - s.atMs < half ? { a: prev, b: s, at: s.atMs } : next && s.atMs + s.lengthMs - ms <= half ? { a: s, b: next, at: next.atMs } : null;
  if (edge) {
    const from = spanLevel(edge.a, edge.at - half);
    const to = spanLevel(edge.b, edge.at + half);
    return whole * (from + ((to - from) * (ms - (edge.at - half))) / MUSIC_RAMP_MS);
  }
  return whole * spanLevel(s, ms);
}

/** The moment of the song heard at a moment of the timeline. */
export const songAt = (plan: MusicPlan, ms: number) => plan.fromMs + ms - plan.startMs;

/** How deep the music ducks at a moment of the timeline, in dB: 0 where it does not. */
export const duckDbAt = (plan: MusicPlan, ms: number) => spanAt(plan, ms)?.duckDb ?? 0;

/** A ducking curve's gain at a moment (eased between its points): the player and the export read it alike. */
export function curveAt(curve: { rate: number; gains: number[] } | null, ms: number): number {
  if (!curve?.gains.length) return 1;
  const at = Math.max(0, (ms / 1000) * curve.rate);
  const k = Math.min(curve.gains.length - 1, Math.floor(at));
  const a = curve.gains[k] ?? 1;
  const b = curve.gains[Math.min(curve.gains.length - 1, k + 1)] ?? a;
  return a + (b - a) * (at - k);
}

/** The music's gain at a moment of the timeline: its level times its ducking. What the player sets, what the export multiplies by. */
export const musicGainAt = (plan: MusicPlan, curve: { rate: number; gains: number[] } | null, ms: number) => musicLevel(plan, ms) * curveAt(curve, ms);

/** Something differs under this clip from the rest. */
export const ownMusic = (m: ClipMusic | null | undefined): m is ClipMusic => Boolean(m && clipMusicOf(m));
