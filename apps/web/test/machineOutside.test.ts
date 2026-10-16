import { describe, expect, it } from "vitest";
import type { MachineState, PodFile } from "../src/api";
import { phaseLabel } from "../src/format";
import { busiest, doing } from "../src/machineBits";
import { machineState, machineUnloadBlock, outsideSaid } from "../src/machines";
import { unloadBlock } from "../src/queueRules";

/** A ComfyUI running work queued from outside Afflatus (its own page, another tool): the one word every screen says of it. */

const local = (over: Partial<MachineState> = {}) => ({ id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: "Juggernaut XL", pace: null, running: null, ...over }) as MachineState;
const busy = (running = 1, pending = 0, over: Partial<MachineState> = {}) => local({ outside: { running, pending }, ...over });
const fetching: PodFile = { file: "a.safetensors", folder: "checkpoints", state: "fetching", tier: "ahead", bytes: 0, total: 1024, jobs: [] };

describe("a machine busy outside Afflatus", () => {
  it("reads as busy outside Afflatus, never idle; Afflatus's own render, a pause and a machine away say theirs first", () => {
    expect(machineState(busy())).toBe("busy outside Afflatus");
    expect(machineState(busy(0, 2))).toBe("busy outside Afflatus");
    // its own work done, or not known: idle as before
    expect(machineState(busy(0, 0))).toBe("idle");
    expect(machineState(local({ outside: null }))).toBe("idle");
    expect(machineState(busy(1, 0, { running: { label: "x" } as MachineState["running"] }))).toBe("rendering");
    expect(machineState(busy(1, 0, { paused: true }))).toBe("paused");
    expect(machineState(busy(1, 0, { online: false }))).toBe("offline");
    // files coming to it meanwhile: its GPU being at work says more
    expect(machineState(busy(1, 0, { files: [fetching] }))).toBe("busy outside Afflatus");
  });

  it("says that work in a few words, in its row and in the pill's word", () => {
    expect(outsideSaid(busy(1, 2))).toBe("1 prompt running, 2 queued in ComfyUI");
    expect(outsideSaid(busy(2, 0))).toBe("2 prompts running in ComfyUI");
    expect(outsideSaid(busy(0, 1))).toBe("1 prompt queued in ComfyUI");
    expect(outsideSaid(local())).toBeNull();
    expect(doing(busy(1, 2), Date.now())).toBe("busy outside Afflatus · 1 prompt running, 2 queued in ComfyUI");
    expect(busiest([local(), busy()])).toBe("1 busy outside Afflatus");
    expect(busiest([local({ running: { label: "x" } as MachineState["running"] }), busy()])).toBe("1 rendering");
  });

  it("is not unloaded: its models are in use by someone else's work", () => {
    expect(machineUnloadBlock(busy())).toBe("it is busy outside Afflatus");
    expect(machineUnloadBlock(busy(0, 0))).toBeNull();
    expect(unloadBlock({ online: true, running: null, machines: [busy()] })).toBe("ComfyUI is busy outside Afflatus");
    expect(unloadBlock({ online: true, running: null, machines: [local()] })).toBeNull();
  });

  it("names a job of Afflatus's waiting there behind it", () => {
    expect(phaseLabel("behind")).toBe("Queued on ComfyUI · waiting behind work outside Afflatus");
    expect(phaseLabel("waiting")).toBe("Queued on ComfyUI");
  });
});
