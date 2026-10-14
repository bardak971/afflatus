import { describe, expect, it } from "vitest";
import { volumePerMonth } from "../src/volumePrice";

describe("what a network volume costs a month", () => {
  it("$0.07 a GB for its first TB, $0.05 past it", () => {
    expect(volumePerMonth(100)).toBeCloseTo(7);
    expect(volumePerMonth(1000)).toBeCloseTo(70);
    expect(volumePerMonth(2000)).toBeCloseTo(120);
    expect(volumePerMonth(0)).toBe(0);
  });
});
