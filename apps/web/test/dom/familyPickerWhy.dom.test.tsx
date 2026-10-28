import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { RecipeInfo, RecipeStatus } from "../../src/api";
import { useModelPick } from "../../src/screens/studio/ModelPicker";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * The form's model picker (the #143 audit, shot 10): a video family it could not offer said "not ready" or "not here"
 * and nothing of why. It says the files and what they weigh, or the nodes this ComfyUI lacks.
 */

const url = (id: string) => `https://example.test/${id}.safetensors`;
const recipe = (id: string, family: string, title: string): RecipeInfo => ({ id, family, version: 1, title, summary: `${title}.`, output: "video", inputs: [], traits: null });
const status = (id: string, over: Partial<RecipeStatus> = {}): RecipeStatus => ({ id, ready: false, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {}, ...over });

function Notes() {
  const pick = useModelPick({ recipe: recipe("wan.video", "wan", "Video"), draft: null, onPick: () => {} });
  return <ul>{pick.groups.map((g) => <li key={g.key}>{g.name}: {g.recipes.some((r) => !pick.why(r)) ? pick.notHere(g) : pick.notReadyWhy(g)}</li>)}</ul>;
}

describe("the model picker's families that cannot run", () => {
  it("say the files they lack with their size, or the nodes ComfyUI lacks", async () => {
    const slot = (id: string, get = true) => ({ id, folder: "diffusion_models", ...(get ? { get: { file: `${id}.safetensors`, url: url(id) } } : {}) });
    fakeApi.on("GET /recipes", {
      families: [
        { id: "h3", name: "MiniMax H3", summary: "", slots: [slot("unet"), slot("clip")] },
        { id: "ltx", name: "LTX 2.3", summary: "", slots: [slot("checkpoint")] },
        { id: "wan", name: "Wan 2.2", summary: "", slots: [slot("i2v", false)] },
      ],
      recipes: [recipe("h3.video", "h3", "Video with audio"), recipe("ltx.video", "ltx", "Video"), recipe("wan.video", "wan", "Video")],
    });
    fakeApi.on("GET /setup", {
      comfy: { online: true, url: "http://127.0.0.1:8188", version: "0.3.68", device: "cuda", vramTotal: 0, vramFree: 0, nodes: 900 },
      families: [],
      recipes: [status("h3.video", { missingSlots: ["unet", "clip"] }), status("ltx.video", { missingNodes: ["LTXVImgToVideo", "LTXVConditioning"] }), status("wan.video", { missingSlots: ["i2v"] })],
    });
    fakeApi.on("GET /settings", { allFamilies: true, families: {}, machines: [] });
    fakeApi.on("GET /official-sizes", { sizes: { [url("unet")]: 20 * 2 ** 30, [url("clip")]: 8 * 2 ** 30 }, asking: false });
    draw(<Notes />);
    // H3's files have downloads: they come, "not here" with their count and size
    expect(await screen.findByText("MiniMax H3: 2 files not here · 28.0 GB")).toBeTruthy();
    expect(await screen.findByText("LTX 2.3: not ready · 2 nodes missing")).toBeTruthy();
    expect(screen.getByText("Wan 2.2: not ready · 1 file missing")).toBeTruthy();
  });
});
