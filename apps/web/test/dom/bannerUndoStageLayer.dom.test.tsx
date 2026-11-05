import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { Banners } from "../../src/Banners";
import { useBanners } from "../../src/store";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A banner's Undo under the Stage's drawing layer (review 2026-11-05, #295 finding 14): with Paint and fix open, Ctrl+Z is
 * the mask's undo. The newest banner's Undo (a bin a few seconds ago) must not take it as well and bring the item back.
 */

describe("a banner's Ctrl+Z", () => {
  it("stands back while the Stage's drawing layer is up, and works again once it is gone", async () => {
    fakeApi.on("GET /settings", { machines: [] });
    fakeApi.on("GET /queue", { running: [], waiting: [], machines: [] });
    fakeApi.on("GET /downloads", { on: true, items: [], manager: { found: false }, via: "afflatus" });
    const run = vi.fn();
    draw(<Banners />);
    // the layer is the Stage's, outside the banners: added by hand, so the test can take it away again
    const stageLayer = document.body.appendChild(document.createElement("div"));
    stageLayer.setAttribute("data-stage-layer", "");
    act(() => useBanners.getState().push({ id: "zz-test-bin", tone: "good", title: "Binned · 1 item", action: { label: "Undo", undo: true, run } }));
    await waitFor(() => expect(document.body.textContent).toContain("Binned · 1 item"));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    stageLayer.remove();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
