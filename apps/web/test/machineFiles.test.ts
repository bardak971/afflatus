import { describe, expect, it } from "vitest";
import type { MachineState, PodFile, RentedState } from "../src/api";
import { busiest, doing, filesSaid, filesTip, gettingFiles } from "../src/machineBits";

/** A rented pod getting the files its jobs wait for: what the pill, its popover and the Queue's lane say of it (machineBits.tsx). */

const GB = 1024 ** 3;
const file = (over: Partial<PodFile>): PodFile => ({ file: "a.safetensors", folder: "diffusion_models", state: "next", tier: "need", bytes: 0, total: GB, jobs: ["j"], ...over });
const pod = (files: PodFile[], over: Partial<MachineState> = {}): MachineState =>
  ({
    id: "pod", name: "A40", url: "https://x", takes: "all", paused: false, online: true, locked: false, model: null, pace: null, running: null,
    rented: { status: "RUNNING", since: null, booting: false, answers: true, stopping: false, files } as unknown as RentedState,
    ...over,
  }) as MachineState;
const local = (over: Partial<MachineState> = {}) => ({ id: "m1", name: "", url: "http://127.0.0.1:8188", takes: "all", paused: false, online: true, locked: false, rented: null, model: null, pace: null, running: null, ...over }) as MachineState;

describe("a pod getting files", () => {
  it("counts the files its jobs wait for, the bytes in, and the one under way", () => {
    const m = pod([
      file({ file: "ready.safetensors", state: "ready", total: 2 * GB }),
      file({ file: "now.safetensors", state: "fetching", bytes: GB, total: 4 * GB, via: "hf" }),
      file({ file: "next.safetensors", total: 2 * GB, via: "civitai" }),
      // asked ahead, for later: not waited for, not counted
      file({ file: "later.safetensors", tier: "ahead", total: 10 * GB }),
    ]);
    const g = gettingFiles(m)!;
    expect(g.left.map((f) => f.file)).toEqual(["now.safetensors", "next.safetensors"]);
    expect(g.done).toBe(3 * GB);
    expect(g.total).toBe(8 * GB);
    expect(g.share).toBeCloseTo(3 / 8);
    expect(g.now.file).toBe("now.safetensors");
    expect(filesTip("A40", g)).toContain("now: now.safetensors · 4.0 GB · from Hugging Face\nnext: next.safetensors · 2.0 GB · from Civitai");
  });

  it("says the bytes in, never a share, while a file left has no size yet", () => {
    const g = gettingFiles(pod([file({ state: "fetching", bytes: 3 * GB, total: 0 }), file({ state: "ready", total: GB })]))!;
    expect(g.share).toBeNull();
    expect(filesSaid(g)).toBe("4.0 GB in");
    expect(filesSaid(gettingFiles(pod([file({ state: "fetching", bytes: GB, total: 4 * GB })]))!)).toBe("25 %");
  });

  it("is none with every file in, or only files asked ahead, and on a machine of this PC", () => {
    expect(gettingFiles(pod([file({ state: "ready" })]))).toBeNull();
    expect(gettingFiles(pod([file({ tier: "ahead" })]))).toBeNull();
    expect(gettingFiles(local())).toBeNull();
  });

  it("reads as getting files, not idle, in its row and in the pill's word; a render stays the busiest", () => {
    const m = pod([file({ state: "fetching" }), file({})]);
    expect(doing(m, Date.now())).toBe("getting 2 files for its jobs");
    expect(doing({ ...m, paused: true }, Date.now())).toBe("paused · getting 2 files for its jobs");
    expect(busiest([local({ paused: true }), m])).toBe("1 getting files");
    expect(busiest([local({ running: { label: "x" } as MachineState["running"] }), m])).toBe("1 rendering");
  });
});
