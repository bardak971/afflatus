import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { catalog } from "./fixtures";

const titled = (title: string) => ({ _meta: { title } });
/**
 * A video workflow that carries a video on: an upload loader reads the clip before (its first frame is taken,
 * so it is needed), a path loader the clip after (straight into an optional input), a sound loader a sound
 * for the combiner (optional too).
 */
const graph: Graph = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_14B.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl.safetensors", type: "wan", device: "default" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "she turns", clip: ["2", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["2", 0] } },
  "10": { class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "placeholder.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, start_time: 0 }, ...titled("Source video") },
  "11": { class_type: "VHS_LoadVideoFFmpegPath", inputs: { video: "", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, start_time: 0 }, ...titled("Next video") },
  "12": { class_type: "LoadAudio", inputs: { audio: "voice.wav" } },
  "20": { class_type: "ImageFromBatch", inputs: { image: ["10", 0], batch_index: 0, length: 1 } },
  "50": { class_type: "WanFirstLastFrameToVideo", inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["3", 0], width: 832, height: 480, length: 81, batch_size: 1, start_image: ["20", 0], end_image: ["11", 0] } },
  "57": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 42, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["50", 0], negative: ["50", 1], latent_image: ["50", 2], denoise: 1 } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["57", 0], vae: ["3", 0] } },
  "63": { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], audio: ["12", 0], frame_rate: 16, loop_count: 0, filename_prefix: "wan", format: "video/h264-mp4", pingpong: false, save_output: true } },
};

describe("videos and sounds a workflow loads", () => {
  const found = inspect(graph, catalog);
  const s = found.suggested!;
  const def: WorkflowDef = { id: "w", title: "t", model: "Wan 2.2", source: "t.json", graph: graph as WorkflowDef["graph"], bindings: s };

  it("finds the loaders, tells the clip after by its name, and binds the first of each", () => {
    expect(found.videos.map((v) => [v.title, v.role])).toEqual([["Source video", "previous"], ["Next video", "next"]]);
    expect(found.sounds.map((v) => v.node)).toEqual(["12"]);
    // the clip before feeds a node that cannot do without it; the clip after and the sound go into optional inputs
    expect(s.previousVideo).toMatchObject({ target: { node: "10", input: "video" }, required: true });
    expect(s.nextVideo).toMatchObject({ target: { node: "11", input: "video" }, required: false, detach: [{ node: "50", input: "end_image" }] });
    expect(s.sound).toMatchObject({ target: { node: "12", input: "audio" }, required: false });
    // the loaders' file inputs are not offered as widgets besides
    expect(found.candidates.some((c) => c.target.node === "10" && c.target.input === "video")).toBe(false);
    expect(found.candidates.some((c) => c.target.node === "12")).toBe(false);
  });

  it("gives the form a previous clip, a next clip and a sound, the clips taken whole", () => {
    const recipe = recipeFromWorkflow(def);
    expect(recipe.inputs.find((i) => i.id === "previousVideo")).toMatchObject({ type: "clip", role: "previous", whole: true, optional: false });
    expect(recipe.inputs.find((i) => i.id === "nextVideo")).toMatchObject({ type: "clip", role: "next", whole: true, optional: true });
    expect(recipe.inputs.find((i) => i.id === "sound")).toMatchObject({ type: "audio", role: "sound", optional: true });
    // in a timeline, a clip made with it carries the clip before on
    expect(recipe.traits?.continues).toBe("clip");
  });

  it("writes the uploaded files into the loaders, a path for a path loader, and drops a loader given nothing", () => {
    const recipe = recipeFromWorkflow(def);
    const full = recipe.build(
      parseInput(recipe, { previousVideo: { asset: "a" }, nextVideo: { asset: "b" }, sound: "c" }),
      dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]", nextVideo: "afflatus_2.mp4 [temp]", sound: "afflatus_3.wav [temp]" } }),
    );
    expect(full.graph["10"]!.inputs.video).toBe("afflatus_1.mp4 [temp]");
    expect(full.graph["11"]!.inputs.video).toBe("temp/afflatus_2.mp4");
    expect(full.graph["12"]!.inputs.audio).toBe("afflatus_3.wav [temp]");
    // without the clip after and the sound, their loaders go, and the optional links that read them
    const less = recipe.build(parseInput(recipe, { previousVideo: { asset: "a" } }), dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]" } }));
    expect(less.graph["11"]).toBeUndefined();
    expect(less.graph["12"]).toBeUndefined();
    expect(less.graph["50"]!.inputs.end_image).toBeUndefined();
    expect(less.graph["63"]!.inputs.audio).toBeUndefined();
    expect(less.graph["10"]!.inputs.video).toBe("afflatus_1.mp4 [temp]");
  });

  it("builds its dry-run variant", () => {
    const recipe = recipeFromWorkflow(def);
    const v = recipe.variants![0]!;
    expect(() => recipe.build(parseInput(recipe, v.input), dryContext({ uploads: v.uploads }))).not.toThrow();
  });
});
