import { describe, expect, it } from "vitest";
import type { RankedGpu } from "@afflatus/core";
import type { HuntSummary, MachineState, QueueStatus } from "../src/api";
import { ceilingFor, firstPick, giveUpOptions, huntDone, huntStrip, huntTitle, minutesSaid, renderSaid, resumeHoldsHunt } from "../src/huntSaid";

const T0 = Date.parse("2026-10-14T10:00:00Z");
const hunt = (over: Partial<HuntSummary> = {}): HuntSummary => ({
  status: "hunting", startedAt: new Date(T0).toISOString(), giveUpAt: new Date(T0 + 2 * 3_600_000).toISOString(), hold: "rest", held: 6, firstPick: null, machine: null, ...over,
});
const gpu = (id: string, fit: RankedGpu["fit"], over: Partial<RankedGpu> = {}): RankedGpu => ({
  id, name: id, price: 0.69, memory: 24, fit, fits: fit, seconds: 130, cost: 0.025, learned: 0, timeSaid: "a guess", stock: "none free", rank: 1, ...over,
});
const machine = (id: string, rented = false) => ({ id, rented: rented ? { status: "RUNNING" } : null }) as unknown as MachineState;
const queue = (h: HuntSummary | null, machines: MachineState[]) => ({ hunt: h, machines }) as Pick<QueueStatus, "hunt" | "machines">;

describe("the GPU hunt in words", () => {
  it("opens at the GPU wanted's price, up to the next quarter dollar; $1.00 with none", () => {
    expect(ceilingFor(0.94)).toBe(1);
    expect(ceilingFor(0.69)).toBe(0.75);
    expect(ceilingFor(0.75)).toBe(0.75);
    expect(ceilingFor(2.69)).toBe(2.75);
    expect(ceilingFor(undefined)).toBe(1);
  });

  it("badges the best-ranked usable GPU, whatever its stock", () => {
    expect(firstPick([gpu("a", "left"), gpu("b", "yes"), gpu("c", "yes")])?.id).toBe("b");
    expect(firstPick([gpu("a", "small")])).toBeNull();
    expect(firstPick(null)).toBeNull();
  });

  it("says a render as cost and time, or not known", () => {
    expect(renderSaid({ cost: 0.025, seconds: 130 })).toBe("$0.025 · 2m 10s");
    expect(renderSaid({ cost: null, seconds: null })).toBe("not known yet");
  });

  it("offers its give-up times, with one kept from before", () => {
    expect(giveUpOptions(120)).toEqual([30, 60, 120, 240, 480, 720]);
    expect(giveUpOptions(90)).toEqual([30, 60, 90, 120, 240, 480, 720]);
    expect([30, 90, 120].map(minutesSaid)).toEqual(["30 min", "1 h 30 min", "2 h"]);
  });

  it("titles the hunt by its mode and price", () => {
    expect(huntTitle({ mode: "value", ceiling: 1 })).toBe("Hunting · best value, up to $1.00/h");
    expect(huntTitle({ mode: "cheap", ceiling: 0.5 })).toBe("Hunting · cheapest an hour, up to $0.50/h");
  });

  it("says itself on the strip while it hunts or deploys, and nothing once its pod is up", () => {
    const at = T0 + 14 * 60_000;
    expect(huntStrip(hunt(), at)).toEqual({ main: "Hunting", more: "14 min · 6 held", chip: "Hunting · 14 min" });
    expect(huntStrip(hunt(), T0 + 5_000)?.more).toBe("1 min · 6 held");
    expect(huntStrip(hunt({ hold: "keep" }), at)?.more).toBe("14 min");
    expect(huntStrip(hunt({ status: "deploying", firstPick: { name: "RTX 4090", price: 0.69 } }), at)?.main).toBe("RTX 4090 found");
    expect(huntStrip(hunt({ status: "up" }), at)).toBeNull();
    expect(huntDone(hunt(), T0 + 30 * 60_000)).toBeCloseTo(0.25);
    expect(huntDone(hunt(), T0 + 5 * 3_600_000)).toBe(1);
  });

  it("has a Resume ask first only while the hunt holds the renders, for the home machines", () => {
    const machines = [machine("m1"), machine("pod", true)];
    expect(resumeHoldsHunt(queue(hunt(), machines))).toBe(true);
    expect(resumeHoldsHunt(queue(hunt(), machines), "m1")).toBe(true);
    // a rented pod is never the hunt's to hold
    expect(resumeHoldsHunt(queue(hunt(), machines), "pod")).toBe(false);
    expect(resumeHoldsHunt(queue(hunt({ hold: "keep" }), machines))).toBe(false);
    expect(resumeHoldsHunt(queue(null, machines))).toBe(false);
    expect(resumeHoldsHunt(undefined)).toBe(false);
  });
});
