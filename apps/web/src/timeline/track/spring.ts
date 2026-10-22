/**
 * A critically damped spring on one number (the apple-design skill, §4 and §5): it reaches its target without overshoot,
 * from wherever it is and at whatever speed it already has, so a new target mid-way (another slot, Esc) carries on from
 * the motion under way rather than starting again. The clip drag on the track is its one user (review 4, P7); the mock's
 * reference feel was a response of 0.3 s, which the owner validated.
 */
export type Spring = {
  /** Where it is now, and its speed (px and px per second). */
  x: number;
  v: number;
  /** Where it goes. */
  to: number;
};

/** How quickly it reaches its target, in seconds (not a duration: a spring has none). */
export const RESPONSE_S = 0.3;

/** Closer than this, and slower, it is where it goes: the last fraction of a pixel is not drawn for a second more. */
const NEAR_PX = 0.25;
const SLOW_PX_S = 4;

/**
 * The spring moved on by `dt` seconds, in place; true once it rests on its target. The exact solution of a damping ratio
 * of 1 (x'' = -ω²(x - to) - 2ω x') rather than a step of it, so that a long frame (a tab in the background) never makes it
 * overshoot or blow up.
 */
export function stepSpring(s: Spring, dt: number, response = RESPONSE_S): boolean {
  const w = (2 * Math.PI) / response;
  const d = s.x - s.to;
  const c = s.v + w * d;
  const decay = Math.exp(-w * dt);
  s.x = s.to + (d + c * dt) * decay;
  s.v = (c - w * (d + c * dt)) * decay;
  if (Math.abs(s.x - s.to) < NEAR_PX && Math.abs(s.v) < SLOW_PX_S) {
    s.x = s.to;
    s.v = 0;
    return true;
  }
  return false;
}

/** A pointer's moments while it drags: where it was and when. */
export type Trail = Array<{ x: number; t: number }>;

/** How far back the release speed is read: the last few moves, not the whole drag (a pause before letting go is no throw). */
const TRAIL_MS = 100;

/** A move added to the trail, the moves older than the speed reads let go. */
export function follow(trail: Trail, x: number, t: number) {
  trail.push({ x, t });
  while (trail.length > 2 && t - trail[0]!.t > TRAIL_MS) trail.shift();
}

/** The pointer's speed when it lets go, in px per second (0 when it had stopped). */
export function releaseSpeed(trail: Trail, now: number): number {
  const last = trail.at(-1);
  const first = trail[0];
  if (!last || !first || last === first || now - last.t > TRAIL_MS) return 0;
  return ((last.x - first.x) / Math.max(1, last.t - first.t)) * 1000;
}

/**
 * Past a bound, the further it goes the less it follows (§9): a clip pulled before the track's start resists rather than
 * stopping dead. `over` is how far past it the pointer asks, `size` the thing's own size.
 */
export const rubberband = (over: number, size: number, k = 0.55) => (over * size * k) / (size + k * Math.abs(over));
