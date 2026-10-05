import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The seed value that means a new seed for every render. */
export const RANDOM_SEED = -1;
/** How a typed seed moves from one render to the next: kept, one up, or one down. One setting for every form. */
export type SeedMode = "fixed" | "up" | "down";
export const useSeedMode = create<{ mode: SeedMode; set(mode: SeedMode): void }>()(
  persist((set) => ({ mode: "fixed", set: (mode) => set({ mode }) }), { name: "afflatus.seed-mode" }),
);
const RANGE = 4294967296;
/** The seed a form shows after `count` renders went out from `seed`: moved by the mode, within the model's range. */
export const seedAfter = (seed: number, mode: SeedMode, count: number): number =>
  mode === "fixed" ? seed : (((seed + (mode === "up" ? count : -count)) % RANGE) + RANGE) % RANGE;
/** The mode a render goes out with: only when a seed is typed and it is meant to move. */
export const movingSeed = (seed: unknown, mode: SeedMode): "up" | "down" | undefined =>
  typeof seed === "number" && seed !== RANDOM_SEED && mode !== "fixed" ? mode : undefined;
