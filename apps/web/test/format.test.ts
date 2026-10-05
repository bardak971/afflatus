import { describe, expect, it } from "vitest";
import { clock } from "../src/format";

describe("minutes and seconds", () => {
  it("rounds a length to the second", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(4600)).toBe("0:05");
    expect(clock(72_000)).toBe("1:12");
  });
  it("floors a moment, so that a frame never reads as the next second", () => {
    expect(clock(4990, { decimals: 1 })).toBe("0:04.9");
    expect(clock(4990, { decimals: 2 })).toBe("0:04.99");
    expect(clock(3300, { decimals: 1 })).toBe("0:03.3");
    expect(clock(4200, { decimals: 2 })).toBe("0:04.20");
  });
  it("never goes below zero", () => {
    expect(clock(-500, { decimals: 1 })).toBe("0:00.0");
  });
});
