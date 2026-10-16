import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { MissingPacks } from "../../src/screens/MissingPacks";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * The missing node packs' Restart ComfyUI now (review S-11): the workflow is read again until ComfyUI answers, for 5
 * minutes at most, and then said; leaving the editor stops it; what is read again afterwards is what the packs change.
 */

const graph = { "1": { class_type: "ZzTestNode", inputs: {} } };

function drawPacks(onInspected = vi.fn()) {
  // a pack Manager installed since ComfyUI started: the restart is offered at once
  fakeApi.on("GET /workflows/packs", { items: [], installed: 1 });
  fakeApi.on("POST /comfy/restart", { ok: true });
  const drawn = draw(<MissingPacks missing={["ZzTestNode"]} packs={{ ZzTestNode: "zz-test-pack" }} graph={graph} onInspected={onInspected} />);
  return { ...drawn, onInspected };
}

const restart = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Restart ComfyUI now" }));
  await screen.findByText(/ComfyUI is restarting/);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Restart ComfyUI now, for the missing packs", () => {
  it("says ComfyUI did not come back once it has not answered for 5 minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeApi.on("POST /workflows/inspect", () => jsonAnswer({ error: "ComfyUI is not answering" }, 503));
    drawPacks();
    await restart();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000));
    expect(screen.getByText(/ComfyUI did not come back in 5 minutes/)).toBeTruthy();
    const tries = fakeApi.calls("POST", "/workflows/inspect").length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fakeApi.calls("POST", "/workflows/inspect").length).toBe(tries);
  });

  it("tries nothing more once the editor is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeApi.on("POST /workflows/inspect", () => jsonAnswer({ error: "ComfyUI is not answering" }, 503));
    const { unmount, onInspected } = drawPacks();
    await restart();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fakeApi.calls("POST", "/workflows/inspect")).toHaveLength(0);
    expect(onInspected).not.toHaveBeenCalled();
  });

  it("reads again what the packs change once ComfyUI is back, not every query", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeApi.on("POST /workflows/inspect", { missingNodes: [], graph });
    const { client, onInspected } = drawPacks();
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await restart();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(onInspected).toHaveBeenCalledTimes(1);
    expect(invalidated.mock.calls.map(([f]) => f?.queryKey)).toEqual([["setup"], ["recipes"], ["machines"]]);
  });
});
