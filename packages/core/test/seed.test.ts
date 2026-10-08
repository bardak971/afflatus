import { describe, expect, it } from "vitest";
import { movedSeed, RANDOM_SEED, SEED_RANGE, typedSeed } from "../src";

describe("a typed seed", () => {
  it("is a number from 0 up; random, or anything else, is none", () => {
    expect(typedSeed(42)).toBe(42);
    expect(typedSeed(0)).toBe(0);
    expect(typedSeed(RANDOM_SEED)).toBeNull();
    expect(typedSeed("42")).toBeNull();
    expect(typedSeed(undefined)).toBeNull();
  });
  it("moves up or down by the renders sent, wrapping round at either end of the model's range", () => {
    expect(movedSeed(10, "up", 3)).toBe(13);
    expect(movedSeed(10, "down", 3)).toBe(7);
    expect(movedSeed(SEED_RANGE - 1, "up", 2)).toBe(1);
    expect(movedSeed(1, "down", 2)).toBe(SEED_RANGE - 1);
    expect(movedSeed(5, "up", 0)).toBe(5);
  });
});
