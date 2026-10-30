import { describe, expect, it } from "vitest";
import type { MachineState } from "../src/api";
import { doing } from "../src/machineBits";
import { machineState, onlineSaid } from "../src/machines";

/** A ComfyUI that answers nothing while it renders but still runs (a PC paging, card #196): it renders on, never "offline". */

const running = { label: "zz-test cat", progress: 0.4, step: 0, steps: 0 } as unknown as MachineState["running"];
const local = (over: Partial<MachineState> = {}) => ({ id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null, ...over }) as MachineState;
const SAID = "ComfyUI isn't answering: its memory is full, the PC is paging (ComfyUI holds 35.4 GB, 2.1 GB of 63.9 GB RAM free); the render goes on";

describe("a machine silent while it renders", () => {
  it("still running: rendering, said not answering, counted online", () => {
    const m = local({ online: false, busy: SAID, running });
    expect(machineState(m)).toBe("rendering");
    expect(doing(m, Date.now())).toBe("zz-test cat · not answering, goes on");
    expect(onlineSaid([m, local()])).toBe("2 of 2 machines online");
  });

  it("its process gone: offline, as before", () => {
    const m = local({ online: false, busy: null, running });
    expect(machineState(m)).toBe("offline");
    expect(doing(m, Date.now())).toBe("offline");
    expect(onlineSaid([m, local()])).toBe("1 of 2 machines online");
  });
});
