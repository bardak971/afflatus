import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { Compare } from "../../src/viewer/Compare";
import { ZoomPicture } from "../../src/viewer/ZoomPicture";
import { draw } from "./render";

/** Looking closely (viewer/ZoomPicture.tsx): the wheel, a drag, a double-click; Compare's two pictures in step. */

const picture = (id: string, side: number) => ({ id, name: `zz-test ${id}`, kind: "image", mime: "image/png", width: side, height: side }) as unknown as Asset;
// an Upscale 2x beside its source
const SOURCE = picture("zz-test-source", 1024);
const RESULT = picture("zz-test-result", 2048);

beforeEach(() => {
  // every room 800 × 600, measured at once (the page lays nothing out here)
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => vi.restoreAllMocks());

/** The rooms that zoom, in the order drawn. */
const rooms = () => [...document.querySelectorAll<HTMLElement>("[data-zoom-room]")];
/** A room's picture layer's transform: where and how large it is drawn. */
const transformOf = (room: HTMLElement) => room.querySelector<HTMLElement>("div[style*=transform]")?.style.transform ?? "";
const scaleOf = (room: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(transformOf(room))?.[1] ?? 1);
const readouts = () => [...document.querySelectorAll<HTMLElement>("[data-zoom-readout]")].map((b) => b.textContent);

describe("a picture looked at closely", () => {
  it("zooms with the wheel, goes to 1:1 and back on a double-click, and waits for a double-click before its click", async () => {
    vi.useFakeTimers();
    try {
      const pick = vi.fn();
      draw(<ZoomPicture src="/api/assets/zz-test-source/file" natural={{ w: 1024, h: 1024 }} onPick={pick} pickLabel="Copy the picture" />);
      const [room] = rooms();
      expect(readouts()).toEqual(["Fit · 59 %"]);
      fireEvent.wheel(room!, { deltaY: -100, clientX: 400, clientY: 300 });
      expect(scaleOf(room!)).toBeCloseTo(Math.exp(0.2), 3);
      fireEvent.doubleClick(room!, { clientX: 400, clientY: 300 });
      expect(readouts()).toEqual(["Fit · 59 %"]);
      fireEvent.doubleClick(room!, { clientX: 400, clientY: 300 });
      expect(readouts()).toEqual(["100 %"]);
      // the two clicks of a double-click copy nothing
      const img = screen.getByRole("button", { name: "Copy the picture" });
      fireEvent.click(img, { detail: 1 });
      fireEvent.click(img, { detail: 2 });
      fireEvent.doubleClick(img);
      act(() => vi.advanceTimersByTime(400));
      expect(pick).not.toHaveBeenCalled();
      // one click does, a moment later
      fireEvent.click(img, { detail: 1 });
      act(() => vi.advanceTimersByTime(400));
      expect(pick).toHaveBeenCalledTimes(1);
      // the readout fits it whole again
      fireEvent.click(screen.getByText("Fit · 59 %"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Compare's two pictures", () => {
  const rig = () => draw(<Compare pinned={SOURCE} other={RESULT} onSwap={() => {}} onClose={() => {}} />);

  it("zoom and pan in step side by side, each saying its own pixels", () => {
    rig();
    const [left, right] = rooms();
    fireEvent.wheel(right!, { deltaY: -100, clientX: 100, clientY: 100 });
    fireEvent.wheel(right!, { deltaY: -100, clientX: 100, clientY: 100 });
    expect(scaleOf(left!)).toBeCloseTo(Math.exp(0.4), 3);
    expect(transformOf(left!)).toBe(transformOf(right!));
    // the result has twice the pixels: shown at the same size, they are half as large
    const [a, b] = readouts().map((t) => Number(/\d+/.exec(t!)![0]));
    expect(b).toBe(Math.round(a! / 2));
    // a drag on the left one moves the right one too
    const before = transformOf(right!);
    fireEvent.pointerDown(left!, { button: 0, pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(left!, { pointerId: 1, clientX: 340, clientY: 320 });
    fireEvent.pointerUp(left!, { pointerId: 1, clientX: 340, clientY: 320 });
    expect(transformOf(right!)).not.toBe(before);
    expect(transformOf(left!)).toBe(transformOf(right!));
  });

  it("keep the zoom in the wipe, where both layers move together and the handle still moves the line", () => {
    rig();
    const [left] = rooms();
    fireEvent.doubleClick(left!, { clientX: 400, clientY: 300 });
    expect(readouts()[0]).toBe("100 %");
    fireEvent.click(screen.getByRole("button", { name: /Wipe/ }));
    // one room now, both pictures drawn at the same place and size in it
    const [box] = rooms();
    const layers = [...box!.querySelectorAll<HTMLElement>("div[style*=transform]")];
    expect(layers).toHaveLength(2);
    expect(layers[0]!.style.transform).toBe(layers[1]!.style.transform);
    expect(scaleOf(box!)).toBeGreaterThan(1);
    // zoomed in, a drag on the pictures pans them, the line stays
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.pointerDown(box!, { button: 0, pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(box!, { pointerId: 2, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(box!, { pointerId: 2 });
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    // the handle with the keys still moves it
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
    expect(slider.getAttribute("aria-valuenow")).toBe("40");
  });
});
