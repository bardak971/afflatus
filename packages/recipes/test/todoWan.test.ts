import { describe, expect, it } from "vitest";
import { wanHandover } from "../src/wan/video";

describe("Wan's high-to-low handover", () => {
  it("lands where the template's half does at the defaults", () => {
    // 20 steps at shift 8 (full steps) and 4 at shift 5 (Turbo): the steps where the noise falls below 0.9
    expect(wanHandover(20, 8, "simple", false, 0)).toBe(10);
    expect(wanHandover(4, 5, "simple", false, 0)).toBe(2);
  });
  it("follows a changed shift or step count, which a fixed half does not", () => {
    expect(wanHandover(6, 5, "simple", false, 0)).toBe(3);
    expect(wanHandover(30, 12, "simple", false, 0)).toBe(18);
  });
  it("hands over a little later from words alone, whose models were split at 0.875", () => {
    expect(wanHandover(30, 12, "simple", true, 0)).toBeGreaterThanOrEqual(wanHandover(30, 12, "simple", false, 0));
  });
  it("takes a share typed in as it is, and half on a scheduler it cannot work out", () => {
    expect(wanHandover(20, 8, "simple", false, 0.4)).toBe(8);
    expect(wanHandover(20, 8, "karras", false, 0)).toBe(10);
    expect(wanHandover(2, 8, "simple", false, 0)).toBe(1);
  });
});
