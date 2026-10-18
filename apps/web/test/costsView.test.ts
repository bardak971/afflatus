import { describe, expect, it } from "vitest";
import type { PodSession } from "../src/api";
import { BOOT_SAID, bootSaid, bootSplit, nothingShare, OUTSIDE_WHY, PART_SAID, presetWindow, runwayNowSaid, runwaySaid, sessionBits, totalsSaid } from "../src/screens/queue/costsView";

/** What the Costs tab works out from the server's figures before drawing them (costsView.ts). */

const MIN = 60_000;

describe("the Costs tab", () => {
  it("its windows: a preset ending now, the month from its 1st, all of it unbounded", () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    expect(presetWindow("24H", now)).toEqual({ from: now - 86_400_000, to: now });
    expect(presetWindow("Month", now)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: now });
    expect(presetWindow("All", now)).toBeNull();
  });

  it("what made nothing: all but the renders that finished and the work from outside Afflatus, which used the pod too", () => {
    expect(nothingShare({ render: 0.45, boot: 0.2, fetch: 0.11, outside: 0, idle: 0.29, failed: 0.04 })).toBeCloseTo(0.587, 3);
    expect(nothingShare({ render: 0.45, boot: 0.2, fetch: 0.11, outside: 0.2, idle: 0.09, failed: 0.04 })).toBeCloseTo(0.44 / 1.09, 6);
    expect(nothingShare({ render: 0, boot: 0, fetch: 0, outside: 0, idle: 0, failed: 0 })).toBe(0);
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
      parts: { boot: 4 * MIN, fetch: 6 * MIN, render: 10 * MIN, failed: 0, outside: 0, idle: 10 * MIN }, estimated: ["its boot, up to its first work"],
      boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN }, startFailed: null, crash: null, packs: [],
      fetched: { files: 2, bytes: 26 * 2 ** 30 }, renders: [{ id: "r", at: 20 * MIN, ms: 10 * MIN, status: "done", model: "SCAIL", usd: 0.1, item: null }],
    };
    const bits = sessionBits(s, 60 * MIN);
    expect(bits.map((b) => [b.part, b.share])).toEqual([["render", 1 / 6], ["boot", 4 / 60], ["fetch", 0.1], ["idle", 1 / 6]]);
    expect(bits.map((b) => b.tip)).toEqual(["1 render · 10 min", "Booting · 4 min (estimated)", "Fetching 2 files, 26.0 GB · 6 min", "Idle · 10 min"]);
    // beside boots split in parts, a plain one is drawn as an earlier boot, not in the shade Node packs has; "Not split" is the
    // month's bill beyond Afflatus's count, on the same page
    const beside = sessionBits(s, 60 * MIN, true);
    expect(beside.map((b) => [b.key, b.share])).toEqual([["render", 1 / 6], ["boot-boot", 4 / 60], ["fetch", 0.1], ["idle", 1 / 6]]);
    expect(beside[1]!.color).toBe(BOOT_SAID.find((p) => p.part === "boot")!.color);
    expect(beside[1]!.tip).toBe("Earlier boot · 4 min (estimated)");
    expect(BOOT_SAID.find((p) => p.part === "boot")!.name).toBe("Earlier boots");
    expect(BOOT_SAID.map((p) => p.name)).not.toContain("Not split");
  });

  it("work from outside Afflatus: its own bit after the files and before idle, in its own colour, its tip saying what it is", () => {
    const s: PodSession = {
      id: "s", machine: "rp", gpu: "RTX 3070", rate: 0.14, from: 0, to: 10 * MIN, open: false, usd: 0.14 / 6, why: "no render, work outside Afflatus", idleMinutes: 10,
      parts: { boot: 2 * MIN, fetch: 0, render: 0, failed: 0, outside: 4 * MIN, idle: 4 * MIN }, estimated: [],
      boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 2 * MIN }, startFailed: null, crash: null, packs: [],
      fetched: { files: 0, bytes: 0 }, renders: [],
    };
    const bits = sessionBits(s, 10 * MIN);
    expect(bits.map((b) => [b.part, b.share])).toEqual([["boot", 0.2], ["outside", 0.4], ["idle", 0.4]]);
    expect(bits[1]!.tip).toBe("Outside Afflatus · 4 min: work queued in its ComfyUI from elsewhere");
    expect(bits[1]!.color).toBe("var(--color-good)");
    expect(PART_SAID.find((p) => p.part === "outside")!.name).toBe("Outside Afflatus");
    expect(OUTSIDE_WHY).toBe("Work queued in the pod's ComfyUI from elsewhere (its own page, another tool): billed, and not idle.");
  });

  it("draws every part and every part of a boot apart, the boot's in Booting's own hue and a failed start striped", () => {
    // Booting itself is drawn only where no boot was split, so its parts (Node packs in its very shade) never sit beside it
    const colours = [...PART_SAID.filter((p) => p.part !== "boot").map((p) => p.color), ...BOOT_SAID.map((p) => p.color)];
    expect(new Set(colours).size).toBe(colours.length);
    for (const b of BOOT_SAID) expect(b.color, b.name).toContain("var(--color-boot)");
    expect(PART_SAID.find((p) => p.part === "boot")!.color).toBe("var(--color-boot)");
    expect(BOOT_SAID.find((p) => p.part === "startFailed")!.color).toMatch(/^repeating-linear-gradient\(.*var\(--color-warn\)/);
    expect(PART_SAID.find((p) => p.part === "failed")!.color).toBe("var(--color-warn)");
  });

  it("a boot kept in parts: its bits in Booting's place, each with its tip; its open row's line with time and cost", () => {
    const s: PodSession = {
      id: "s", machine: "rp", gpu: "A40", rate: 0.6, from: 0, to: 20 * MIN, open: false, usd: 0.2, why: "", idleMinutes: 10,
      parts: { boot: 10 * MIN, fetch: 0, render: 10 * MIN, failed: 0, outside: 0, idle: 0 }, estimated: [],
      boot: { pull: 6 * MIN, packs: 2 * MIN, comfy: 2 * MIN, startFailed: 0, boot: 0 }, startFailed: null, crash: null, packs: [{ pack: "ComfyUI-KJNodes", ms: 90_000 }],
      fetched: { files: 0, bytes: 0 }, renders: [{ id: "r", at: 20 * MIN, ms: 10 * MIN, status: "done", model: "SCAIL", usd: 0.1, item: null }],
    };
    const bits = sessionBits(s, 20 * MIN);
    expect(bits.map((b) => [b.key, b.share])).toEqual([["render", 0.5], ["boot-pull", 0.3], ["boot-packs", 0.1], ["boot-comfy", 0.1]]);
    // the bits still add up to the session
    expect(bits.reduce((n, b) => n + b.share, 0)).toBe(1);
    expect(bits[2]!.tip).toBe("Node packs · 2 min: ComfyUI-KJNodes 1 min 30 s");
    expect(bootSaid(s)).toBe("Boot: pulling the image 6 min, $0.060 · node packs 2 min, $0.020 (ComfyUI-KJNodes 1 min 30 s) · starting ComfyUI 2 min, $0.020");
    // a failed start says its step; a part no boot log said is booting; a boot all plain has no parts to say
    expect(bootSaid({ ...s, boot: { pull: 3 * MIN, packs: 0, comfy: 0, startFailed: 4 * MIN, boot: 0 }, startFailed: "putting in the node packs (exit 1)" })).toBe('Boot: pulling the image 3 min, $0.030 · failed start at "putting in the node packs (exit 1)" 4 min, $0.040');
    expect(bootSaid({ ...s, boot: { pull: 0, packs: 2 * MIN, comfy: 2 * MIN, startFailed: 0, boot: 3 * MIN }, packs: [] })).toBe("Boot: node packs 2 min, $0.020 · starting ComfyUI 2 min, $0.020 · booting 3 min, $0.030");
    expect(bootSplit({ pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN })).toEqual([]);
    expect(bootSaid({ ...s, boot: { pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN } })).toBeNull();
  });

  it("where the totals come from", () => {
    expect(totalsSaid({ runpod: false, billed: false, billReadAt: null })).toMatch(/^No RunPod key/);
    expect(totalsSaid({ runpod: true, billed: false, billReadAt: null })).toMatch(/^Totals are Afflatus's own count/);
    expect(totalsSaid({ runpod: true, billed: true, billReadAt: 0 }, 14 * MIN)).toMatch(/^Totals from RunPod's bill \(read 14 min ago;/);
  });
});
