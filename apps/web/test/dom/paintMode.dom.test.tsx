import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Asset, RecipeInfo } from "../../src/api";
import { fixInputs } from "../../src/paintFix/useFixJob";
import { useStageMode, useVersionDrafts, versionOfDraft } from "../../src/paintFix/useStageMode";
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
const withInpaint = () => fakeApi.on("GET /recipes", { families: [{ id: "zz-test", name: "zz-test", summary: "" }], recipes: [INPAINT] });

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

describe("what a fix sends", () => {
  const tool = { id: "zz-test.paint-over", inputs: [{ id: "source", type: "image", role: "source" }, { id: "mask", type: "image", role: "mask" }, { id: "prompt", type: "prompt" }, { id: "strength", type: "number" }, { id: "maskGrow", type: "number" }] } as unknown as RecipeInfo;

  it("is the mask in the recipe's mask slot, the denoise and grow it takes, the prompt only when written", () => {
    expect(fixInputs(tool, { prompt: "  ", strength: 0.5, grow: 8, tuned: {} }, "zz-test-mask")).toEqual({ mask: "zz-test-mask", strength: 0.5, maskGrow: 8 });
    expect(fixInputs(tool, { prompt: "a red scarf", strength: 0.5, grow: 8, tuned: { steps: 12 } }, "zz-test-mask")).toMatchObject({ prompt: "a red scarf", steps: 12 });
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
