import { describe, expect, it } from "vitest";
import { cents, dayStart, diskPerHour, fetchTime, GB, monthStart, runCost, usd, usdFor, VOLUME_MAX_GB, VOLUME_MIN_GB, volumeSizeFor } from "../src";

const HOUR = 3_600_000;

describe("money, one copy for the server and the web", () => {
  it("says dollars with their cents under $100, as the tab and the notices both say them", () => {
    // the server's notices said "$12.5" where the tab said "$12.50"
    expect(usd(12.5)).toBe("$12.50");
    expect(usd(0.69)).toBe("$0.69");
    expect(usd(99.994)).toBe("$99.99");
    expect(usd(140.6)).toBe("$141");
    expect(usd(0.0123, true)).toBe("$0.012");
    expect(usd(1.5, true)).toBe("$1.50");
  });

  it("prices a time at a rate, and a run over a window", () => {
    expect(usdFor(30 * 60_000, 0.6)).toBeCloseTo(0.3, 9);
    // 10:00 to 12:00 at $0.60/h, counted from 11:00: one hour
    expect(runCost(10 * HOUR, 12 * HOUR, 0.6, 11 * HOUR)).toBeCloseTo(0.6, 9);
    expect(runCost(10 * HOUR, 12 * HOUR, 0.6, 10.5 * HOUR, 11 * HOUR)).toBeCloseTo(0.3, 9);
    expect(runCost(10 * HOUR, 12 * HOUR, 0.6, 13 * HOUR)).toBe(0);
    expect(runCost(Number.NaN, 12 * HOUR, 0.6, 0)).toBe(0);
    expect(cents(2.345678)).toBe(2.35);
  });

  it("starts a day and a month at the user's midnight", () => {
    const at = new Date(2026, 10, 3, 15, 42, 7).getTime();
    expect(dayStart(at)).toBe(new Date(2026, 10, 3).getTime());
    expect(monthStart(at)).toBe(new Date(2026, 10, 1).getTime());
    expect(monthStart(at, 1)).toBe(new Date(2026, 11, 1).getTime());
    expect(monthStart(new Date(2026, 11, 31, 23, 59).getTime(), 1)).toBe(new Date(2027, 0, 1).getTime());
  });

  it("sizes a volume in GB of 2^30, a quarter more, within RunPod's sizes", () => {
    // Costs sized 26e9 bytes at a tenth more in GB of 10^9 (30 GB): smaller than Make a volume… planned (40)
    expect(volumeSizeFor(26e9)).toBe(40);
    expect(volumeSizeFor(8 * GB)).toBe(VOLUME_MIN_GB);
    expect(volumeSizeFor(0)).toBe(VOLUME_MIN_GB);
    expect(volumeSizeFor(10_000 * GB)).toBe(VOLUME_MAX_GB);
    expect(diskPerHour(120)).toBeCloseTo((120 * 0.1) / 730, 9);
  });

  it("times a pod's files at each source's speeds, saying where a guess is in it", () => {
    const speeds = { hf: { low: 50, high: 100 }, civitai: { low: 10, high: 20, guessed: true }, url: null };
    expect(fetchTime([{ bytes: 1000, kind: "hf" as const }], speeds)).toEqual({ fastMs: 10_000, slowMs: 20_000, guessed: false });
    expect(fetchTime([{ bytes: 1000, kind: "hf" as const }, { bytes: 200, kind: "civitai" as const }, { bytes: null, kind: "url" as const }], speeds))
      .toEqual({ fastMs: 20_000, slowMs: 40_000, guessed: true });
    // a source with no range at all (and a size known): not timed
    expect(fetchTime([{ bytes: 5, kind: "url" as const }], speeds)).toBeNull();
  });
});
