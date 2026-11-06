import { describe, expect, it } from "vitest";
import { RANDOM_SEED } from "@afflatus/core";
import type { AssetDetail, RecipeInfo } from "../src/api";
import { itemActions, ORDER, selectionActions, toMenu, type ItemFacts, type Runs } from "../src/itemActions";
import { tunedJob, tunedRows, tuneStart } from "../src/passTune";
import { passJob, type PassPlace } from "../src/selectionPasses";
import { varyDenoise } from "../src/vary";

/** A pass with its settings and Vary subtle / strong ×N (card #270): the jobs, what the popover starts on, where it opens from. */

const source = { id: "source", type: "image", role: "source", label: "Image" };
const prompt = { id: "prompt", type: "prompt", label: "Prompt" };
const strength = { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 1, step: 0.05, default: 0.55 };
const seed = { id: "seed", type: "seed", label: "Seed" };
// each recipe's picture operation, as pictureForm says it
const OP: Record<string, string> = { "text-to-picture": "txt2img", redraw: "img2img", sharper: "upscale", "fix-face": "face" };
const recipe = (id: string, inputs: unknown[]): RecipeInfo => ({ id, family: id.split(".")[0], output: "image", op: OP[id.split(".")[1]!], title: id, inputs }) as unknown as RecipeInfo;

const sdxl = [
  recipe("sdxl.text-to-picture", [{ id: "checkpoint", type: "choice" }, prompt, seed]),
  recipe("sdxl.redraw", [source, prompt, strength, { id: "checkpoint", type: "choice" }, seed]),
  recipe("sdxl.sharper", [source, prompt, { id: "upscaler", type: "choice", label: "Upscaler", default: "4x-UltraSharp.pth" }, { id: "factor", type: "number", label: "Upscale by", min: 1.5, max: 4, step: 0.5, default: 2 }, { id: "refine", type: "toggle", default: true }, { id: "checkpoint", type: "choice" }, seed]),
  recipe("sdxl.fix-face", [source, prompt, { ...strength, default: 0.4 }, { id: "detector", type: "choice", label: "Detection model", default: "bbox/face_yolov8m.pt" }, { id: "checkpoint", type: "choice" }, seed]),
];
const flux = [recipe("flux.text-to-picture", [{ id: "model", type: "choice" }, prompt, seed]), recipe("flux.redraw", [{ id: "model", type: "choice" }, source, prompt, strength, seed])];
// a family with no img2img: a Vary is not offered on another family's
const ltx = [recipe("wanimage.text-to-picture", [prompt, seed])];
const families = ["sdxl", "flux", "wanimage"].map((id) => ({ id, name: id, summary: "" }));
const place: PassPlace = { all: [...sdxl, ...flux, ...ltx], families, ready: () => true, options: () => ({}), online: true };

const picture = (id: string, made: string, inputs: Record<string, unknown>) => ({ id, kind: "image", generation: { recipe: made, inputs, resolved: { seed: 7 } }, ancestor: null }) as unknown as AssetDetail;
const harbour = picture("zz-test-1", "sdxl.text-to-picture", { prompt: "zz-test a harbour", checkpoint: "zz-test.safetensors", seed: 7 });

describe("Vary subtle / strong", () => {
  it("is an img2img of the picture on its own model, at the family's low or high denoise, on a new seed", () => {
    const subtle = passJob("vary-subtle", harbour, place);
    expect(subtle.recipe.id).toBe("sdxl.redraw");
    expect(subtle).toMatchObject({ label: "Vary subtle", from: "zz-test-1", stored: { source: "zz-test-1", prompt: "zz-test a harbour", checkpoint: "zz-test.safetensors", strength: 0.5, seed: RANDOM_SEED } });
    expect(passJob("vary-strong", harbour, place).stored.strength).toBe(0.85);
    // a flow model starts a denoise from far more real noise: lower values
    const boat = picture("zz-test-2", "flux.text-to-picture", { prompt: "zz-test a boat", model: "zz-test-flux.safetensors" });
    expect(passJob("vary-subtle", boat, place)).toMatchObject({ recipe: { id: "flux.redraw" }, stored: { strength: 0.3, model: "zz-test-flux.safetensors" } });
    expect(passJob("vary-strong", boat, place).stored.strength).toBe(0.65);
    expect([varyDenoise("klein", "subtle"), varyDenoise("qwen21", "strong")]).toEqual([0.3, 0.65]);
  });

  it("is refused on a model with no img2img, and on a picture not made here", () => {
    expect(() => passJob("vary-subtle", picture("zz-test-3", "wanimage.text-to-picture", { prompt: "a" }), place)).toThrow("Its model has no img2img.");
    expect(() => passJob("vary-strong", { id: "zz-test-4", kind: "image", generation: null, ancestor: null } as unknown as AssetDetail, place)).toThrow("not generated here");
  });

  it("queues ×N as one job of N copies, each on a new seed; the rows changed go in", () => {
    const job = tunedJob(passJob("vary-subtle", harbour, place), { strength: 0.4 }, 4);
    expect(job).toMatchObject({ count: 4, stored: { strength: 0.4, seed: RANDOM_SEED } });
    expect(tunedJob(job, {}, 1).count).toBe(4);
    expect(tunedJob(passJob("vary-subtle", harbour, place), {}, 1)).not.toHaveProperty("count");
    expect(tunedJob(passJob("vary-subtle", harbour, place), {}, 20).count).toBe(8);
  });
});

describe("a pass's popover", () => {
  it("shows the pass's key rows, in the recipe's order and words", () => {
    expect(tunedRows(sdxl[2]!, "upscale").map((i) => i.label)).toEqual(["Upscaler", "Upscale by"]);
    expect(tunedRows(sdxl[3]!, "face").map((i) => i.id)).toEqual(["strength", "detector"]);
    expect(tunedRows(sdxl[1]!, "vary-strong").map((i) => i.id)).toEqual(["strength"]);
    expect(tunedRows(sdxl[0]!, "variation")).toEqual([]);
  });

  it("starts on what the pass would send for this picture: its own values carried, the recipe's defaults under them", () => {
    const upscale = passJob("upscale", harbour, place);
    const rows = tunedRows(upscale.recipe, "upscale");
    expect(tuneStart(upscale, undefined, [], rows)).toEqual({ upscaler: "4x-UltraSharp.pth", factor: 2 });
    // a picture that was itself upscaled at 3× with another upscaler: the same again
    const big = picture("zz-test-5", "sdxl.sharper", { prompt: "a", checkpoint: "zz-test.safetensors", factor: 3, upscaler: "zz-test-4x.pth" });
    expect(tuneStart(passJob("upscale", big, place), undefined, [], rows)).toEqual({ upscaler: "zz-test-4x.pth", factor: 3 });
    const face = passJob("face", harbour, place);
    expect(tuneStart(face, undefined, [], tunedRows(face.recipe, "face"))).toEqual({ strength: 0.4, detector: "bbox/face_yolov8m.pt" });
    const vary = passJob("vary-strong", harbour, place);
    expect(tuneStart(vary, undefined, [], tunedRows(vary.recipe, "vary-strong"))).toEqual({ strength: 0.85 });
  });

  it("names an upscale by the factor set", () => {
    const upscale = passJob("upscale", harbour, place);
    expect(tunedJob(upscale, { factor: 4 }, 1)).toMatchObject({ label: "Upscale 4x", stored: { factor: 4 } });
    expect(tunedJob(upscale, { upscaler: "x.pth" }, 1).label).toBe("Upscale 2x");
  });

  it("opens from the passes that have settings, in an item's list, its menus and a selection's", () => {
    const facts: ItemFacts = {
      kind: "image", inBin: false, kept: false, hasSound: false, reading: false, madeHere: true, generated: true, seed: 7, prompt: "a", opener: null, carrier: false, voice: false, comfyOnline: true, compare: true, timelines: [], moves: [],
      passes: { "vary-subtle": "img2img", "vary-strong": "img2img", upscale: "u", face: "f", hand: "h", background: "b" },
    };
    const runs: Runs = Object.fromEntries(ORDER.map((id) => [id, () => {}]));
    const tune = () => {};
    const list = itemActions(facts, runs, {}, { upscale: tune, "vary-subtle": tune, variation: tune });
    expect(list.filter((a) => a.tune).map((a) => a.id)).toEqual(["variation", "vary-subtle", "upscale"]);
    // a pass that cannot run has no settings to open either
    expect(itemActions({ ...facts, passes: {} }, runs, {}, { upscale: tune }).find((a) => a.id === "upscale")!.tune).toBeUndefined();
    const passes = toMenu(list, "grid").find((it) => it !== "—" && it.label === "Passes");
    expect(passes !== "—" && passes?.items?.filter((it) => it !== "—" && it.tune).map((it) => it !== "—" && it.label)).toEqual(["Vary subtle", "Upscale 2x"]);
    const ticked = selectionActions({ count: 2, pictures: 2, seen: 2, inBin: false, passes: facts.passes }, { pass: () => {}, tunes: { face: tune } });
    expect(ticked.filter((a) => a.tune).map((a) => a.id)).toEqual(["face"]);
  });
});
