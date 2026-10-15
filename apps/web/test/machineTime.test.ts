import { describe, expect, it } from "vitest";
import { machineState, timeOn } from "../src/machines";

describe("a render's time on a machine", () => {
  const a40 = { id: "rp-a40", pace: 0.76 };
  it("is the server's figure for that machine when it gave one, not the common one at the machine's pace", () => {
    // the common figure from this computer's renders, and the A40's own two windows
    expect(timeOn(900_000, { "rp-a40": 220_000, m1: 900_000 }, a40)).toBe(220_000);
  });

  it("is the common figure at the machine's pace when the server has none for it, and the common figure on Auto", () => {
    expect(timeOn(100_000, null, a40)).toBeCloseTo(76_000);
    expect(timeOn(100_000, { m1: 100_000 }, { id: "m2", pace: null })).toBe(100_000);
    expect(timeOn(100_000, { "rp-a40": 50_000 }, null)).toBe(100_000);
    expect(timeOn(null, { "rp-a40": 50_000 }, a40)).toBeNull();
  });
});

describe("a machine's state in a word", () => {
  const home = { paused: false, online: true as boolean | null, locked: false, running: null as unknown, rented: null };
  const pod = (status: string, booting = false) => ({ ...home, online: false, rented: { status, booting } as never });
  it("says a stopped pod stopped and a starting one starting, not offline", () => {
    expect(machineState(pod("EXITED"))).toBe("stopped");
    expect(machineState(pod("STARTING"))).toBe("starting");
    expect(machineState({ ...pod("RUNNING", true), online: true })).toBe("starting");
  });
  it("says a ComfyUI locked against the token locked, not offline", () => {
    expect(machineState({ ...home, online: false, locked: true })).toBe("locked");
    expect(machineState({ ...home, online: false })).toBe("offline");
  });
  it("says paused before rendering, then rendering, then idle", () => {
    expect(machineState({ ...home, paused: true, running: {} })).toBe("paused");
    expect(machineState({ ...home, running: {} })).toBe("rendering");
    expect(machineState(home)).toBe("idle");
  });
});
