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
  "10": { class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "placeholder.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, start_time: 0 }, ...titled("Clip before") },
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
    expect(found.videos.map((v) => [v.title, v.role])).toEqual([["Clip before", "previous"], ["Next video", "next"]]);
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

  it("writes the uploaded files into the loaders, a path loader turned into its upload twin, and drops a loader given nothing", () => {
    const recipe = recipeFromWorkflow(def);
    const full = recipe.build(
      parseInput(recipe, { previousVideo: { asset: "a" }, nextVideo: { asset: "b" }, sound: "c" }),
      dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]", nextVideo: "afflatus_2.mp4 [temp]", sound: "afflatus_3.wav [temp]" } }),
    );
    expect(full.graph["10"]!.inputs.video).toBe("afflatus_1.mp4 [temp]");
    // the path loader reads the temp folder wherever ComfyUI keeps it: its upload twin asks ComfyUI, with the same settings
    expect(full.graph["11"]).toMatchObject({ class_type: "VHS_LoadVideoFFmpeg", inputs: { video: "afflatus_2.mp4 [temp]" } });
    expect(Object.keys(full.graph["11"]!.inputs).sort()).toEqual(Object.keys(def.graph["11"]!.inputs).sort());
    // a ComfyUI whose pack lacks the twin: a path into the temp folder, as before
    const old = recipe.build(
      parseInput(recipe, { previousVideo: { asset: "a" }, nextVideo: { asset: "b" } }),
      dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]", nextVideo: "afflatus_2.mp4 [temp]" }, has: (c: string) => c !== "VHS_LoadVideoFFmpeg" }),
    );
    expect(old.graph["11"]).toMatchObject({ class_type: "VHS_LoadVideoFFmpegPath", inputs: { video: "temp/afflatus_2.mp4" } });
    expect(full.graph["12"]!.inputs.audio).toBe("afflatus_3.wav [temp]");
    // without the clip after and the sound, their loaders go, and the optional links that read them
    const less = recipe.build(parseInput(recipe, { previousVideo: { asset: "a" } }), dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]" } }));
    expect(less.graph["11"]).toBeUndefined();
    expect(less.graph["12"]).toBeUndefined();
    expect(less.graph["50"]!.inputs.end_image).toBeUndefined();
    expect(less.graph["63"]!.inputs.audio).toBeUndefined();
    expect(less.graph["10"]!.inputs.video).toBe("afflatus_1.mp4 [temp]");
  });

  it("turns the pack's sound path loader into its upload twin, its settings renamed", () => {
    const g: Graph = { ...structuredClone(graph), "12": { class_type: "VHS_LoadAudio", inputs: { audio_file: "", seek_seconds: 1.5, duration: 0 } } };
    const found = inspect(g, catalog);
    const recipe = recipeFromWorkflow({ ...def, graph: g as WorkflowDef["graph"], bindings: found.suggested! });
    const full = recipe.build(
      parseInput(recipe, { previousVideo: { asset: "a" }, sound: "c" }),
      dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]", sound: "afflatus_3.wav [temp]" } }),
    );
    expect(full.graph["12"]).toEqual({ class_type: "VHS_LoadAudioUpload", inputs: { audio: "afflatus_3.wav [temp]", start_time: 1.5, duration: 0 } });
  });

  it("builds its dry-run variant", () => {
    const recipe = recipeFromWorkflow(def);
    const v = recipe.variants![0]!;
    expect(() => recipe.build(parseInput(recipe, v.input), dryContext({ uploads: v.uploads }))).not.toThrow();
  });
});

describe("several sounds a workflow loads (a voice and a music)", () => {
  // a sound-to-video workflow: the voice drives the lips, the music is mixed under it; both are needed
  const two: Graph = {
    ...graph,
    "12": { class_type: "LoadAudio", inputs: { audio: "voice.wav" }, ...titled("Load voice only") },
    "13": { class_type: "LoadAudio", inputs: { audio: "music.wav" }, ...titled("Music") },
    "14": { class_type: "LoadAudio", inputs: { audio: "spare.wav" } },
    "30": { class_type: "AudioConcat", inputs: { audio1: ["12", 0], audio2: ["13", 0], direction: "after" } },
    "63": { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], audio: ["30", 0], frame_rate: 16, loop_count: 0, filename_prefix: "wan", format: "video/h264-mp4", pingpong: false, save_output: true } },
  };
  const found = inspect(two, catalog);
  const s = found.suggested!;
  const def: WorkflowDef = { id: "w", title: "t", model: "Wan 2.2", source: "t.json", graph: two as WorkflowDef["graph"], bindings: s };

  it("binds the first as the sound and gives each other one a slot of its own, under its loader's name", () => {
    expect(s.sound).toMatchObject({ target: { node: "12" }, required: true });
    expect(s.otherSounds.map((o) => [o.id, o.label, o.required])).toEqual([["snd_13", "Music", true], ["snd_14", "Sound 3", false]]);
    const recipe = recipeFromWorkflow(def);
    expect(recipe.inputs.find((i) => i.id === "snd_13")).toMatchObject({ type: "audio", role: "sound", label: "Music", optional: false });
  });

  it("writes each uploaded sound into its own loader, never leaving the author's file in one", () => {
    const recipe = recipeFromWorkflow(def);
    const built = recipe.build(
      parseInput(recipe, { previousVideo: { asset: "a" }, sound: "c", snd_13: "d" }),
      dryContext({ uploads: { previousVideo: "afflatus_1.mp4 [temp]", sound: "afflatus_3.wav [temp]", snd_13: "afflatus_4.wav [temp]" } }),
    );
    expect(built.graph["12"]!.inputs.audio).toBe("afflatus_3.wav [temp]");
    expect(built.graph["13"]!.inputs.audio).toBe("afflatus_4.wav [temp]");
    expect(built.graph["14"]).toBeUndefined();
    expect(Object.values(built.graph).some((n) => Object.values(n.inputs).some((v) => v === "music.wav" || v === "voice.wav"))).toBe(false);
  });

  it("builds its dry-run variant", () => {
    const recipe = recipeFromWorkflow(def);
    const v = recipe.variants![0]!;
    expect(() => recipe.build(parseInput(recipe, v.input), dryContext({ uploads: v.uploads }))).not.toThrow();
  });
});

describe("a video the workflow works on", () => {
  // an upscale of a video: a loader whose name says nothing of joining, its frames straight into the saver
  const upscale: Graph = {
    "1": { class_type: "VHS_LoadVideo", inputs: { video: "author.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 } },
    "2": { class_type: "VHS_LoadVideo", inputs: { video: "depth.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 }, ...titled("Depth video") },
    "3": { class_type: "ImageBlend", inputs: { image1: ["1", 0], image2: ["2", 0], blend_factor: 0.5, blend_mode: "normal" } },
    "4": { class_type: "VHS_VideoCombine", inputs: { images: ["3", 0], frame_rate: 16, loop_count: 0, filename_prefix: "up", format: "video/h264-mp4", pingpong: false, save_output: true } },
  };
  const found = inspect(upscale, catalog);
  const s = found.suggested!;
  const def: WorkflowDef = { id: "w", title: "t", model: "Wan 2.2", source: "t.json", graph: upscale as WorkflowDef["graph"], bindings: s };

  it("is a source video by default, each one a slot; nothing is carried on in a timeline", () => {
    expect(found.videos.map((v) => v.role)).toEqual(["source", "source"]);
    expect(s.sourceVideo).toMatchObject({ target: { node: "1" }, required: true });
    expect(s.otherVideos.map((v) => [v.id, v.label])).toEqual([["vid_2", "Depth video"]]);
    expect(s.previousVideo).toBeUndefined();
    const recipe = recipeFromWorkflow(def);
    expect(recipe.inputs.find((i) => i.id === "sourceVideo")).toMatchObject({ type: "clip", role: "source", whole: true, optional: false });
    expect(recipe.inputs.find((i) => i.id === "vid_2")).toMatchObject({ type: "clip", role: "source", label: "Depth video" });
    expect(recipe.traits?.continues).not.toBe("clip");
    const built = recipe.build(parseInput(recipe, { sourceVideo: { asset: "a" }, vid_2: { asset: "b" } }), dryContext({ uploads: { sourceVideo: "a.mp4 [temp]", vid_2: "b.mp4 [temp]" } }));
    expect([built.graph["1"]!.inputs.video, built.graph["2"]!.inputs.video]).toEqual(["a.mp4 [temp]", "b.mp4 [temp]"]);
  });
});
