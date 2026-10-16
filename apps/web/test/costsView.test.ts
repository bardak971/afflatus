import { describe, expect, it } from "vitest";
import type { PodSession } from "../src/api";
import { bootSaid, bootSplit, nothingShare, presetWindow, runwayNowSaid, runwaySaid, sessionBits, totalsSaid } from "../src/screens/queue/costsView";

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
    expect(runwaySaid(0.02)).toBe("about 29 min at this pace");
  });

  it("the runway at the spend now, only while it runs faster than the pace", () => {
    // a pod at $0.60/h against a pace of $3 a day: 11 h of a $6.60 balance
    expect(runwayNowSaid({ spendPerHr: 0.6, runwayNowMs: 11 * 3_600_000, perDay: 3 })).toBe("about 11 h at $0.60/h now");
    // nothing running, storage alone: the pace's runway is the nearer end
    expect(runwayNowSaid({ spendPerHr: 0.02, runwayNowMs: 300 * 3_600_000, perDay: 0.5 })).toBeNull();
    expect(runwayNowSaid({ spendPerHr: null, runwayNowMs: null, perDay: 0 })).toBeNull();
    // a little faster than the pace: the pace's runway says it
    expect(runwayNowSaid({ spendPerHr: 0.06, runwayNowMs: 400 * 3_600_000, perDay: 1.2 })).toBeNull();
    expect(runwaySaid(null)).toBe("nothing spent in the last 7 days, no storage");
  });

  it("a session's bar to the longest one's scale, each part with its tip, an estimated boot said", () => {
    const s: PodSession = {
      id: "s", machine: "rp", gpu: "A40", rate: 0.6, from: 0, to: 30 * MIN, open: false, usd: 0.3, why: "", idleMinutes: 10,
      parts: { boot: 4 * MIN, fetch: 6 * MIN, render: 10 * MIN, failed: 0, idle: 10 * MIN }, estimated: ["its boot, up to its first work"],
      boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN }, startFailed: null, packs: [],
      fetched: { files: 2, bytes: 26 * 2 ** 30 }, renders: [{ id: "r", at: 20 * MIN, ms: 10 * MIN, status: "done", model: "SCAIL", usd: 0.1, item: null }],
    };
    const bits = sessionBits(s, 60 * MIN);
    expect(bits.map((b) => [b.part, b.share])).toEqual([["render", 1 / 6], ["boot", 4 / 60], ["fetch", 0.1], ["idle", 1 / 6]]);
    expect(bits.map((b) => b.tip)).toEqual(["1 render · 10 min", "Booting · 4 min (estimated)", "Fetching 2 files, 26.0 GB · 6 min", "Idle · 10 min"]);
  });

  it("a boot kept in parts: its bits in Booting's place, each with its tip; its open row's line with time and cost", () => {
    const s: PodSession = {
      id: "s", machine: "rp", gpu: "A40", rate: 0.6, from: 0, to: 20 * MIN, open: false, usd: 0.2, why: "", idleMinutes: 10,
      parts: { boot: 10 * MIN, fetch: 0, render: 10 * MIN, failed: 0, idle: 0 }, estimated: [],
      boot: { pull: 6 * MIN, packs: 2 * MIN, comfy: 2 * MIN, startFailed: 0, boot: 0 }, startFailed: null, packs: [{ pack: "ComfyUI-KJNodes", ms: 90_000 }],
      fetched: { files: 0, bytes: 0 }, renders: [{ id: "r", at: 20 * MIN, ms: 10 * MIN, status: "done", model: "SCAIL", usd: 0.1, item: null }],
    };
    const bits = sessionBits(s, 20 * MIN);
    expect(bits.map((b) => [b.key, b.share])).toEqual([["render", 0.5], ["boot-pull", 0.3], ["boot-packs", 0.1], ["boot-comfy", 0.1]]);
    // the bits still add up to the session
    expect(bits.reduce((n, b) => n + b.share, 0)).toBe(1);
    expect(bits[2]!.tip).toBe("Node packs · 2 min: ComfyUI-KJNodes 1 min 30 s");
    expect(bootSaid(s)).toBe("Boot: pulling the image 6 min, $0.060 · node packs 2 min, $0.020 (ComfyUI-KJNodes 1 min 30 s) · starting ComfyUI 2 min, $0.020");
    // a failed start says its step; a boot all plain is not split
    expect(bootSaid({ ...s, boot: { pull: 3 * MIN, packs: 0, comfy: 0, startFailed: 4 * MIN, boot: 0 }, startFailed: "putting in the node packs (exit 1)" })).toBe('Boot: pulling the image 3 min, $0.030 · failed start at "putting in the node packs (exit 1)" 4 min, $0.040');
    expect(bootSplit({ pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN })).toEqual([]);
    expect(bootSaid({ ...s, boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN } })).toBeNull();
  });

  it("where the totals come from", () => {
    expect(totalsSaid({ runpod: false, billed: false, billReadAt: null })).toMatch(/^No RunPod key/);
    expect(totalsSaid({ runpod: true, billed: false, billReadAt: null })).toMatch(/^Totals are Afflatus's own count/);
    expect(totalsSaid({ runpod: true, billed: true, billReadAt: 0 }, 14 * MIN)).toMatch(/^Totals from RunPod's bill \(read 14 min ago;/);
  });
});
