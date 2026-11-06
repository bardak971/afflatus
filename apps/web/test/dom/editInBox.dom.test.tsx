import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { boxesSaid } from "../../src/paintFix/PaintAndFix";
import { useStageMode } from "../../src/paintFix/useStageMode";
import { useBanners } from "../../src/store";
import { Viewer } from "../../src/Viewer";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

// Edit in a box (card #284): boxes drawn with B on Paint and fix's layer, each said what to do, sent as one job
const picture = (id: string) => ({ id, name: `zz-test ${id}`, kind: "image", mime: "image/png", width: 64, height: 48, createdAt: "2026-11-04T10:00:00Z", kept: false, inBin: false, generationId: null }) as unknown as Asset;
const head = picture("zz-test-head");

afterEach(() => act(() => useStageMode.getState().leave()));

const INPAINT = { id: "zz-test.paint-over", family: "zz-test", output: "image", op: "inpaint", title: "Inpaint", inputs: [{ id: "source", type: "image", role: "source" }, { id: "mask", type: "image", role: "mask" }, { id: "prompt", type: "prompt" }, { id: "strength", type: "number", min: 0.05, max: 1, step: 0.05, default: 0.75 }] };
const BOXED = (family: string) => ({ id: `${family}.edit-in-box`, family, hidden: true, output: "image", title: "Edit in box", inputs: [{ id: "source", type: "image", role: "source" }, { id: "boxes", type: "regions", max: 8 }, { id: "steps", type: "number", min: 1, max: 80, step: 1, default: 40 }] });
const families = [{ id: "zz-test", name: "zz-test", summary: "" }, { id: "qwen21", name: "Qwen Image 2.1", summary: "" }, { id: "klein", name: "FLUX.2 Klein", summary: "" }];

async function painting(recipes: unknown[] = [INPAINT, BOXED("qwen21"), BOXED("klein")]) {
  fakeApi.on("GET /recipes", { families, recipes });
  fakeApi.on("GET /assets/:id/versions", { head, versions: [{ ...picture("zz-test-v1"), versionOf: head.id }] });
  fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
  const drawn = draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
  await screen.findByRole("group", { name: "Versions" });
  return { ...(await paintOn(head.id)), drawn };
}

/** Paint and fix opened on `id`, the layer once it is up. */
async function paintOn(id: string) {
  act(() => useStageMode.getState().set(id, "paint"));
  await screen.findByRole("group", { name: "Fix" });
  Element.prototype.setPointerCapture ??= () => {};
  const layer = await waitFor(() => {
    const el = document.querySelector("[data-stage-layer]");
    if (!el) throw new Error("no layer yet");
    return el;
  });
  return { layer };
}
const key = (k: string) => fireEvent.keyDown(window, { key: k });
const pointer = (layer: Element, type: string, x: number, y: number) =>
  fireEvent(layer, new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
const drag = (layer: Element, from: [number, number], to: [number, number]) => {
  pointer(layer, "pointerdown", ...from);
  pointer(layer, "pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer(layer, "pointermove", ...to);
  pointer(layer, "pointerup", ...to);
};

describe("the strip's count of edit boxes", () => {
  it("is the boxes drawn on this picture, the cap said as a cap", () => {
    expect(boxesSaid(0)).toBe("No box yet");
    expect(boxesSaid(1)).toBe("1 box · 8 at most");
    expect(boxesSaid(3)).toBe("3 boxes · 8 at most");
  });
});

describe("Edit in box on Paint and fix", () => {
  it("turns the bar to Edit in box once a box is drawn with B, and sends every box with its instruction as one version", async () => {
    const { layer } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    const bar = await screen.findByRole("group", { name: "Edit in box" });
    expect(bar.textContent).toContain("Box 1 of 1");
    const go = screen.getByRole("button", { name: /^Edit in box · 1 box/ }) as HTMLButtonElement;
    // nothing said yet: nothing to send
    expect(go.disabled).toBe(true);
    const say = screen.getByRole("textbox", { name: "What to do in box 1" });
    fireEvent.change(say, { target: { value: "a deer drinking at the stream" } });
    // a second box, said what to do too
    key("Escape");
    drag(layer, [44, 30], [60, 44]);
    await waitFor(() => expect(bar.textContent).toContain("Box 2 of 2"));
    fireEvent.change(screen.getByRole("textbox", { name: "What to do in box 2" }), { target: { value: "remove the lamp" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit in box · 2 boxes/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
    const sent = fakeApi.calls("POST", "/jobs")[0]!.body as { recipe: string; versionOf: string; input: { source: string; boxes: Array<{ prompt: string; box: { w: number } }> } };
    expect(sent).toMatchObject({ recipe: "qwen21.edit-in-box", versionOf: head.id, input: { source: head.id } });
    expect(sent.input.boxes.map((b) => b.prompt)).toEqual(["a deer drinking at the stream", "remove the lamp"]);
    for (const b of sent.input.boxes) expect(b.box.w).toBeGreaterThan(0);
  });

  it("sends the boxes to another editor when one is picked in the bar", async () => {
    const { layer } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    fireEvent.click(screen.getByRole("button", { name: /^Edit model for the boxes:/ }));
    fireEvent.click(await screen.findByRole("option", { name: /FLUX\.2 Klein/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "What to do in box 1" }), { target: { value: "a red bicycle leaning on the wall" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit in box · 1 box/ }));
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")[0]?.body).toMatchObject({ recipe: "klein.edit-in-box" }));
  });

  it("is Fix again once a part is painted, and when the last box is removed with Del", async () => {
    const { layer } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    // Del removes the box picked (the one just drawn): the bar fixes again
    (document.activeElement as HTMLElement | null)?.blur();
    key("Delete");
    await screen.findByRole("group", { name: "Fix" });
    // a box, then a stroke of the brush: a painted mask means Fix
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    (document.activeElement as HTMLElement | null)?.blur();
    key("p");
    drag(layer, [20, 20], [24, 22]);
    await screen.findByRole("group", { name: "Fix" });
  });

  it("lets Esc first let go of the box picked, then leave Paint and fix", async () => {
    const { layer } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    (document.activeElement as HTMLElement | null)?.blur();
    key("Escape");
    expect(useStageMode.getState().on).not.toBeNull();
    key("Escape");
    expect(useStageMode.getState().on).toBeNull();
  });

  it("says the boxes are left out while a mask is painted, and Clear mask (one undo step) hands the bar to Edit in box", async () => {
    const { layer } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    // the box in its own look: the picture blue, ✦ and its number on its label, picked (handles), never the mask's accent
    const box = () => document.querySelector<HTMLElement>("[data-edit-boxes] [data-region]")!;
    expect(box().hasAttribute("data-ignored")).toBe(false);
    expect(box().querySelector("[data-region-chip]")!.textContent).toBe("✦ 1no instruction yet");
    expect(box().querySelector("svg rect:last-child")!.getAttribute("stroke")).toBe("var(--color-picture)");
    expect(box().querySelectorAll("[data-handle]")).toHaveLength(8);
    (document.activeElement as HTMLElement | null)?.blur();
    key("p");
    drag(layer, [20, 20], [24, 22]);
    await screen.findByRole("group", { name: "Fix" });
    expect(screen.getByRole("status").textContent).toContain("Fix uses the mask · the 1 box is ignored");
    // ignored: grey, dashed, still (no moving dash, no handles), as the notice draws it
    expect(box().hasAttribute("data-ignored")).toBe(true);
    const line = box().querySelector("svg rect:last-child")!;
    expect(line.getAttribute("stroke")).toBe("var(--color-ink-3)");
    expect(line.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(line.classList.contains("m-box-dash")).toBe(false);
    expect(box().querySelectorAll("[data-handle]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Clear mask" }));
    await screen.findByRole("group", { name: "Edit in box" });
    expect(box().hasAttribute("data-ignored")).toBe(false);
    expect(screen.getByRole("button", { name: /^Edit in box · 1 box/ })).toBeTruthy();
    // the clear is one step: Ctrl+Z brings the mask back, and the bar fixes again
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await screen.findByRole("group", { name: "Fix" });
    expect(screen.getByRole("status").textContent).toContain("the 1 box is ignored");
  });

  it("says nothing of boxes over a mask when none is drawn", async () => {
    const { layer } = await painting();
    key("p");
    drag(layer, [20, 20], [24, 22]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Fix · / }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/is ignored|are ignored/)).toBeNull();
  });

  it("starts another picture's Paint and fix with no box: the boxes are the picture's own", async () => {
    const other = picture("zz-test-other");
    // each picture its own stack, as the server answers
    fakeApi.on("GET /assets/:id/versions", ({ params }) => (params.id === other.id ? { head: other, versions: [] } : { head, versions: [{ ...picture("zz-test-v1"), versionOf: head.id }] }));
    const { layer, drawn } = await painting();
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    drawn.rerender(<Viewer inline asset={other} items={[head, other]} onOpen={() => {}} onClose={() => {}} />);
    await paintOn(other.id);
    (document.activeElement as HTMLElement | null)?.blur();
    key("b");
    const strip = await screen.findByText(/No box yet/);
    expect(strip).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Edit in box" })).toBeNull();
  });

  it("keeps B the mask's box where no instruction editor is on", async () => {
    await painting([INPAINT]);
    expect(screen.queryByRole("button", { name: /^Edit box/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Rectangle mask/ })).toBeTruthy();
  });
});

describe("a bar's job that could not be queued", () => {
  // card #317: two "could not be queued" banners stayed up over the Stage, covering the strip's Size, Feather and Grow
  it("is said under the bar it came from, not in a banner over the Stage", async () => {
    const { layer } = await painting();
    fakeApi.on("POST /jobs", () => new Response(JSON.stringify({ error: "ComfyUI is not answering" }), { status: 503, headers: { "Content-Type": "application/json" } }));
    key("b");
    drag(layer, [10, 10], [40, 30]);
    await screen.findByRole("group", { name: "Edit in box" });
    fireEvent.change(screen.getByRole("textbox", { name: "What to do in box 1" }), { target: { value: "a deer drinking at the stream" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit in box · 1 box/ }));
    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("The edit in box could not be queued");
    expect(said.textContent).toContain("ComfyUI is not answering");
    expect(useBanners.getState().items.filter((b) => b.tone === "bad")).toEqual([]);
  });
});
