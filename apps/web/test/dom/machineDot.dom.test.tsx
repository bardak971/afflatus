import { describe, expect, it } from "vitest";
import type { MachineState } from "../../src/api";
import { Dot } from "../../src/machineBits";
import { draw } from "./render";

/** A machine's small dot (machineBits.tsx) for a pod RunPod was not read for yet: neutral, never the stopped ring. */

const pod = (status: string) =>
  ({
    id: "pod", name: "A40", url: "https://x", takes: "all", paused: false, online: true, locked: false, model: null, pace: null, running: null,
    rented: { status, since: null, booting: false, answers: null, stopping: false, files: [] },
  }) as unknown as MachineState;

describe("a pod's dot", () => {
  it("is checking before RunPod is read, stopped once it says so", () => {
    const { container } = draw(<Dot m={pod("UNKNOWN")} />);
    const dot = container.querySelector("span")!;
    expect(dot.dataset.state).toBe("checking");
    expect(dot.className).not.toContain("border-ink-3");
    const stopped = draw(<Dot m={pod("EXITED")} />).container.querySelector("span")!;
    expect(stopped.className).toContain("border-ink-3");
  });
});
