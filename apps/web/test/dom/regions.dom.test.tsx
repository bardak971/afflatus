import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { RecipeInfo } from "../../src/api";
import { useFormTarget } from "../../src/formTarget";
import { Form } from "../../src/RecipeForm";
import { DRAG_PERSON } from "../../src/regions/CastStrip";
import { RegionsField } from "../../src/regions/RegionsField";
import { RegionsStage } from "../../src/regions/RegionsStage";
import type { RegionsSpec, RegionValue } from "../../src/regions/types";
import { useRegionsStage, type RegionsHere } from "../../src/regions/useRegionsStage";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Regions on the Stage (card #271): boxes drawn, moved, resized and removed over the empty frame, a cast person dropped on
 * a box or on the frame, a box and its row of the form picked together, and a model that takes none saying why.
 */

beforeEach(() => {
  // the room 800 × 600 at the page's corner, the frame as large: one screen pixel is one of the frame's
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} unobserve() {} });
  Element.prototype.setPointerCapture ??= () => {};
  fakeApi.on("GET /entities", { items: [{ id: "zz-test-mira", kind: "person", name: "Mira", updatedAt: "2026-11-04T10:00:00Z", def: { pictures: [], voice: null, tags: "red hair", sentence: "", models: {}, outfits: [] } }] });
});
afterEach(() => vi.restoreAllMocks());

const SDXL: RegionsSpec = { id: "regions", type: "regions", label: "Regions", max: 8, lora: "scoped" };
const SIZE = { w: 800, h: 600 };
const layer = () => document.querySelector<HTMLElement>("[data-stage-layer]")!;
const boxes = () => [...document.querySelectorAll<HTMLElement>("[data-region]")];
const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) => fireEvent[type](layer(), { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
const drag = (from: [number, number], to: [number, number]) => {
  pointer("pointerDown", ...from);
  pointer("pointerMove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer("pointerMove", ...to);
  pointer("pointerUp", ...to);
};

/** The Stage and the form's card over one list of regions, as the Create panel and the draft's Stage share it. */
function Rig({ start = [], spec = SDXL, off, onRegions }: { start?: RegionValue[]; spec?: RegionsSpec | null; off?: RegionsHere["off"]; onRegions?(r: RegionValue[]): void }) {
  const [regions, setRegions] = useState<RegionValue[]>(start);
  const set = (r: RegionValue[]) => {
    setRegions(r);
    onRegions?.(r);
  };
  const here: RegionsHere = { spec, off, regions, set, size: SIZE, family: "sdxl", draftId: "zz-test-draft" };
  return (
    <>
      <RegionsStage here={here} />
      <RegionsField spec={spec} absent={off} value={regions} onChange={set} family={undefined} model={undefined} loraOptions={[]} recipe="zz-test.t2i" stored={undefined} onDraw={() => {}} />
    </>
  );
}

const around = (v: number, to: number) => expect(v).toBeCloseTo(to, 2);

describe("the region tools", () => {
  it("draw a box with B, keep it in parts of the frame, and pick it", async () => {
    let now: RegionValue[] = [];
    draw(<Rig onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    fireEvent.keyDown(window, { key: "b" });
    drag([100, 100], [300, 400]);
    expect(now).toHaveLength(1);
    const b = now[0]!.box;
    around(b.x, 100 / 800);
    around(b.y, 100 / 600);
    around(b.w, 200 / 800);
    around(b.h, 300 / 600);
    expect(useRegionsStage.getState().selected).toBe(now[0]!.id);
    // its chip says its number
    expect(document.querySelector("[data-region-chip]")!.textContent).toBe("1");
  });

  it("move a box with V and resize it by a handle; a click is not a box", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, prompt: "a lamp" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    fireEvent.keyDown(window, { key: "v" });
    // pressed inside (x 200..400, y 150..300) and dragged 80 px right
    drag([300, 200], [380, 200]);
    around(now[0]!.box.x, 0.35);
    around(now[0]!.box.w, 0.25);
    // its bottom right handle, at (480, 300) now, dragged 40 px further out
    drag([480, 300], [520, 340]);
    around(now[0]!.box.x + now[0]!.box.w, 0.65);
    around(now[0]!.box.y + now[0]!.box.h, 340 / 600);
    // with B, a click on nothing draws nothing
    fireEvent.keyDown(window, { key: "b" });
    drag([700, 50], [702, 51]);
    expect(now).toHaveLength(1);
  });

  it("remove the box picked with Del, and let it go with Esc", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, prompt: "" }, { id: "r2", box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, prompt: "" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    act(() => useRegionsStage.getState().select("r2"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRegionsStage.getState().selected).toBeNull();
    act(() => useRegionsStage.getState().select("r1"));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(now.map((r) => r.id)).toEqual(["r2"]);
  });

  it("leave a box picked when Esc closes a list or a popover over the Stage (card #310)", async () => {
    const now: RegionValue[] = [{ id: "r1", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, prompt: "" }];
    draw(<Rig start={now} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    act(() => useRegionsStage.getState().select("r1"));
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useRegionsStage.getState().selected).toBe("r1");
    } finally {
      menu.remove();
    }
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRegionsStage.getState().selected).toBeNull();
  });

  it("keep each box in its place when the form's size changes", async () => {
    const start = [{ id: "r1", box: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, prompt: "" }];
    const one = draw(<Rig start={start} />);
    await waitFor(() => expect(boxes()).toHaveLength(1));
    const before = boxes()[0]!.style.cssText;
    one.unmount();
    // the same box on a frame of another shape: the same parts of it
    const here: RegionsHere = { spec: SDXL, regions: start, set: () => {}, size: { w: 832, h: 1216 }, family: "sdxl", draftId: "d" };
    draw(<RegionsStage here={here} />);
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(boxes()[0]!.style.left).toBe("25%");
    expect(boxes()[0]!.style.top).toBe("50%");
    expect(boxes()[0]!.style.width).toBe("50%");
    expect(before).toContain("left: 25%");
  });
});

describe("a box and its row", () => {
  it("are picked together, from the Stage or from the form", async () => {
    const start = [{ id: "r1", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, prompt: "a lamp" }, { id: "r2", box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, prompt: "a cat" }];
    draw(<Rig start={start} />);
    await waitFor(() => expect(boxes()).toHaveLength(2));
    fireEvent.keyDown(window, { key: "v" });
    // the second box pressed on the Stage: its row is the current one
    drag([600, 450], [600, 450]);
    const row = (id: string) => document.querySelector(`[data-region-row="${id}"]`)!;
    expect(row("r2").getAttribute("aria-current")).toBe("true");
    expect(row("r1").getAttribute("aria-current")).toBeNull();
    // the first row picked in the form: its box shows its handles
    fireEvent.pointerDown(row("r1"));
    await waitFor(() => expect(document.querySelector("[data-region='r1']")!.getAttribute("data-selected")).toBe("true"));
    expect(document.querySelectorAll("[data-region='r1'] [data-handle]")).toHaveLength(8);
    expect(document.querySelector("[data-region='r2']")!.getAttribute("data-selected")).toBeNull();
  });
});

describe("a cast person typed with @", () => {
  it("goes on the region, the @name taken out of its words", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, prompt: "" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    const box = await screen.findByRole("textbox", { name: "Region 1: its prompt" });
    fireEvent.change(box, { target: { value: "@mi" } });
    (box as HTMLTextAreaElement).setSelectionRange(3, 3);
    fireEvent.select(box);
    expect(await screen.findByRole("option", { name: /Mira/ })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(now[0]!.cast).toBe("zz-test-mira");
    expect(now[0]!.prompt).toBe("");
  });
});

describe("a cast person dropped", () => {
  const dropAt = (x: number, y: number) => {
    const target = layer().closest("[data-zoom-room]")!.parentElement!;
    const dataTransfer = { types: [DRAG_PERSON], getData: (t: string) => (t === DRAG_PERSON ? "zz-test-mira" : ""), dropEffect: "none" };
    // happy-dom's drag events are plain events, with no pointer: where it is is put on them as a browser's carry it
    for (const kind of ["dragOver", "drop"] as const) {
      const ev = createEvent[kind](target, { dataTransfer });
      Object.defineProperties(ev, { clientX: { value: x }, clientY: { value: y } });
      fireEvent(target, ev);
    }
  };

  it("on a box sets who it is", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "holding a cup" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    dropAt(600, 300);
    expect(now).toHaveLength(1);
    expect(now[0]!.cast).toBe("zz-test-mira");
    expect(now[0]!.prompt).toBe("holding a cup");
    // the row says who is in it
    expect(await screen.findByText("@Mira")).toBeTruthy();
  });

  it("on a text box (MOSS) makes a box of their own: a text box draws letters, not a person (card #300)", async () => {
    const MOSS: RegionsSpec = { ...SDXL, lora: "global", kinds: true };
    let now: RegionValue[] = [{ id: "t", box: { x: 0, y: 0, w: 1, h: 1 }, prompt: "serif", kind: "text", text: "OPEN" }];
    draw(<Rig start={now} spec={MOSS} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    dropAt(400, 300);
    expect(now).toHaveLength(2);
    expect(now[0]!.cast).toBeUndefined();
    expect(now[1]).toMatchObject({ cast: "zz-test-mira", kind: "object" });
  });

  it("deleted since is said on its row, with a way to take them off (card #300)", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "", cast: "zz-test-gone" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    expect(await screen.findByText("@unknown person")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take the deleted person off region 1" }));
    expect(now[0]!.cast).toBeUndefined();
  });

  it("on empty canvas makes a box where it lands", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "" }];
    draw(<Rig start={now} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(layer()).toBeTruthy());
    dropAt(160, 300);
    expect(now).toHaveLength(2);
    const made = now[1]!;
    expect(made.cast).toBe("zz-test-mira");
    around(made.box.x + made.box.w / 2, 0.2);
    around(made.box.y + made.box.h / 2, 0.5);
    expect(useRegionsStage.getState().selected).toBe(made.id);
  });
});

describe("a model that takes no regions", () => {
  const off = { id: "regions", label: "Regions", why: "Qwen 2.1 has no regional prompting" };

  it("shows the boxes the draft keeps greyed on the Stage, with why, and draws none", async () => {
    let now: RegionValue[] = [{ id: "r1", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, prompt: "a lamp" }];
    draw(<Rig start={now} spec={null} off={off} onRegions={(r) => (now = r)} />);
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(screen.getAllByText(/Qwen 2\.1 has no regional prompting/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Box: draw a region" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "b" });
    drag([500, 400], [700, 550]);
    act(() => useRegionsStage.getState().select("r1"));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(now).toHaveLength(1);
  });

  it("is said with why under Not shown now, with the boxes the draft keeps on another model", async () => {
    fakeApi.on("GET /settings", { machines: [], pinnedFields: {} });
    fakeApi.on("POST /form/prompt", { into: null, text: "" });
    const recipe = { id: "zz-test.qwen", family: "zz-test", output: "image", title: "txt2img", summary: "", version: 1, traits: null, inputs: [{ id: "prompt", type: "prompt", label: "Prompt", style: "sentences" }], absent: [off] } as unknown as RecipeInfo;
    useFormTarget.setState({ target: { recipe, values: {}, set: () => {}, draftId: "d", forms: { "zz-test.sdxl": { regions: [{ id: "r1", box: { x: 0, y: 0, w: 0.5, h: 0.5 }, prompt: "" }, { id: "r2", box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, prompt: "" }] } } } });
    draw(<Form recipe={recipe} status={undefined} stored={{}} onChange={() => {}} onClear={() => {}} />);
    const said = await waitFor(() => {
      const el = document.querySelector("[data-regions-off]");
      if (!el) throw new Error("not said yet");
      return el;
    });
    expect(said.textContent).toContain("Regions · Qwen 2.1 has no regional prompting");
    expect(said.textContent).toContain("The 2 boxes stay with the draft");
    // not among the Inputs' frames as well
    expect(screen.getAllByText(/Qwen 2\.1 has no regional prompting/)).toHaveLength(1);
  });

  it("on a model that takes them, the form has a Regions card whose rows are the boxes", async () => {
    fakeApi.on("GET /settings", { machines: [], pinnedFields: {} });
    fakeApi.on("POST /form/prompt", { into: null, text: "" });
    const recipe = { id: "zz-test.sdxl", family: "zz-test", output: "image", title: "txt2img", summary: "", version: 1, traits: null, inputs: [{ id: "prompt", type: "prompt", label: "Prompt", style: "tags" }, SDXL] } as unknown as RecipeInfo;
    const stored = { regions: [{ id: "r1", box: { x: 0.09, y: 0.05, w: 0.36, h: 0.9 }, prompt: "laughing" }] };
    draw(<Form recipe={recipe} status={undefined} stored={stored} onChange={() => {}} onClear={() => {}} />);
    const card = await waitFor(() => {
      const el = document.querySelector("[data-part='regions']");
      if (!el) throw new Error("no card yet");
      return el;
    });
    expect(card.textContent).toContain("1 on the Stage · laughing left");
  });
});
