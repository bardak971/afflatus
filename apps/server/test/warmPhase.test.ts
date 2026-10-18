import { describe, expect, it } from "vitest";
import { warmPhase } from "../src/queueView";

const running = (cold?: boolean) => ({ id: "j", machine: "m1", abort: new AbortController(), gpu: true, ...(cold === undefined ? {} : { cold }) });

describe("the phase before a render's first step (the owner, 2026-10-18: the badge said Loading with every model held)", () => {
  it("is preparing when its models were already in memory, loading when they had to come in", () => {
    expect(warmPhase({ phase: "loading" }, running(false)).phase).toBe("preparing");
    expect(warmPhase({ phase: "loading" }, running(true)).phase).toBe("loading");
    // not known yet (before its graph is sent): as ComfyUI says it
    expect(warmPhase({ phase: "loading" }, running()).phase).toBe("loading");
    expect(warmPhase({ phase: "sampling" }, running(false)).phase).toBe("sampling");
    // after its steps, what runs is no model coming in
    expect(warmPhase({ phase: "loading", step: 4 }, running(false)).phase).toBe("processing");
  });
});
