import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Asset, RecipeInfo } from "../../src/api";
import { findOn } from "../../src/paintFix/findOn";
import { frameSaid } from "../../src/paintFix/PaintAndFix";
import { fixInputs, outInputs } from "../../src/paintFix/useFixJob";
import { useStageMode, useVersionDrafts, versionOfDraft } from "../../src/paintFix/useStageMode";
import { TunePopoverHost } from "../../src/TunePopover";
import { Viewer } from "../../src/Viewer";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

const picture = (id: string) => ({ id, name: `zz-test ${id}`, kind: "image", mime: "image/png", width: 64, height: 48, createdAt: "2026-11-04T10:00:00Z", kept: false, inBin: false, generationId: null }) as unknown as Asset;
const head = picture("zz-test-head");
const v1 = { ...picture("zz-test-v1"), versionOf: head.id };
const next = picture("zz-test-next");

afterEach(() => act(() => useStageMode.getState().leave()));

/** An inpaint the picture can be fixed with: Paint and fix is offered only with one. */
const INPAINT = { id: "zz-test.paint-over", family: "zz-test", output: "image", title: "Inpaint", inputs: [{ id: "source", type: "image", role: "source" }, { id: "mask", type: "image", role: "mask" }, { id: "prompt", type: "prompt" }, { id: "strength", type: "number", min: 0.05, max: 1, step: 0.05, default: 0.75 }] };
const EDIT = { id: "zz-test.edit", family: "zz-test", output: "image", title: "Edit", inputs: [{ id: "source", type: "image", role: "source" }, { id: "prompt", type: "prompt", placeholder: "Change the car to red" }] };
const withInpaint = () => fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test", summary: "" }], recipes: [INPAINT, EDIT] });

/** The viewer in place on a picture with one version, Paint and fix on over it. */
async function painting() {
  withInpaint();
  fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
  draw(<Viewer inline asset={head} items={[head, next]} onOpen={() => {}} onClose={() => {}} />);
  await screen.findByRole("group", { name: "Versions" });
  act(() => useStageMode.getState().set(head.id, "paint"));
  await screen.findByRole("group", { name: "Fix" });
}
const key = (k: string, more: object = {}) => fireEvent.keyDown(window, { key: k, ...more });

describe("the viewer in Paint and fix", () => {
  it("leaves the layer its keys: no pass is queued, no item moved to the bin", async () => {
    await painting();
    for (const k of ["u", "f", "h", "b", "Delete", "p", "e", "x"]) key(k);
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(fakeApi.calls("POST", "/jobs")).toHaveLength(0);
    expect(fakeApi.calls("DELETE", "/assets")).toHaveLength(0);
  });

  it("still steps through the versions with ← → and keeps one with K", async () => {
    await painting();
    key("ArrowRight");
    await waitFor(() => expect(screen.getByRole("button", { name: "Version 1" }).getAttribute("aria-pressed")).toBe("true"));
    fakeApi.on("POST /assets/:id/versions/keep", { head: v1, versions: [] });
    key("k");
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-head/versions/keep")[0]?.body).toEqual({ version: "zz-test-v1" }));
  });

  it("K keeps the place: the kept version is opened in the original's, Paint and fix stays on over it, the mask kept (#314, #295)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    const opened: string[] = [];
    // the place's own list, as a draft's column: the shown item is what onOpen picks
    function Place() {
      const [shown, setShown] = useState<Asset>(head);
      return <Viewer inline asset={shown} items={[shown, next]} onOpen={(a) => { opened.push(a.id); setShown(a); }} onClose={() => {}} />;
    }
    draw(<Place />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "paint"));
    await screen.findByRole("group", { name: "Fix" });
    Element.prototype.setPointerCapture ??= () => {};
    const layer = () => document.querySelector("[data-stage-layer]")!;
    await waitFor(() => expect(layer()).not.toBeNull());
    const press = (type: string) => fireEvent(layer(), new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 3, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
    press("pointerdown");
    press("pointerup");
    const chip = () => screen.getByText(/^Mask ·/).textContent;
    await waitFor(() => expect(chip()).not.toBe("Mask · nothing painted"));
    key("ArrowRight");
    await waitFor(() => expect(screen.getByRole("button", { name: "Version 1" }).getAttribute("aria-pressed")).toBe("true"));
    const kept = { ...v1, versionOf: null };
    const after = { head: kept, versions: [{ ...head, versionOf: v1.id }] };
    fakeApi.on("POST /assets/:id/versions/keep", after);
    fakeApi.on("GET /assets/:id/versions", after);
    key("k");
    await waitFor(() => expect(opened).toEqual([v1.id]));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(useStageMode.getState().on).not.toBeNull();
    expect(screen.getByRole("group", { name: "Fix" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "The original" }).getAttribute("aria-pressed")).toBe("true");
    expect(chip()).not.toBe("Mask · nothing painted");
  });

  it("lets a press that closes the ⚙ popover only close it: nothing painted (owner)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    draw(<><Viewer inline asset={head} items={[head, next]} onOpen={() => {}} onClose={() => {}} /><TunePopoverHost /></>);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "paint"));
    await screen.findByRole("group", { name: "Fix" });
    Element.prototype.setPointerCapture ??= () => {};
    const layer = await waitFor(() => {
      const el = document.querySelector("[data-stage-layer]");
      if (!el) throw new Error("no layer yet");
      return el;
    });
    const chip = () => screen.getByText(/^Mask ·/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "The fix's settings" }));
    expect(await screen.findByRole("dialog", { name: /Inpaint: its settings/ })).toBeTruthy();
    const press = (type: string) => fireEvent(layer, new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 3, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
    press("pointerdown");
    press("pointerup");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Inpaint: its settings/ })).toBeNull());
    expect(chip()).toBe("Mask · nothing painted");
    // with nothing open over it, the same press paints
    press("pointerdown");
    press("pointerup");
    await waitFor(() => expect(chip()).not.toBe("Mask · nothing painted"));
  });

  it("edits the whole picture from the bar as versions, once an instruction is written (Edit, E)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "edit"));
    const go = await screen.findByRole("button", { name: /^Edit · 3 versions/ });
    expect(screen.getByText("Whole picture")).toBeTruthy();
    expect((go as HTMLButtonElement).disabled).toBe(true);
    const say = screen.getByRole("textbox", { name: "What to change" });
    expect(say.getAttribute("placeholder")).toBe("Change the car to red");
    fireEvent.change(say, { target: { value: "make the sky stormy" } });
    fireEvent.click(go);
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/jobs")[0]!.body).toMatchObject({ recipe: "zz-test.edit", count: 3, versionOf: head.id, input: { source: head.id, prompt: "make the sky stormy" } });
  });

  it("leaves Ctrl+Enter to ⚙ while it is open: the bar does not queue on its settings from before (#297)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
    draw(<><Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} /><TunePopoverHost /></>);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "edit"));
    fireEvent.change(await screen.findByRole("textbox", { name: "What to change" }), { target: { value: "make the sky stormy" } });
    fireEvent.click(screen.getByRole("button", { name: "The fix's settings" }));
    await screen.findByRole("dialog", { name: /its settings/ });
    key("Enter", { ctrlKey: true });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(fakeApi.calls("POST", "/jobs")).toHaveLength(0);
  });

  it("Ctrl+Enter while a number box is typed in queues with what it holds, not the number before (#324)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "edit"));
    fireEvent.change(await screen.findByRole("textbox", { name: "What to change" }), { target: { value: "make the sky stormy" } });
    const count = screen.getByRole("textbox", { name: "Versions" });
    count.focus();
    fireEvent.change(count, { target: { value: "5" } });
    key("Enter", { ctrlKey: true });
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/jobs")[0]!.body).toMatchObject({ count: 5 });
  });

  it("a second Fix while the mask's PNG is made queues nothing more, and a mask that cannot be made is said (#324)", async () => {
    // a page that draws, its PNG slow to come as on a large picture (happy-dom has no 2D context of its own)
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ putImageData: () => {} }) as unknown as RenderingContext);
    let blobs = 0;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback) {
      setTimeout(() => done(++blobs === 1 ? new Blob(["png"], { type: "image/png" }) : null), 40);
    };
    Element.prototype.setPointerCapture ??= () => {};
    try {
      fakeApi.on("POST /assets", { ...picture("zz-test-mask") });
      fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
      await painting();
      const layer = document.querySelector<HTMLElement>("[data-stage-layer]")!;
      fireEvent.pointerDown(layer, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 200 });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 200 });
      const go = await screen.findByRole("button", { name: /^Fix · 3 versions/ });
      await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(go);
      fireEvent.click(go);
      key("Enter", { ctrlKey: true });
      await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
      await act(() => new Promise((r) => setTimeout(r, 80)));
      expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1);
      expect(fakeApi.calls("POST", "/assets")).toHaveLength(1);
      // the next PNG fails: the bar says so
      await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(go);
      expect(await screen.findByText(/the mask could not be saved/)).toBeTruthy();
      expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1);
    } finally {
      HTMLCanvasElement.prototype.toBlob = toBlob;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("two clicks on Edit in one frame queue one batch: the bar's busy comes a tick after the first (pod test 2026-11-06, #324)", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "edit"));
    fireEvent.change(await screen.findByRole("textbox", { name: "What to change" }), { target: { value: "make the sky stormy" } });
    const go = screen.getByRole("button", { name: /^Edit · 3 versions/ });
    fireEvent.click(go);
    fireEvent.click(go);
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1);
    // once it is queued, the next click is a new batch
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(2));
  });

  it("two clicks on Fix in one frame, both masks made, queue one batch and upload one mask (pod test 2026-11-06, #324)", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    vi.stubGlobal("ResizeObserver", class { constructor(private seen: () => void) {} observe() { this.seen(); } disconnect() {} });
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ putImageData: () => {} }) as unknown as RenderingContext);
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    // every PNG comes, as in a browser: the second click must be stopped by the bar, not by a failed mask
    HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback) {
      setTimeout(() => done(new Blob(["png"], { type: "image/png" })), 20);
    };
    Element.prototype.setPointerCapture ??= () => {};
    try {
      fakeApi.on("POST /assets", { ...picture("zz-test-mask") });
      fakeApi.on("POST /jobs", { ids: ["zz-test-job"] });
      await painting();
      const layer = document.querySelector<HTMLElement>("[data-stage-layer]")!;
      fireEvent.pointerDown(layer, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 200 });
      fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 200 });
      const go = await screen.findByRole("button", { name: /^Fix · 3 versions/ });
      await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(go);
      fireEvent.click(go);
      await waitFor(() => expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1));
      await act(() => new Promise((r) => setTimeout(r, 80)));
      expect(fakeApi.calls("POST", "/jobs")).toHaveLength(1);
      expect(fakeApi.calls("POST", "/assets")).toHaveLength(1);
    } finally {
      HTMLCanvasElement.prototype.toBlob = toBlob;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("says so in the bar when the picture has no edit model, and fixes a painted part instead", async () => {
    fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test", summary: "" }], recipes: [INPAINT] });
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "edit"));
    expect(await screen.findByText(/^No edit model for this picture/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Fix · 3 versions/ })).toBeTruthy();
  });

  it("without an edit model, B is the rectangle mask with the mask's options, not the edit boxes' strip (#297)", async () => {
    await painting();
    key("b");
    await waitFor(() => expect(screen.getByRole("button", { name: /Rectangle mask/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(document.body.textContent).not.toContain("No box yet");
    expect(document.body.textContent).toContain("Feather");
  });

  it("starts a Fix on denoise 0.95, not the Inpaint form's 0.75, which kept what was painted over (card #281)", async () => {
    await painting();
    expect((screen.getByRole("textbox", { name: "Denoise" }) as HTMLInputElement).value).toBe("0.95");
  });

  it("is left with Esc, the viewer's keys its own again", async () => {
    await painting();
    key("Escape");
    expect(useStageMode.getState().on).toBeNull();
  });

  it("is what Inpaint (I) turns on, on the picture shown", async () => {
    withInpaint();
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    await waitFor(() => {
      key("i");
      expect(useStageMode.getState().on).toEqual({ asset: head.id, mode: "paint" });
    });
    expect(await screen.findByRole("group", { name: "Fix" })).toBeTruthy();
  });

  it("leaves the viewer as it is for a picture with no inpaint to fix it with", async () => {
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    act(() => useStageMode.getState().set(head.id, "paint"));
    expect(screen.queryByRole("group", { name: "Fix" })).toBeNull();
    expect(screen.getByRole("group", { name: "Versions" })).toBeTruthy();
  });
});

describe("Keep all", () => {
  it("lets go of the stack under the ids that left it: a version kept as a picture is not shown its old stack (#298)", async () => {
    fakeApi.on("GET /assets/:id/versions", { head, versions: [v1] });
    const { client } = draw(<Viewer inline asset={head} items={[head]} onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole("group", { name: "Versions" });
    // v1's stack as it was, read under its own id (a strip opened on it before)
    client.setQueryData(["assets", "versions", v1.id], { head, versions: [v1] });
    fakeApi.on("POST /assets/:id/versions/keep-all", { head, versions: [] });
    fakeApi.on("GET /assets/:id/versions", ({ params }) => (params.id === v1.id ? { head: { ...v1, versionOf: null }, versions: [] } : { head, versions: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Keep all as pictures" }));
    await waitFor(() => expect(fakeApi.calls("POST", "/assets/zz-test-head/versions/keep-all")).toHaveLength(1));
    await waitFor(() => expect((client.getQueryData(["assets", "versions", v1.id]) as { versions: unknown[] } | undefined)?.versions ?? []).toEqual([]));
  });
});

describe("what a fix sends", () => {
  const tool = { id: "zz-test.paint-over", inputs: [{ id: "source", type: "image", role: "source" }, { id: "mask", type: "image", role: "mask" }, { id: "prompt", type: "prompt" }, { id: "strength", type: "number" }, { id: "maskGrow", type: "number" }] } as unknown as RecipeInfo;

  it("is the mask in the recipe's mask slot, the denoise and grow it takes, the prompt only when written", () => {
    expect(fixInputs(tool, { prompt: "  ", strength: 0.5, grow: 8, tuned: {} }, "zz-test-mask")).toEqual({ mask: "zz-test-mask", strength: 0.5, maskGrow: 8 });
    expect(fixInputs(tool, { prompt: "a red scarf", strength: 0.5, grow: 8, tuned: { steps: 12 } }, "zz-test-mask")).toMatchObject({ prompt: "a red scarf", steps: 12 });
    const blurred = { ...tool, inputs: [...tool.inputs, { id: "maskBlur", type: "number" }] } as RecipeInfo;
    expect(fixInputs(blurred, { prompt: "", strength: 0.5, grow: 8, tuned: {}, soft: true }, "zz-test-mask")).toMatchObject({ maskBlur: 1 });
    expect(fixInputs(blurred, { prompt: "", strength: 0.5, grow: 8, tuned: {} }, "zz-test-mask")).not.toHaveProperty("maskBlur");
    const plain = { ...tool, inputs: tool.inputs.filter((i) => i.id !== "maskGrow" && i.id !== "prompt") } as RecipeInfo;
    expect(fixInputs(plain, { prompt: "a red scarf", strength: 0.5, grow: 8, tuned: {} }, "zz-test-mask")).toEqual({ mask: "zz-test-mask", strength: 0.5 });
  });

  it("from the full form opened through ⚙ is a version while the form's picture is still the one it was opened on", () => {
    useVersionDrafts.getState().mark("zz-test-draft", head.id);
    expect(versionOfDraft("zz-test-draft", head.id)).toBe(head.id);
    expect(versionOfDraft("zz-test-draft", "zz-test-other")).toBeUndefined();
    expect(versionOfDraft("zz-test-elsewhere", head.id)).toBeUndefined();
  });
});

describe("what an outpaint sends", () => {
  const sides = { shape: "Custom" as const, padLeft: 192, padTop: 128, padRight: 0, padBottom: 0 };
  it("is the frame's sides as the Custom shape, the prompt only when written", () => {
    const tool = { id: "zz-test.outpaint", inputs: [{ id: "prompt", type: "prompt" }, { id: "padLeft", type: "number" }] } as unknown as RecipeInfo;
    expect(outInputs(tool, { prompt: "", tuned: {} }, sides)).toEqual(sides);
    expect(outInputs(tool, { prompt: " more tables ", tuned: { feathering: 40 } }, sides)).toEqual({ ...sides, prompt: "more tables", feathering: 40 });
  });

  it("is said on the chip side by side, nothing when the frame is the picture's own", () => {
    expect(frameSaid(sides)).toBe("+192 left · +128 top");
    expect(frameSaid({ ...sides, padLeft: 0, padTop: 0 })).toBeNull();
  });
});

describe("a mask found on the Stage", () => {
  it("queues the find, asks until it is done, and hands the masks over in the layer's shape", async () => {
    fakeApi.on("POST /assets/:id/find-mask", { job: "zz-test-find" });
    let asked = 0;
    fakeApi.on("GET /assets/:id/find-mask/:job", () => (++asked < 2
      ? { status: "running", error: null, masks: [] }
      : { status: "done", error: null, masks: [{ asset: { id: "zz-test-found" }, box: { x: 10, y: 20, width: 30, height: 40 } }] }));
    const found = await findOn(head.id)({ way: "points", add: [{ x: 5, y: 6 }], remove: [] });
    expect(found).toEqual([{ asset: "zz-test-found", box: { x: 10, y: 20, w: 30, h: 40 } }]);
    expect(fakeApi.calls("POST", "/assets/zz-test-head/find-mask")[0]!.body).toEqual({ way: "points", add: [{ x: 5, y: 6 }], remove: [] });
  });

  it("given up or past its deadline, stops asking and cancels the job: nothing left polling or running on the GPU (#297, #308)", async () => {
    fakeApi.on("POST /assets/:id/find-mask", { job: "zz-test-find" });
    fakeApi.on("GET /assets/:id/find-mask/:job", { status: "queued", error: null, masks: [] });
    fakeApi.on("POST /jobs/:id/cancel", { ok: true });
    const stop = new AbortController();
    const asking = findOn(head.id)({ way: "detect", what: "face" }, stop.signal);
    await waitFor(() => expect(fakeApi.calls("GET", "/assets/zz-test-head/find-mask/zz-test-find").length).toBeGreaterThan(0));
    stop.abort();
    await expect(asking).rejects.toThrow();
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs/zz-test-find/cancel")).toHaveLength(1));
    const polled = fakeApi.calls("GET", "/assets/zz-test-head/find-mask/zz-test-find").length;
    await new Promise((r) => setTimeout(r, 400));
    expect(fakeApi.calls("GET", "/assets/zz-test-head/find-mask/zz-test-find")).toHaveLength(polled);
    // a queue paused or a ComfyUI down: the find gives up at its deadline, and says why
    await expect(findOn(head.id, 0)({ way: "detect", what: "face" })).rejects.toThrow(/took too long/);
    await waitFor(() => expect(fakeApi.calls("POST", "/jobs/zz-test-find/cancel")).toHaveLength(2));
  });

  it("throws the job's own reason when it failed, for the layer's strip to say", async () => {
    fakeApi.on("POST /assets/:id/find-mask", { job: "zz-test-find" });
    fakeApi.on("GET /assets/:id/find-mask/:job", { status: "failed", error: "zz-test: SAM 3 is not installed", masks: [] });
    await expect(findOn(head.id)({ way: "detect", what: "face" })).rejects.toThrow("zz-test: SAM 3 is not installed");
  });
});
