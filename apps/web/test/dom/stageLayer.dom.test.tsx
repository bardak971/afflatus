import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useState } from "react";
import { Brush } from "lucide-react";
import { LayerToolbar } from "../../src/stageLayer/LayerToolbar";
import { StageLayer, useLayerKeys } from "../../src/stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "../../src/stageLayer/tools";
import { useMaskLayer, type MaskLayer } from "../../src/stageLayer/useMaskLayer";
import { ZoomPicture } from "../../src/viewer/ZoomPicture";
import { draw } from "./render";

/**
 * The Stage's drawing layer (stageLayer/StageLayer.tsx) over ZoomPicture: the pointer handed to the tool in the picture's
 * pixels, pans left to ZoomPicture, a pen's pressure, palms and pinches left out, the keys.
 */

beforeEach(() => {
  // the room 800 × 600 at the page's corner, and the picture as large: one screen pixel is one of the picture's
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => vi.restoreAllMocks());

const NATURAL = { w: 800, h: 600 };
const layer = () => document.querySelector<HTMLElement>("[data-stage-layer]")!;
const room = () => document.querySelector<HTMLElement>("[data-zoom-room]")!;

/** A tool that says what it was handed. */
function spyTool() {
  const seen: string[] = [];
  const tool: LayerTool = {
    id: "spy", key: "S", label: "Spy", icon: Brush, cursor: "crosshair",
    down: (p) => seen.push(`down ${Math.round(p.x)},${Math.round(p.y)} ${p.pen ? `pen ${p.pressure}` : "mouse"}${p.alt ? " alt" : ""}`),
    move: (p) => seen.push(`move ${Math.round(p.x)},${Math.round(p.y)}`),
    up: () => seen.push("up"),
    cancel: () => seen.push("cancel"),
  };
  return { seen, tool };
}

function Rig({ tool, panMode = "layer" }: { tool: LayerTool; panMode?: "layer" | "hand" }) {
  return <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode={panMode} overlay={(place) => <StageLayer place={place} tool={tool} />} />;
}

describe("the drawing layer", () => {
  it("hands a press, its moves and its release to the tool, in the picture's pixels", () => {
    const { seen, tool } = spyTool();
    draw(<Rig tool={tool} />);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 50, altKey: true });
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 60 });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 60 });
    // a move with nothing pressed is only the cursor's
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 300 });
    expect(seen).toEqual(["down 100,50 mouse alt", "move 120,60", "up"]);
  });

  it("leaves the middle button and Space to the pan, and a double-click does not zoom", () => {
    const { seen, tool } = spyTool();
    draw(<Rig tool={tool} />);
    fireEvent.pointerDown(layer(), { button: 1, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse" });
    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(room().className).toContain("cursor-grab");
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 2, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(layer(), { pointerId: 2, pointerType: "mouse" });
    fireEvent.keyUp(window, { code: "Space", key: " " });
    expect(room().className).not.toContain("cursor-grab");
    fireEvent.doubleClick(room(), { clientX: 400, clientY: 300 });
    expect(document.querySelector("[data-zoom-readout]")!.textContent).toBe("Fit · 100 %");
    expect(seen).toEqual([]);
  });

  it("with the Hand, a press pans and draws nothing", () => {
    const { seen, tool } = spyTool();
    draw(<Rig tool={tool} panMode="hand" />);
    expect(room().className).toContain("cursor-grab");
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    expect(seen).toEqual([]);
  });

  it("gives a pen's pressure, and leaves out a palm and a hand resting while the pen is used", () => {
    const { seen, tool } = spyTool();
    draw(<Rig tool={tool} />);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10, width: 60, height: 60 });
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 2, pointerType: "pen", pressure: 0.5, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(layer(), { pointerId: 2, pointerType: "pen" });
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 3, pointerType: "touch", clientX: 10, clientY: 10, width: 8, height: 8 });
    expect(seen).toEqual(["down 40,40 pen 0.5", "up"]);
  });

  it("a second finger is a pinch: the stroke the first began is taken back", () => {
    const { seen, tool } = spyTool();
    draw(<Rig tool={tool} />);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10, width: 8, height: 8 });
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 2, pointerType: "touch", clientX: 90, clientY: 90, width: 8, height: 8 });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "touch" });
    expect(seen).toEqual(["down 10,10 mouse", "cancel"]);
  });

  it("in a frame grown around the picture, says the picture's own pixels and places the picture in it", () => {
    const { seen, tool } = spyTool();
    // a frame of 1600 × 1200 around the 800 × 600 picture: fitted at half, the picture at its middle
    draw(<ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" canvas={{ w: 1600, h: 1200, x: 400, y: 300 }} overlay={(place) => <StageLayer place={place} tool={tool} />} />);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 });
    expect(seen).toEqual(["down -400,-300 mouse"]);
    const img = room().querySelector("img")!;
    expect(img.style.left).toBe("25%");
    expect(img.style.width).toBe("50%");
  });
});

describe("the mask layer", () => {
  let mask: MaskLayer | null = null;
  function MaskRig() {
    const m = useMaskLayer({ natural: NATURAL });
    mask = m;
    const items: ToolbarItem[] = [m.tools.brush, m.tools.eraser, m.tools.box, m.tools.lasso, "rule", m.tools.invert, HAND_TOOL];
    const [id, setId] = useState("brush");
    useLayerKeys({ items, onPick: setId, mask: m });
    const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === id) ?? null;
    return (
      <>
        <LayerToolbar items={items} active={id} onPick={setId} />
        <input aria-label="prompt" />
        <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode={id === "hand" ? "hand" : "layer"} overlay={(place) => <StageLayer place={place} tool={tool} mask={m} />} />
      </>
    );
  }
  const press = (x: number, y: number, to = { x, y }) => {
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse", clientX: to.x, clientY: to.y });
  };
  const pressed = () => [...document.querySelectorAll<HTMLElement>("[role=toolbar] [aria-pressed=true]")].map((b) => b.getAttribute("aria-label"));

  it("paints, undoes and redoes, says what it covers, and inverts", async () => {
    draw(<MaskRig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    expect(mask!.area).toBeNull();
    // a brush of 64 with a feather of 16: a dab at (100, 100) reaches 48 out
    press(100, 100);
    const a = mask!.area!;
    expect(a.x).toBeGreaterThan(50);
    expect(a.x).toBeLessThan(70);
    expect(mask!.soft).toBe(true);
    expect(mask!.steps).toBe(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(mask!.area).toBeNull();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(mask!.area).not.toBeNull();
    fireEvent.keyDown(window, { key: "x" });
    expect(mask!.area).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(mask!.steps).toBe(2);
  });

  it("picks tools and sizes the brush by their keys, but not while typing", async () => {
    draw(<MaskRig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    expect(pressed()).toEqual(["Soft brush"]);
    fireEvent.keyDown(window, { key: "b" });
    expect(pressed()).toEqual(["Box mask"]);
    fireEvent.keyDown(window, { key: "]" });
    expect(mask!.brush.size).toBeGreaterThan(64);
    fireEvent.keyDown(window, { key: "{", code: "BracketLeft", shiftKey: true });
    expect(mask!.brush.feather).toBe(12);
    fireEvent.keyDown(window, { key: "m" });
    expect(mask!.shown).toBe(false);
    const prompt = document.querySelector<HTMLInputElement>("input[aria-label=prompt]")!;
    fireEvent.keyDown(prompt, { key: "l" });
    expect(pressed()).toEqual(["Box mask"]);
  });

  it("fills a box, held square with Shift, and takes one away with Alt", async () => {
    draw(<MaskRig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    mask!.setBrush({ feather: 0 });
    fireEvent.keyDown(window, { key: "b" });
    press(100, 100, { x: 300, y: 200 });
    expect(mask!.area).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(mask!.soft).toBe(false);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 100, altKey: true });
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 200 });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse" });
    expect(mask!.area).toEqual({ x: 200, y: 100, w: 100, h: 100 });
  });

  it("fills round a lasso", async () => {
    draw(<MaskRig />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    mask!.setBrush({ feather: 0 });
    fireEvent.keyDown(window, { key: "l" });
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 100 });
    for (const [x, y] of [[300, 100], [300, 300], [100, 300]]) fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
    expect(document.querySelector("[data-stage-layer] polygon")).not.toBeNull();
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse" });
    expect(mask!.area).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });
});
