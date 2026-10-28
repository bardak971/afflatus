import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { Clip, FamilyInfo, RecipeInfo, RecipeStatus } from "../../src/api";
import { useModelSettings, useRecipes, useSetup } from "../../src/data";
import { Studio } from "../../src/screens/Studio";
import { useStudio } from "../../src/store";
import { useClipEdits } from "../../src/timeline/useClipEdits";
import { useTimelineMutations } from "../../src/timeline/useTimelineMutations";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A ComfyUI user's first hour (card #143's audit): Create open on a first landing until folded once, the folded strip one
 * way in, the empty library pointing to Create, the ready family preselected, and a timeline clip whose files are still to
 * come queued as Studio's form queues it, its job waiting for them.
 */

const OFFICIAL = { file: "zz-test-official.safetensors", url: "https://huggingface.co/zz-test/zz/resolve/main/zz-test-official.safetensors" };
const status = (id: string, o: Partial<RecipeStatus> = {}) => ({ id, ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {}, ...o });

/** The library and what the Studio reads around it, empty, as on a new install. */
function serveStudio({ recipes = [], families = [], statuses = [] }: { recipes?: unknown[]; families?: unknown[]; statuses?: unknown[] } = {}) {
  fakeApi.on("GET /assets", { items: [], next: null, prev: null });
  fakeApi.on("GET /settings", { machines: [], allFamilies: true, hasRunpodKey: false });
  fakeApi.on("GET /recipes", { families, recipes });
  fakeApi.on("GET /setup", { comfy: { online: true }, recipes: statuses, lists: [] });
  fakeApi.on("GET /drafts", { items: [], unused: 0 });
}

describe("Create on a first landing", () => {
  it("is open, and once folded by hand stays folded, remembered in this browser", async () => {
    serveStudio();
    expect(useStudio.getState()).toMatchObject({ form: true, folded: false });
    const { user } = draw(<Studio />);
    expect(await screen.findByRole("complementary", { name: "Create" })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Close the form" }));
    expect(useStudio.getState()).toMatchObject({ form: false, folded: true });
    expect(JSON.parse(localStorage.getItem("afflatus.studio") ?? "{}").state).toMatchObject({ folded: true });
  });

  it("folded, the strip reads CREATE + and the whole of it opens the form", async () => {
    serveStudio();
    useStudio.setState({ form: false, folded: true });
    const { user } = draw(<Studio />);
    const strip = await screen.findByRole("complementary", { name: "Create (folded)" });
    const open = within(strip).getByRole("button", { name: "Create: open the form" });
    // the word and the + are in the one button: one target, not a small + beside a label
    expect(open.textContent).toBe("Create");
    await user.click(open);
    expect(useStudio.getState().form).toBe(true);
    // opened again, it is still known to have been folded once
    expect(useStudio.getState().folded).toBe(true);
  });

  it("N folds it by hand too", async () => {
    serveStudio();
    const { user } = draw(<Studio />);
    await screen.findByRole("complementary", { name: "Create" });
    await user.keyboard("n");
    expect(useStudio.getState()).toMatchObject({ form: false, folded: true });
  });
});

describe("Create as the app loads (store.ts)", () => {
  const load = async (kept?: object) => {
    vi.resetModules();
    localStorage.clear();
    if (kept) localStorage.setItem("afflatus.studio", JSON.stringify(kept));
    return (await import("../../src/store")).useStudio.getState();
  };

  it("opens on / in a browser that never folded it, and stays folded in one that did", async () => {
    expect(window.location.pathname).toBe("/");
    expect(await load()).toMatchObject({ form: true, folded: false });
    expect(await load({ state: { form: false, folded: true }, version: 1 })).toMatchObject({ form: false, folded: true });
  });

  it("opens as it did in a browser that used the Studio before it was remembered: it knows where Create is", async () => {
    expect(await load({ state: { form: false, size: "L" }, version: 0 })).toMatchObject({ form: false, folded: true, size: "L" });
  });
});

describe("the empty library", () => {
  it("says in plain words that Create is on the left, and its word opens the form", async () => {
    serveStudio();
    useStudio.setState({ form: false, folded: true });
    const { user } = draw(<Studio />);
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText(/is on the left/)).toBeTruthy();
    expect(screen.getByText("Drop pictures or videos here")).toBeTruthy();
    expect(screen.queryByText(/opens the form/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(useStudio.getState().form).toBe(true);
  });
});

describe("the first draft", () => {
  it("opens on a family whose files are all here, not on the first family listed", async () => {
    const inputs = [{ id: "ckpt", type: "model", label: "Checkpoint", folder: "checkpoints" }, { id: "prompt", type: "prompt", label: "Prompt" }];
    serveStudio({
      families: [{ id: "sdxl", name: "SDXL" }, { id: "flux", name: "FLUX" }],
      recipes: [{ id: "sdxl.txt2img", family: "sdxl", title: "txt2img", inputs }, { id: "flux.txt2img", family: "flux", title: "txt2img", inputs }],
      statuses: [status("sdxl.txt2img", { ready: false, emptyInputs: ["ckpt"] }), status("flux.txt2img")],
    });
    fakeApi.on("POST /drafts", ({ body }) => ({ id: "zz-test-draft", recipe: (body as { recipe: string }).recipe, forms: {}, look: null, name: null, title: "", projectId: null, updatedAt: new Date().toISOString(), empty: true }));
    draw(<Studio />);
    await waitFor(() => expect(fakeApi.calls("POST", "/drafts").map((c) => (c.body as { recipe: string }).recipe)).toEqual(["flux.txt2img"]));
  });
});

describe("a timeline clip whose files are still to come", () => {
  const family = { id: "zz", name: "ZZ", slots: [{ id: "checkpoint", folder: "checkpoints", get: OFFICIAL }] } as unknown as FamilyInfo;
  const recipe = { id: "zz.video", family: "zz", title: "zz-test video", inputs: [{ id: "ckpt", type: "model", label: "Model", folder: "checkpoints", slot: "checkpoint" }, { id: "prompt", type: "prompt", label: "Prompt" }] } as unknown as RecipeInfo;
  const clip = { id: "zz-test-clip", kind: "video", recipe: "zz.video", inputs: { prompt: "a red teapot on a table" }, takes: [], joined: "cut" } as unknown as Clip;

  /** The editor's clip edits and its Render, over the app's own reads of the recipes, the setup and the models' settings. */
  function rig(statuses: unknown[]) {
    fakeApi.on("GET /recipes", { families: [family], recipes: [recipe] });
    fakeApi.on("GET /setup", { comfy: { online: true }, recipes: statuses, lists: [] });
    fakeApi.on("GET /model-settings", { items: [] });
    fakeApi.on("PATCH /clips/:id", { ok: true });
    fakeApi.on("POST /timelines/:id/render", { ids: ["zz-test-job"] });
    let got!: { ready: ReturnType<typeof useClipEdits>["ready"]; render: ReturnType<typeof useTimelineMutations>["render"]; loaded: boolean };
    function Editor() {
      const recipes = useRecipes();
      const setup = useSetup();
      const settings = useModelSettings();
      const edits = useClipEdits({ timeline: undefined, clips: [clip], recipes, setup, settings, comfyOnline: true });
      const m = useTimelineMutations("zz-test-timeline", {
        timeline: undefined, clipsNow: { current: [clip] }, recipes: recipes.data?.recipes ?? [], firstRecipe: () => undefined, edits,
        on: { note: () => {}, select: () => {}, unpick: () => {}, writing: () => {}, open: () => {} },
      });
      got = { ready: edits.ready, render: m.render, loaded: recipes.isSuccess && setup.isSuccess && settings.isSuccess };
      return null;
    }
    draw(<Editor />);
    return () => got;
  }

  it("renders as Studio's form does: queued with the family's official file, the job waiting for it", async () => {
    const now = rig([status("zz.video", { ready: false, missingSlots: ["checkpoint"], emptyInputs: ["ckpt"] })]);
    await waitFor(() => expect(now().loaded).toBe(true));
    expect(now().ready(clip)).toEqual({ input: expect.objectContaining({ ckpt: OFFICIAL.file, prompt: "a red teapot on a table" }) });
    now().render.mutate({ clips: [clip] });
    await waitFor(() => expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/render")).toHaveLength(1));
    expect(fakeApi.calls("POST", "/timelines/zz-test-timeline/render")[0]!.body).toMatchObject({ clips: [{ id: "zz-test-clip", input: { ckpt: OFFICIAL.file } }] });
  });

  it("is still refused for what no download brings: a node ComfyUI lacks", async () => {
    const now = rig([status("zz.video", { ready: false, missingSlots: ["checkpoint"], missingNodes: ["ZzTestNode"] })]);
    await waitFor(() => expect(now().loaded).toBe(true));
    expect(now().ready(clip).input).toBeUndefined();
    expect(now().ready(clip).why).toMatch(/ZzTestNode/);
  });

  it("is still refused for a file with no known download", async () => {
    const now = rig([status("zz.video", { ready: false, missingFiles: ["zz-test-own-lora.safetensors"] })]);
    await waitFor(() => expect(now().loaded).toBe(true));
    expect(now().ready(clip)).toEqual({ why: "ComfyUI does not have zz-test-own-lora.safetensors." });
  });
});
