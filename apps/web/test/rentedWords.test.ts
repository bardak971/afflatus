import { describe, expect, it } from "vitest";
import type { MachineState, QueueStatus, RentedState } from "../src/api";
import { usd } from "../src/format";
import { rateSaid, rentedSaid, rentedSpent, rentedUp, severalMachines } from "../src/machines";

/** What a rented pod's row, its Start and the pill say (machines.ts), and when the machines' own controls show. */

const pod = (over: Partial<RentedState> = {}): RentedState => ({
  provider: "runpod", pod: "p1", status: "EXITED", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenter: "EU-RO-1",
  since: null, spent: 0, diskPerDay: 0.33, volume: false, otherPorts: [], closedPorts: [], watchdog: "unknown", answers: null, idleLeftMs: null, capped: false, stopping: false,
  stoppedBy: null, error: null, ...over,
});

describe("a rented pod's words", () => {
  it("says its state, and its run's cost counted here by the second", () => {
    const now = 1_800_000_000_000;
    expect(rentedSaid(pod())).toBe("stopped · disk $0.33/day");
    expect(rentedSaid(pod({ status: "STARTING" }))).toBe("starting");
    expect(rentedSaid(pod({ status: "PROVISIONING" }))).toBe("deploying · pulling its image");
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

describe("a lone rented pod", () => {
  const machine = (over: Partial<MachineState>): MachineState => ({ id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null, ...over } as MachineState);
  it("has the machines' own controls, as several do; one ComfyUI of one's own does not", () => {
    expect(severalMachines({ machines: [machine({})] } as unknown as QueueStatus)).toEqual([]);
    expect(severalMachines({ machines: [machine({ rented: pod() })] } as unknown as QueueStatus)).toHaveLength(1);
  });
});
