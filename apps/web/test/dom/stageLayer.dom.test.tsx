import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useMemo, useState } from "react";
import { Brush } from "lucide-react";
import { DetectOptions, FrameOptions, WandOptions } from "../../src/stageLayer/LayerStrip";
import { fillRect, newPlane } from "../../src/stageLayer/raster";
import { useClickTool, useDetectTool, useWandTool, type Find, type FindRequest, type FoundMask, type LoadMask, type LoadPixels } from "../../src/stageLayer/useFindTools";
import { LayerToolbar } from "../../src/stageLayer/LayerToolbar";
import { StageLayer, useLayerKeys } from "../../src/stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "../../src/stageLayer/tools";
import { useFrameTool, type FrameSides, type FrameTool } from "../../src/stageLayer/useFrameTool";
import { useMaskLayer, type MaskLayer } from "../../src/stageLayer/useMaskLayer";
import { FIT, fitted, placed } from "../../src/viewer/zoom";
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
    expect(pressed()).toEqual(["Rectangle mask"]);
    fireEvent.keyDown(window, { key: "]" });
    expect(mask!.brush.size).toBeGreaterThan(64);
    fireEvent.keyDown(window, { key: "{", code: "BracketLeft", shiftKey: true });
    expect(mask!.brush.feather).toBe(12);
    fireEvent.keyDown(window, { key: "m" });
    expect(mask!.shown).toBe(false);
    const prompt = document.querySelector<HTMLInputElement>("input[aria-label=prompt]")!;
    fireEvent.keyDown(prompt, { key: "l" });
    expect(pressed()).toEqual(["Rectangle mask"]);
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

  it("keeps what was painted when the caller hands a new {w, h} at every render", async () => {
    let fresh: MaskLayer | null = null;
    function Fresh() {
      // a new object each render, as an inline literal is
      const m = useMaskLayer({ natural: { w: NATURAL.w, h: NATURAL.h } });
      fresh = m;
      const [, bump] = useState(0);
      return (
        <>
          <button type="button" onClick={() => bump((n) => n + 1)}>again</button>
          <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" overlay={(place) => <StageLayer place={place} tool={m.tools.brush} mask={m} />} />
        </>
      );
    }
    draw(<Fresh />);
    await vi.waitFor(() => expect(fresh!.ready).toBe(true));
    press(100, 100);
    expect(fresh!.area).not.toBeNull();
    for (let i = 0; i < 3; i++) fireEvent.click(document.querySelector("button")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(fresh!.area).not.toBeNull();
    expect(fresh!.steps).toBe(1);
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

describe("the outpaint frame", () => {
  let said: FrameSides[] = [];
  let frame: FrameTool | null = null;
  function FrameRig() {
    const f = useFrameTool({ natural: NATURAL, onSides: (s) => said.push(s) });
    frame = f;
    return (
      <>
        <FrameOptions frame={f} natural={NATURAL} />
        <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" canvas={f.canvas} overlay={(place) => <StageLayer place={place} tool={f.tool} />} />
      </>
    );
  }
  /** Where a point of the picture is on the screen, in the frame the Stage fits now. */
  const onScreen = (x: number, y: number) => {
    const c = frame!.canvas!;
    const fit = fitted({ w: c.w, h: c.h }, { w: 800, h: 600 });
    const shown = placed(FIT, fit, { w: 800, h: 600 });
    const k = fit.w / c.w;
    return { clientX: shown.left + (x + c.x) * k, clientY: shown.top + (y + c.y) * k };
  };
  beforeEach(() => {
    said = [];
  });

  it("drags a corner out, snapped, and says the sides when let go", () => {
    draw(<FrameRig />);
    const from = onScreen(0, 0);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", ...from });
    // the Stage's frame is held still while dragging: the same sums place the pointer
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", ...onScreen(-200, -120) });
    expect(said).toEqual([]);
    expect(document.querySelectorAll("[data-handle]").length).toBe(8);
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse" });
    // 800 × 600: 200 out on the left makes 1000, snapped to 1024 (+224); 120 up makes 720, snapped to 704 (+104)
    expect(said).toEqual([{ shape: "Custom", padLeft: 224, padTop: 104, padRight: 0, padBottom: 0 }]);
    expect(document.body.textContent).toContain("800 × 600 → 1024 × 704");
  });

  it("a press away from the frame's edges does nothing", () => {
    draw(<FrameRig />);
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", ...onScreen(400, 300) });
    fireEvent.pointerMove(layer(), { pointerId: 1, pointerType: "mouse", ...onScreen(100, 100) });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse" });
    expect(said).toEqual([]);
    expect(frame!.pads).toEqual({ padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 });
  });

  it("brings the picture to a shape by its chip, and back by the reset", () => {
    draw(<FrameRig />);
    fireEvent.click([...document.querySelectorAll<HTMLElement>("[role=radio]")].find((b) => b.textContent === "16:9")!);
    const last = said[said.length - 1]!;
    // both sizes on the 64 px step: 600 is not, so the frame is 640 high, about 16:9 at 1088 wide
    expect(800 + last.padLeft + last.padRight).toBe(1088);
    expect(600 + last.padTop + last.padBottom).toBe(640);
    expect(last.padTop).toBe(20);
    fireEvent.click(document.querySelector<HTMLElement>('[aria-label="Back to the picture\'s edges"]')!);
    expect(said[said.length - 1]).toEqual({ shape: "Custom", padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 });
  });
});

describe("the tools that find a mask", () => {
  let mask: MaskLayer | null = null;
  let asked: FindRequest[] = [];
  /** A found mask: the box filled, at the plane's size. */
  const boxMask = (box: { x: number; y: number; w: number; h: number }): LoadMask => async (_asset, w, h) => {
    const p = newPlane(w, h);
    fillRect(p, box, 0, "add");
    return p;
  };
  const BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
    a: { x: 100, y: 100, w: 100, h: 100 },
    b: { x: 300, y: 100, w: 200, h: 200 },
    face: { x: 320, y: 120, w: 40, h: 40 },
  };
  const load: LoadMask = (asset, w, h) => boxMask(BOXES[asset]!)(asset, w, h);
  function FindRig({ find, pixels }: { find: Find; pixels?: LoadPixels }) {
    const m = useMaskLayer({ natural: NATURAL, start: { size: 10, feather: 0 } });
    mask = m;
    const [id, setId] = useState("click");
    const click = useClickTool({ mask: m, natural: NATURAL, find, load, active: id === "click" });
    const detect = useDetectTool({ mask: m, natural: NATURAL, find, load, active: id === "detect" });
    const wandTool = useWandTool({ mask: m, natural: NATURAL, src: "/api/assets/zz-test/file", pixels });
    const items: ToolbarItem[] = [m.tools.brush, wandTool.tool, click.tool, detect.tool];
    useLayerKeys({ items, onPick: setId, mask: m });
    const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === id) ?? null;
    return (
      <>
        {id === "detect" && <DetectOptions detect={detect} />}
        {id === "wand" && <WandOptions wand={wandTool} />}
        <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" overlay={(place) => <StageLayer place={place} tool={tool} mask={m} />} />
      </>
    );
  }
  const click = (x: number, y: number, keys: { shiftKey?: boolean; altKey?: boolean } = {}) => {
    fireEvent.pointerDown(layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, ...keys });
    fireEvent.pointerUp(layer(), { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, ...keys });
  };
  beforeEach(() => {
    asked = [];
  });

  it("click to mask: each click asks for all the points, and its mask takes the place of the last one's", async () => {
    // a first point finds a; a second finds b (SAM's answer for both points)
    const find: Find = async (req) => {
      asked.push(req);
      return [{ asset: asked.length === 1 ? "a" : "b", box: BOXES.a! }];
    };
    draw(<FindRig find={find} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    click(150, 150);
    await vi.waitFor(() => expect(mask!.area).toEqual(BOXES.a));
    click(350, 150, { shiftKey: true });
    await vi.waitFor(() => expect(mask!.area).toEqual(BOXES.b));
    expect(asked).toEqual([
      { way: "points", add: [{ x: 150, y: 150 }], remove: [] },
      { way: "points", add: [{ x: 150, y: 150 }], remove: [{ x: 350, y: 150 }] },
    ]);
    expect(document.querySelectorAll("[data-stage-layer] .bg-good, [data-stage-layer] .bg-warn").length).toBe(2);
    // the replaced answer is one step: undo leaves nothing
    expect(mask!.steps).toBe(1);
  });

  it("click to mask: a late answer to older points is dropped, and nothing found takes the last mask back", async () => {
    let slow: (v: FoundMask[]) => void = () => {};
    const find: Find = (req) => {
      asked.push(req);
      if (asked.length === 1) return new Promise((r) => (slow = r));
      if (asked.length === 2) return Promise.resolve([{ asset: "b", box: BOXES.b! }]);
      return Promise.resolve([]);
    };
    draw(<FindRig find={find} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    click(150, 150);
    // the second click once the first was asked (clicks closer together are one ask)
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    click(350, 150);
    await vi.waitFor(() => expect(mask!.area).toEqual(BOXES.b));
    slow([{ asset: "a", box: BOXES.a! }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mask!.area).toEqual(BOXES.b);
    click(600, 500);
    await vi.waitFor(() => expect(mask!.area).toBeNull());
  });

  it("click to mask: quick clicks are one ask, and an ask a newer one replaced is given up (its job cancelled)", async () => {
    const signals: AbortSignal[] = [];
    const find: Find = (req, signal) => {
      asked.push(req);
      signals.push(signal!);
      // the first never answers: it is the one given up
      return asked.length === 1 ? new Promise(() => {}) : Promise.resolve([{ asset: "b", box: BOXES.b! }]);
    };
    draw(<FindRig find={find} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    click(150, 150);
    click(160, 150);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toEqual({ way: "points", add: [{ x: 150, y: 150 }, { x: 160, y: 150 }], remove: [] });
    click(350, 150);
    await vi.waitFor(() => expect(mask!.area).toEqual(BOXES.b));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("the detector: faces looked for when picked, a box clicked into the mask and out again", async () => {
    const find: Find = async (req) => {
      asked.push(req);
      return req.way === "detect" && req.what === "face" ? [{ asset: "face", box: BOXES.face! }] : [];
    };
    draw(<FindRig find={find} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    fireEvent.keyDown(window, { key: "d" });
    await vi.waitFor(() => expect(document.querySelector("[data-found]")).not.toBeNull());
    expect(asked).toEqual([{ way: "detect", what: "face" }]);
    expect(document.body.textContent).toContain("Face · 1");
    click(5, 5);
    expect(mask!.area).toBeNull();
    click(340, 140);
    await vi.waitFor(() => expect(mask!.area).toEqual(BOXES.face));
    click(340, 140);
    await vi.waitFor(() => expect(mask!.area).toBeNull());
    fireEvent.click([...document.querySelectorAll<HTMLElement>("[role=radio]")].find((b) => b.textContent === "Hands")!);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toEqual({ way: "detect", what: "hands" });
  });

  it("the detector on another picture (a version flipped to): the boxes found on the one before are gone, looked for again", async () => {
    let on = "zz-test-a";
    const find = (picture: string): Find => async (req) => {
      asked.push(req);
      return picture === "zz-test-a" ? [{ asset: "face", box: BOXES.face! }] : [{ asset: "a", box: BOXES.a! }];
    };
    function Flip() {
      const [picture, setPicture] = useState(on);
      const m = useMaskLayer({ natural: NATURAL, start: { size: 10, feather: 0 } });
      mask = m;
      const f = useMemo(() => find(picture), [picture]);
      const detect = useDetectTool({ mask: m, natural: NATURAL, find: f, load, active: true });
      return (
        <>
          <button type="button" onClick={() => setPicture((on = "zz-test-b"))}>flip</button>
          <ZoomPicture src="/api/assets/zz-test/file" natural={NATURAL} panMode="layer" overlay={(place) => <StageLayer place={place} tool={detect.tool} mask={m} />} />
        </>
      );
    }
    draw(<Flip />);
    await vi.waitFor(() => expect(document.querySelector("[data-found]")).not.toBeNull());
    const box = () => (document.querySelector<HTMLElement>("[data-found]")!.style.left);
    const before = box();
    fireEvent.click(document.querySelector("button")!);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    await vi.waitFor(() => expect(box()).not.toBe(before));
    expect(document.querySelectorAll("[data-found]")).toHaveLength(1);
  });

  it("the wand: a click takes the place of its last, Shift adds, Alt takes away", async () => {
    // the picture: its left half red, its right half blue
    const pixels: LoadPixels = async (w, h) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set(i % w < w / 2 ? [220, 20, 20, 255] : [20, 20, 220, 255], i * 4);
      return rgba;
    };
    draw(<FindRig find={async () => []} pixels={pixels} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    fireEvent.keyDown(window, { key: "w" });
    expect(document.body.textContent).toContain("Tolerance");
    click(100, 100);
    await vi.waitFor(() => expect(mask!.area).toEqual({ x: 0, y: 0, w: 400, h: 600 }));
    click(700, 100);
    await vi.waitFor(() => expect(mask!.area).toEqual({ x: 400, y: 0, w: 400, h: 600 }));
    click(100, 100, { shiftKey: true });
    await vi.waitFor(() => expect(mask!.area).toEqual({ x: 0, y: 0, w: 800, h: 600 }));
    click(700, 100, { altKey: true });
    await vi.waitFor(() => expect(mask!.area).toEqual({ x: 0, y: 0, w: 400, h: 600 }));
  });

  it("a wand click that changes nothing is no step: the next click does not take the user's stroke back", async () => {
    const pixels: LoadPixels = async (w, h) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set(i % w < w / 2 ? [220, 20, 20, 255] : [20, 20, 220, 255], i * 4);
      return rgba;
    };
    draw(<FindRig find={async () => []} pixels={pixels} />);
    await vi.waitFor(() => expect(mask!.ready).toBe(true));
    // a brush stroke on the blue half, then undone and redone, so a redo would be lost too if a no-op cleared it
    fireEvent.keyDown(window, { key: "p" });
    click(600, 300);
    expect(mask!.steps).toBe(1);
    fireEvent.keyDown(window, { key: "w" });
    // Alt on the red half, which nothing masks: it takes nothing away
    click(100, 100, { altKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(mask!.steps).toBe(1);
    // a plain click replaces the wand's last step only: there is none, so the stroke stays
    click(100, 100);
    await vi.waitFor(() => expect(mask!.area?.w).toBeGreaterThan(400));
    expect(mask!.steps).toBe(2);
    expect(mask!.redos).toBe(0);
  });
});
