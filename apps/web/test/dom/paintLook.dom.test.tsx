import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { LayerStrip, MaskEye } from "../../src/stageLayer/LayerStrip";
import { LayerToolbar } from "../../src/stageLayer/LayerToolbar";
import { MASK_VIEWS, nextView } from "../../src/stageLayer/maskView";
import { StageLayer, useLayerKeys } from "../../src/stageLayer/StageLayer";
import { HAND_TOOL, isTool, type LayerTool, type ToolbarItem } from "../../src/stageLayer/tools";
import { useMaskLayer, type MaskLayer } from "../../src/stageLayer/useMaskLayer";
import { ZoomPicture } from "../../src/viewer/ZoomPicture";
import { draw } from "./render";

/**
 * Paint and fix's look (owner's picks on mock-0.10-paint-look, 2026-11-05): the eye's four views of the mask, the tool in
 * hand named beside the bar, and the mask sent to ComfyUI left as it was whatever is shown.
 */

/** What each canvas was last given, and the PNGs asked of them: a page that draws (jsdom has no 2D context of its own). */
const drawn = new Map<HTMLCanvasElement, Uint8ClampedArray>();
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
  Element.prototype.setPointerCapture ??= () => {};
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const canvas = this;
    return {
      // a whole-canvas put is what pngOf makes; the layer's own puts are parts of it
      putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => {
        if (img.width === canvas.width && img.height === canvas.height) drawn.set(canvas, img.data.slice());
      },
    } as unknown as RenderingContext;
  });
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, done: BlobCallback) {
    done(new Blob([(drawn.get(this) ?? new Uint8ClampedArray()) as Uint8ClampedArray<ArrayBuffer>], { type: "image/png" }));
  };
});
afterEach(() => {
  drawn.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NATURAL = { w: 200, h: 150 };
const layer = () => document.querySelector<HTMLElement>("[data-stage-layer]")!;
const canvas = () => document.querySelector<HTMLCanvasElement>("canvas[data-mask-view]")!;

let mask: MaskLayer | null = null;
function Rig() {
  const m = useMaskLayer({ natural: NATURAL, start: { size: 40, feather: 16 } });
  mask = m;
  const items: ToolbarItem[] = [{ group: "Mask" }, m.tools.brush, m.tools.eraser, m.tools.box, m.tools.invert, { group: "View" }, HAND_TOOL];
  const [id, setId] = useState("brush");
  useLayerKeys({ items, onPick: setId, mask: m });
  const tool = items.find((t): t is LayerTool => isTool(t) && t.id === id) ?? null;
  return (
    <>
      <LayerStrip title="Paint and fix"><MaskEye mask={m} /></LayerStrip>
      <LayerToolbar items={items} active={id} onPick={setId} named />
      <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" overlay={(place) => <StageLayer place={place} tool={tool} mask={m} />} />
    </>
  );
}

/** A soft dab of the brush at the picture's (x, y): one screen pixel is one of the picture's at this room's fit. */
function dab(x: number, y: number) {
  const img = { left: 0, top: 0, k: 800 / 200 };
  const at = { clientX: img.left + x * img.k, clientY: img.top + (y + 0) * img.k };
  fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", ...at });
  fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse", ...at });
}

/** The PNG sent to ComfyUI, as the pixels put into it. */
async function sent(): Promise<Uint8ClampedArray> {
  const blob = await mask!.png();
  return new Uint8ClampedArray(await blob.arrayBuffer());
}

describe("the eye", () => {
  it("cycles Tint, Spotlight, B&W and Off, by M or a click, each view its own filter over the same canvas", async () => {
    draw(<Rig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    expect(MASK_VIEWS).toEqual(["tint", "spot", "bw", "off"]);
    const eye = () => document.querySelector<HTMLElement>("[data-mask-eye]")!;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(`${mask!.view} ${eye().textContent} ${canvas().style.filter || "none"} ${canvas().style.opacity}`);
      if (i % 2) fireEvent.click(eye());
      else fireEvent.keyDown(window, { key: "m" });
    }
    expect(seen.map((s) => s.replace(/#[^-]+-/, "#…-"))).toEqual([
      "tint Tint url(#…-tint) 1",
      "spot Spotlight url(#…-spot) 1",
      "bw B&W url(#…-bw) 1",
      "off Off none 0",
    ]);
    // round to the first again
    expect(mask!.view).toBe("tint");
    // presses quicker than a render (M held) each step one further
    act(() => {
      for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", repeat: i > 0 }));
    });
    expect(mask!.view).toBe("off");
    fireEvent.keyDown(window, { key: "m" });
    expect(nextView("off")).toBe("tint");
    // the filters the views name are on the page, one set for this layer
    for (const v of ["tint", "spot", "bw"]) expect(document.querySelectorAll(`filter[id$="-${v}"]`)).toHaveLength(1);
  });

  it("says M on its tip, and the keys sheet says what M does in both places", async () => {
    draw(<Rig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    expect(document.querySelector("[data-mask-eye]")!.getAttribute("data-tip-keys")).toBe("M");
    const { PLACES } = await import("../../src/keys/table");
    for (const place of ["mask", "paint"]) {
      const rows = PLACES.find((p) => p.id === place)!.groups.flatMap((g) => g.rows);
      expect(rows.filter((r) => r.keys === "M").map((r) => r.does)).toEqual(["Show the mask: Tint, Spotlight, B&W, Off"]);
    }
  });
});

describe("the toolbar", () => {
  it("names the tool in hand with its key beside the bar, follows the pick, and draws the groups' captions", async () => {
    draw(<Rig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    const flag = () => document.querySelector("[data-tool-flag]")?.textContent;
    expect(flag()).toBe("Soft brushP");
    fireEvent.keyDown(window, { key: "e" });
    expect(flag()).toBe("EraserE");
    fireEvent.click(screen.getByRole("button", { name: "Rectangle mask" }));
    expect(flag()).toBe("Rectangle maskB");
    // invert acts at once: it is never the tool in hand, and the name stays on the one that is
    fireEvent.click(screen.getByRole("button", { name: "Invert the mask" }));
    expect(flag()).toBe("Rectangle maskB");
    expect([...document.querySelectorAll("[data-tool-group]")].map((g) => g.textContent)).toEqual(["Mask", "View"]);
    // icons only: each tool's name is its label and tip, not text on the bar
    expect(screen.getByRole("toolbar").textContent).toBe("MaskView");
  });

  it("puts no name beside the bar where it is not asked (the form's painter, the regions)", () => {
    const items: ToolbarItem[] = [HAND_TOOL];
    draw(<LayerToolbar items={items} active="hand" onPick={() => {}} />);
    expect(document.querySelector("[data-tool-flag]")).toBeNull();
  });
});

describe("the mask sent", () => {
  it("is the painted grey levels whatever view shows it", async () => {
    draw(<Rig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    dab(100, 75);
    const first = await sent();
    // the picture's own size, grey (r = g = b), opaque, with a soft edge: levels between black and white
    expect(first.length).toBe(NATURAL.w * NATURAL.h * 4);
    let soft = 0;
    for (let i = 0; i < first.length; i += 4) {
      expect(first[i + 1]).toBe(first[i]);
      expect(first[i + 2]).toBe(first[i]);
      expect(first[i + 3]).toBe(255);
      if (first[i]! > 0 && first[i]! < 255) soft++;
    }
    expect(soft).toBeGreaterThan(0);
    expect(first[(75 * NATURAL.w + 100) * 4]).toBe(255);
    for (const _ of MASK_VIEWS) {
      fireEvent.keyDown(window, { key: "m" });
      expect([...(await sent())]).toEqual([...first]);
    }
  });
});
