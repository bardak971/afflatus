import { describe, expect, it } from "vitest";
import type { MachineState, QueueStatus, RentedState } from "../src/api";
import { usd } from "../src/format";
import { busiest, doing } from "../src/machineBits";
import { bootSaid, machineState, onlineSaid, rateParts, rateSaid, rentedSaid, rentedSpent, rentedUp, severalMachines } from "../src/machines";

/** What a rented pod's row, its Start and the pill say (machines.ts), and when the machines' own controls show. */

const pod = (over: Partial<RentedState> = {}): RentedState => ({
  provider: "runpod", pod: "p1", status: "EXITED", rate: 0.69, gpuRate: null, gpu: "NVIDIA GeForce RTX 5090", dataCenter: "EU-RO-1",
  since: null, spent: 0, diskPerDay: 0.33, volume: false, otherPorts: [], closedPorts: [], watchdog: "unknown", answers: null, idleAt: null, capped: false, stopping: false,
  stoppedBy: null, booting: false, error: null, files: [], packs: [], disk: null, ...over,
});

describe("a rented pod's words", () => {
  it("says its state, and its run's cost counted here by the second", () => {
    const now = 1_800_000_000_000;
    expect(rentedSaid(pod())).toBe("stopped · disk $0.33/day");
    expect(rentedSaid(pod({ status: "STARTING" }))).toBe("starting");
    expect(rentedSaid(pod({ status: "PROVISIONING" }))).toBe("deploying · pulling its image");
    // a deployed pod's first start is a normal step, said as one
    expect(rentedSaid(pod({ status: "RUNNING", booting: true, answers: false, since: null }))).toBe("deploying");
    expect(rentedSaid(pod({ status: "GONE" }))).toBe("not on RunPod");
    const running = pod({ status: "RUNNING", since: now - 120_000, answers: true });
    expect(rentedSpent(running, now)).toBeCloseTo((2 / 60) * 0.69, 6);
    expect(rentedSaid(running, now)).toBe("running 2 min · $0.023");
    // billed from its start, whether its ComfyUI answers yet or not
    expect(rentedSaid(pod({ status: "RUNNING", since: now - 30_000, answers: false }), now)).toMatch(/^running, ComfyUI not up yet 30 s/);
    expect(rentedSaid(pod({ status: "RUNNING", since: now - 30_000, stopping: true }), now)).toMatch(/^stopping/);
  });

  it("says the rate before a Start, or that RunPod says it only once the pod has run", () => {
    expect(rateSaid(pod())).toBe("$0.69 / h from now");
    expect(rateSaid(pod({ rate: null }))).toBe("rate known once it has run · billed from now");
  });

  it("takes work only while it runs", () => {
    expect(rentedUp({ rented: pod({ status: "RUNNING" }) })).toBe(true);
    expect(rentedUp({ rented: pod() })).toBe(false);
    expect(rentedUp({ rented: null })).toBe(true);
  });

  it("counts a running cost to a tenth of a cent under a dollar", () => {
    expect(usd(0.0234, true)).toBe("$0.023");
    expect(usd(0.0234)).toBe("$0.02");
    expect(usd(1.5, true)).toBe("$1.50");
  });
});

describe("a deployed pod's first start", () => {
  const now = 1_800_000_000_000;
  const boot = (over: Partial<NonNullable<RentedState["boot"]>> = {}) => ({ phase: "pulling" as const, step: null, failed: false, from: now - 6 * 60_000, ...over });
  const row = (r: RentedState): MachineState => ({ id: "rp-1", name: "RTX 3090", url: "https://x", takes: "all", paused: false, online: false, locked: false, rented: r, model: null, pace: null, running: null } as MachineState);

  it("says where it is, and for how long since its deploy: RunPod's data, then its boot log's step", () => {
    expect(bootSaid(boot(), now)).toBe("pulling the image · 6 min");
    expect(bootSaid(boot({ phase: "starting", from: now - 40_000 }), now)).toBe("starting ComfyUI · 40 s");
    expect(bootSaid(boot({ phase: "step", step: "putting in the node packs" }), now)).toBe("putting in the node packs · 6 min");
    expect(bootSaid(boot({ phase: "step", step: "putting in the node packs (exit 1)", failed: true }), now)).toBe("start stopped: putting in the node packs (exit 1) · 6 min");
  });

  it("in its row, its card's head and the pill: the same words, its cost while RunPod bills it", () => {
    const pulling = pod({ status: "RUNNING", booting: true, answers: null, since: now - 6 * 60_000, rate: 0.6, boot: boot() });
    expect(rentedSaid(pulling, now)).toBe("pulling the image · 6 min · $0.060");
    expect(rentedSaid(pod({ status: "PROVISIONING", booting: true, boot: boot({ from: now - 20_000 }) }), now)).toBe("pulling the image · 20 s");
    // before its first answer, RunPod says it runs: starting, never offline, in every place
    expect(machineState(row(pulling))).toBe("starting");
    expect(doing(row(pulling), now)).toBe("pulling the image · 6 min · $0.060");
    expect(busiest([row(pulling)])).toBe("1 starting");
    // the Queue's head: neither online nor offline
    const home = { ...row(pod()), id: "m1", rented: null, online: true } as MachineState;
    expect(onlineSaid([home, row(pulling)])).toBe("1 of 2 ComfyUIs online · 1 starting");
    expect(onlineSaid([home, { ...home, id: "m2", online: false }])).toBe("1 of 2 ComfyUIs online");
    // a Stop pressed meanwhile says so, not its start
    expect(rentedSaid({ ...pulling, stopping: true }, now)).toMatch(/^stopping/);
    // an older server says no `boot`: as before
    expect(rentedSaid(pod({ status: "PROVISIONING" }))).toBe("deploying · pulling its image");
  });
});

describe("a lone rented pod", () => {
  const machine = (over: Partial<MachineState>): MachineState => ({ id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null, ...over } as MachineState);
  it("has the machines' own controls, as several do; one ComfyUI of one's own does not", () => {
    expect(severalMachines({ machines: [machine({})] } as unknown as QueueStatus)).toEqual([]);
    expect(severalMachines({ machines: [machine({ rented: pod() })] } as unknown as QueueStatus)).toHaveLength(1);
  });
});

describe("a pod's rate in its parts", () => {
  it("says the GPU and its disk, as RunPod bills them", () => {
    expect(rateParts({ rate: 0.6127, gpuRate: 0.59 })).toBe("GPU $0.59 + its disk $0.023 an hour while it runs, as RunPod bills it");
  });
  it("says nothing when the rate is the GPU's alone: no \"+ its disk $0.00\"", () => {
    expect(rateParts({ rate: 0.59, gpuRate: 0.59 })).toBeNull();
    expect(rateParts({ rate: 0.59, gpuRate: null })).toBeNull();
  });
});
