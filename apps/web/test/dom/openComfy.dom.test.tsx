import { describe, expect, it, vi } from "vitest";
import { commandActions } from "../../src/bar/actions/commands";
import type { BarCtx } from "../../src/bar/actions/ctx";

/**
 * Ctrl+K "open comfyui" before the queue is read: its row is off and says why, rather than opening a guessed machine
 * ("m1", which may have been removed).
 */

const machine = { id: "m3", name: "Studio PC", url: "http://comfy.test", paused: false, online: true, locked: false, running: false, rented: null };

function rows(queue: BarCtx["queue"]) {
  const mutate = vi.fn();
  const ctx = { queue, openComfy: { mutate } } as unknown as BarCtx;
  return { actions: commandActions(ctx, { cmd: "open-comfy" }), mutate };
}

describe("Open ComfyUI", () => {
  it("is off while the machines are not read yet", () => {
    const { actions, mutate } = rows(undefined);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ disabled: true, note: "the machines are not read yet" });
    void actions[0]!.run();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("opens the first machine once read", () => {
    const { actions, mutate } = rows({ paused: false, online: true, rendering: false, running: false, waiting: [], failed: [], machines: [machine] });
    expect(actions[0]!.disabled).toBe(false);
    void actions[0]!.run();
    expect(mutate).toHaveBeenCalledWith("m3");
  });
});
