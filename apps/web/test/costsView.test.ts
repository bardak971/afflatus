import { describe, expect, it } from "vitest";
import type { PodSession } from "../src/api";
import { nothingShare, presetWindow, runwaySaid, sessionBits, totalsSaid } from "../src/screens/queue/costsView";

/** What the Costs tab works out from the server's figures before drawing them (costsView.ts). */

const MIN = 60_000;

describe("the Costs tab", () => {
  it("its windows: a preset ending now, the month from its 1st, all of it unbounded", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    expect(presetWindow("24H", now)).toEqual({ from: now - 86_400_000, to: now });
    expect(presetWindow("Month", now)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: now });
    expect(presetWindow("All", now)).toBeNull();
  });

  it("what made nothing: all but the renders that finished", () => {
    expect(nothingShare({ render: 0.45, boot: 0.2, fetch: 0.11, idle: 0.29, failed: 0.04 })).toBeCloseTo(0.587, 3);
    expect(nothingShare({ render: 0, boot: 0, fetch: 0, idle: 0, failed: 0 })).toBe(0);
  });

  it("how long the balance lasts, in the unit that reads", () => {
    expect(runwaySaid(130)).toBe("about 4 months at this pace");
    expect(runwaySaid(12.4)).toBe("about 12 days at this pace");
    expect(runwaySaid(0.4)).toBe("about 10 h at this pace");
    expect(runwaySaid(null)).toBe("nothing spent in the last 7 days");
  });

  it("a session's bar to the longest one's scale, each part with its tip, an estimated boot said", () => {
    const s: PodSession = {
      id: "s", machine: "rp", gpu: "A40", rate: 0.6, from: 0, to: 30 * MIN, open: false, usd: 0.3, why: "", idleMinutes: 10,
      parts: { boot: 4 * MIN, fetch: 6 * MIN, render: 10 * MIN, failed: 0, idle: 10 * MIN }, estimated: ["its boot, up to its first work"],
      fetched: { files: 2, bytes: 26 * 2 ** 30 }, renders: [{ id: "r", at: 20 * MIN, ms: 10 * MIN, status: "done", model: "SCAIL", usd: 0.1, item: null }],
    };
    const bits = sessionBits(s, 60 * MIN);
    expect(bits.map((b) => [b.part, b.share])).toEqual([["render", 1 / 6], ["boot", 4 / 60], ["fetch", 0.1], ["idle", 1 / 6]]);
    expect(bits.map((b) => b.tip)).toEqual(["1 render · 10 min", "Booting · 4 min (estimated)", "Fetching 2 files, 26.0 GB · 6 min", "Idle · 10 min"]);
  });

  it("where the totals come from", () => {
    expect(totalsSaid({ runpod: false, billed: false, billReadAt: null })).toMatch(/^No RunPod key/);
    expect(totalsSaid({ runpod: true, billed: false, billReadAt: null })).toMatch(/^Totals are Afflatus's own count/);
    expect(totalsSaid({ runpod: true, billed: true, billReadAt: 0 }, 14 * MIN)).toMatch(/^Totals from RunPod's bill \(read 14 min ago;/);
  });
});
