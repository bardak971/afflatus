import { RANDOM_SEED } from "./inputs";

/** How many seeds a model takes: 0 to 2³² − 1. */
export const SEED_RANGE = 4294967296;

/** A typed seed that moves from one render to the next: one up, or one down. */
export type SeedMove = "up" | "down";

/** The seed typed in a form, or null when the form draws a new one for every render. */
export const typedSeed = (seed: unknown): number | null => (typeof seed === "number" && seed !== RANDOM_SEED && seed >= 0 ? seed : null);

/** The seed `steps` renders after `seed`, moved up or down, within the model's range (wrapping round at either end). */
export const movedSeed = (seed: number, move: SeedMove, steps: number): number =>
  (((seed + (move === "up" ? steps : -steps)) % SEED_RANGE) + SEED_RANGE) % SEED_RANGE;
