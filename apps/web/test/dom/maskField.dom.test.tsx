import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MaskField } from "../../src/MaskField";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The form's mask field (MaskField.tsx) with its painter open: the painter's finds are the same while the form re-renders,
 * so click to mask and the detector keep what they hold, and the detector queues no other job (card #323).
 */

vi.mock("../../src/stageLayer/maskImage", async (real) => ({
  ...(await real<typeof import("../../src/stageLayer/maskImage")>()),
  // the picture as if loaded: happy-dom fetches no image
  loadImage: async () => ({ naturalWidth: 64, naturalHeight: 48 }) as HTMLImageElement,
}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A form round the field that re-renders at each click of its button, as one does on a queue event. */
function Form() {
  const [renders, setRenders] = useState(0);
  const [mask, setMask] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setRenders((n) => n + 1)}>Render again {renders}</button>
      <MaskField label="Mask" picture="zz-test-picture" value={mask} onChange={(v) => setMask(v ?? null)} />
    </>
  );
}

describe("the form's mask painter", () => {
  it("keeps the detector's search while the form re-renders: no second job, none cancelled", async () => {
    fakeApi.on("POST /assets/:id/find-mask", { job: "zz-test-find" });
    // still running: the search goes on while the form re-renders
    fakeApi.on("GET /assets/:id/find-mask/:job", { status: "running", masks: [] });
    fakeApi.on("POST /jobs/:id/cancel", { ok: true });
    draw(<Form />);
    fireEvent.click(screen.getByText("Paint the mask"));
    await screen.findByRole("dialog", { name: "Paint the mask" });
    await waitFor(() => expect(document.querySelector("[data-stage-layer]")).toBeTruthy());
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-picture/find-mask")).toHaveLength(1));
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByText(/^Render again/));
      await act(() => new Promise((r) => setTimeout(r, 20)));
    }
    expect(fakeApi.calls("POST", "/assets/zz-test-picture/find-mask")).toHaveLength(1);
    expect(fakeApi.calls("POST", "/jobs/zz-test-find/cancel")).toHaveLength(0);
  });
});
