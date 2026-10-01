import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGraph, choicesOf, dryContext, parseInput, pickChoice, schemaFor, type ChoiceInput, type NodeCatalog } from "@studai/core";
import { familyById, h3Canvas, h3Frames, h3Prompt, h3Video, introduce, kleinSize, padsFor, recipeById, recipes, sdxlTextToPicture } from "../src";

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8"),
) as NodeCatalog;

describe("every recipe", () => {
  it("has a unique id that starts with its family, and a known family", () => {
    const ids = recipes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of recipes) {
      expect(familyById(r.family), r.id).toBeDefined();
      expect(r.id.startsWith(`${r.family}.`), r.id).toBe(true);
    }
  });

  it("has unique input ids, and showWhen points at a real input", () => {
    for (const r of recipes) {
      const ids = r.inputs.map((i) => i.id);
      expect(new Set(ids).size, r.id).toBe(ids.length);
      for (const i of r.inputs) {
        const target = typeof i.showWhen === "string" ? i.showWhen : i.showWhen?.input;
        if (target) expect(ids, `${r.id}.${i.id}`).toContain(target);
      }
    }
  });

  it("offers defaults that the node catalog accepts", () => {
    for (const r of recipes) {
      for (const i of r.inputs) {
        if (i.type !== "choice" || Array.isArray(i.options)) continue;
        // a choice among files the user has: its default is only the one preferred, the form starts on one that is there
        if (i.prefer) continue;
        const def = catalog[i.options.node];
        const spec = def?.input.required?.[i.options.input] ?? def?.input.optional?.[i.options.input];
        const choices = [...(i.extra ?? []), ...(choicesOf(spec) ?? [])];
        expect(choices, `${r.id}.${i.id}`).toContain(i.default);
      }
    }
  });

  it("builds every variant into a graph the node catalog accepts", () => {
    for (const r of recipes) {
      expect(r.variants.length, r.id).toBeGreaterThan(0);
      for (const v of r.variants) {
        const input = parseInput(r, v.input);
        const built = r.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas }));
        expect(checkGraph(built, catalog), `${r.id} · ${v.name}`).toEqual([]);
        // what the graph uses is what nodes() says, plus the extras it only takes when ComfyUI has them
        const used = new Set(Object.values(built.graph).map((n) => n.class_type).filter((c) => !r.optionalNodes?.includes(c)));
        expect([...used].sort(), `${r.id} · ${v.name}: nodes()`).toEqual([...new Set(r.nodes(input))].sort());
      }
    }
  });
});

describe("sdxl.text-to-picture", () => {
  const build = (over: Record<string, unknown> = {}) => {
    const input = parseInput(sdxlTextToPicture, { prompt: "a cat", checkpoint: "x.safetensors", ...over });
    return { input, built: sdxlTextToPicture.build(input, dryContext({ seed: 42 })) };
  };
  const nodesOf = (b: ReturnType<typeof build>["built"], cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("uses the resolved seed, never the random marker", () => {
    const { built } = build();
    expect(nodesOf(built, "KSampler").map((n) => n.inputs.seed)).toEqual([42]);
  });

  it("skips LoRAs at weight 0 and chains the others", () => {
    const { built } = build({ loras: [{ file: "a", weight: 0.8 }, { file: "b", weight: 0 }, { file: "c", weight: 1 }] });
    expect(nodesOf(built, "LoraLoader").map((n) => n.inputs.lora_name)).toEqual(["a", "c"]);
  });

  it("adds a second pass for hi-res fix, at the enlarged size", () => {
    const { built } = build({ hires: true, hiresScale: 2, hiresSteps: 12 });
    expect(nodesOf(built, "KSampler")).toHaveLength(2);
    expect(nodesOf(built, "LatentUpscale")[0]!.inputs).toMatchObject({ width: 1664, height: 2432 });
    expect(built.totalSteps).toBe(28 + 12);
  });

  it("puts the model's quality tags in front of the prompt, and nothing when there are none", () => {
    const texts = (b: ReturnType<typeof build>["built"]) => nodesOf(b, "CLIPTextEncode").map((n) => n.inputs.text);
    expect(texts(build().built)[0]).toBe("a cat");
    expect(texts(build({ quality: "masterpiece, best quality, " }).built)[0]).toBe("masterpiece, best quality, a cat");
  });

  it("reports the checkpoint as the model it loads", () => {
    expect(build().built.loads).toEqual(["checkpoints/x.safetensors"]);
  });

  it("rejects unknown inputs", () => {
    expect(schemaFor(sdxlTextToPicture.inputs).safeParse({ prompt: "a", checkpoint: "x", turbo: true }).success).toBe(false);
  });
});

describe("h3.video", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", turbo: "t.safetensors", rife: "r.pth" };
  const clip = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) => {
    const input = parseInput(h3Video, { description: "She waves.", ...over });
    return h3Video.build(input, dryContext({ seed: 7, slots, ...ctx }));
  };
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("counts frames on the model's grid and keeps canvases within what it takes", () => {
    expect([1, 5, 5.2, 10].map(h3Frames)).toEqual([39, 124, 141, 243]);
    for (const n of [2, 5, 9, 15].map(h3Frames)) expect(n % 17).toBe(5);
    expect(h3Canvas(832, 1216, 576)).toEqual({ width: 576, height: 832 });
    expect(h3Canvas(1920, 1080, 768)).toEqual({ width: 1344, height: 768 });
    const big = h3Canvas(1000, 1000, 2000);
    expect(big.width * big.height).toBeLessThanOrEqual(768 * 1344);
  });

  it("writes the prompt in the model's layout, by what the clip opens and ends on", () => {
    const free = h3Prompt("free", 5, { description: "She waves.", soundscape: "wind" });
    expect(free).toBe("integrated_multimodal_description: [Shot 1] She waves.\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A");
    expect(h3Prompt("start", 5, { description: "x" })).toMatch(/^For the target video, at 0\.00 seconds .*<Picture 1>/);
    expect(h3Prompt("both", 5, { description: "x" })).toContain("Picture 2 (from Shot 2) aligns with the 5.17-second mark");
    expect(h3Prompt("land", 5, { description: "x" })).toContain("<Picture 1> (from [Shot 1]) aligns with the 5.17-second mark");
    // a prompt already in the layout is sent as written
    const own = "integrated_multimodal_description: [Shot 1] mine\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
    expect(h3Prompt("start", 5, { description: own })).toBe(own);
  });

  it("is 8 steps with the turbo LoRA, and the full count without it or with Fast off", () => {
    expect(build().totalSteps).toBe(8);
    expect(one(build(), "KSamplerSelect")[0]!.inputs.sampler_name).toBe("euler");
    expect(one(build(), "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 7, shift_audio: 4.5 });
    const slow = build({ fast: false, steps: 20 });
    expect(slow.totalSteps).toBe(20);
    expect(one(slow, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(one(slow, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 11, shift_audio: 4 });
    // Fast asked for but the LoRA is not installed: it runs the slow way instead of failing
    const { turbo: _none, ...without } = slots;
    expect(build({}, { slots: without }).totalSteps).toBe(15);
  });

  it("takes its shape from the picture it opens on, at the size asked for", () => {
    const b = build({ start: "p" }, { uploads: { start: "p.png" }, media: { start: { width: 832, height: 1216 } } });
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 832, length: 124 });
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs.prompt).toMatch(/^For the target video/);
    expect(b.overlap).toBeUndefined();
  });

  it("pins the end of the clip before at its start, is that much longer, and says what to skip", () => {
    const b = build({ previous: { asset: "v" }, start: "p" }, { uploads: { previous: "v.mp4", start: "p.png" }, media: { previous: clip, start: { width: 100, height: 100 } } });
    const guide = one(b, "MiniMaxH3AddGuide");
    expect(guide).toHaveLength(1);
    expect(guide[0]!.inputs).toMatchObject({ frame_idx: 0 });
    expect(guide[0]!.inputs.audio).toBeDefined();
    // 5 s + 22 frames, on the grid; the frame of the clip it joins; the opening picture is not used
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024, length: 158 });
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs.first_frame).toBeUndefined();
    expect(one(b, "LoadImage")).toHaveLength(0);
    expect(b.overlap).toEqual({ headMs: 917, tailMs: 0 });
  });

  it("pins the start of the clip after at its end, without sound when that clip has none", () => {
    const b = build({ next: { asset: "v" } }, { uploads: { next: "v.mp4" }, media: { next: { ...clip, frames: 5, hasSound: false } } });
    const guide = one(b, "MiniMaxH3AddGuide");
    expect(guide[0]!.inputs.frame_idx).toBe(-5);
    expect(guide[0]!.inputs.audio).toBeUndefined();
    expect(b.overlap).toEqual({ headMs: 0, tailMs: 208 });
  });

  it("fits a timeline's frame when it is given one, whatever the picture or the shape say", () => {
    const b = build({ start: "p" }, { uploads: { start: "p.png" }, media: { start: { width: 832, height: 1216 } }, canvas: { width: 1024, height: 576 } });
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 1024, height: 576 });
  });

  it("leaves out the speed-ups ComfyUI does not have, and smoothing without its model", () => {
    const bare = build({ cache: true }, { has: (c) => !["MiniMaxH3Cache", "ModelPatchTorchSettings", "FrameInterpolate"].includes(c) });
    expect(one(bare, "MiniMaxH3Cache")).toHaveLength(0);
    expect(one(bare, "ModelPatchTorchSettings")).toHaveLength(0);
    expect(one(bare, "FrameInterpolate")).toHaveLength(0);
    expect(one(bare, "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(24);
    expect(one(build(), "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(48);
    expect(() => build({ previous: { asset: "v" } }, { uploads: { previous: "v.mp4" }, media: { previous: { ...clip, frames: 10 } } })).toThrow(/22 or 5/);
  });
});

describe("h3.video with references", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", turbo: "t.safetensors", refUnet: "ref.safetensors" };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
    h3Video.build(parseInput(h3Video, { description: "She waves.", references: [{ asset: "r", role: "person" }], ...over }), dryContext({ seed: 7, slots, uploads: { "references.0": "r.png", start: "s.png", voice: "v.wav" }, ...ctx }));
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("uses the reference model, with the usual turbo LoRA when it has none of its own", () => {
    const b = build();
    expect(one(b, "UNETLoader")[0]!.inputs.unet_name).toBe("ref.safetensors");
    expect(one(b, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["t.safetensors"]);
    expect(b.totalSteps).toBe(8);
    const own = build({}, { slots: { ...slots, refTurbo: "rt.safetensors" } });
    expect(one(own, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["rt.safetensors"]);
    expect(one(own, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 7, shift_audio: 4.5 });
  });

  it("says who each picture is, and pins the opening picture at the first frame", () => {
    const b = build({ start: "p", voice: "v", subject: "brown hair", references: [{ asset: "r", role: "person" }, { asset: "t", role: "place" }] }, { uploads: { "references.0": "r.png", "references.1": "t.png", start: "s.png", voice: "v.wav" }, media: { start: { width: 576, height: 1024 } } });
    const node = one(b, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(node.inputs).filter((k) => k.startsWith("ref_images."))).toEqual(["ref_images.ref_image_0", "ref_images.ref_image_1", "ref_images.ref_image_2"]);
    const prompt = String(node.inputs.prompt);
    expect(prompt).toContain("<Subject 1> is the character in <Picture 1>, brown hair.");
    expect(prompt).toContain("<Subject 2> is the location shown in <Picture 2>.");
    expect(prompt).toContain("<Audio 1> is the voice-timbre reference for <Subject 1> (S1).");
    expect(prompt).toContain("<Picture 3> is the opening-frame anchor for [Shot 1].");
    expect(prompt).toContain("[keyframe completion + reference generation + audio reference]");
    expect(one(b, "MiniMaxH3AddGuide").map((n) => n.inputs.frame_idx)).toEqual([0]);
  });

  it("is refused in words when the reference model is not installed, and the step cache stays off with Fast", () => {
    const { refUnet: _none, ...without } = slots;
    expect(() => build({}, { slots: without })).toThrow(/reference model/);
    expect(one(build({ cache: true }), "MiniMaxH3Cache")).toHaveLength(0);
    expect(one(build({ cache: true, fast: false }), "MiniMaxH3Cache")).toHaveLength(1);
  });
});

describe("things done to a picture", () => {
  it("start on a file that is there when the preferred one is not", () => {
    const upscaler = recipeById("sdxl.sharper")!.inputs.find((i) => i.id === "upscaler") as ChoiceInput;
    expect(pickChoice(upscaler, ["a.pth", "4x-UltraSharp.pth"])).toBe("4x-UltraSharp.pth");
    expect(pickChoice(upscaler, ["RealESRGAN_x4plus_anime_6B.pth", "RealESRGAN_x4plus.pth"])).toBe("RealESRGAN_x4plus.pth");
    expect(pickChoice(upscaler, ["anime_only.pth"])).toBe("anime_only.pth");
    // nothing offered (ComfyUI not asked yet): the default stands
    expect(pickChoice(upscaler, [])).toBe("4x-UltraSharp.pth");
    const finder = recipeById("klein.fix-face")!.inputs.find((i) => i.id === "detector") as ChoiceInput;
    expect(pickChoice(finder, ["bbox/hand_yolov8s.pt", "bbox/face_yolov8n.pt"])).toBe("bbox/face_yolov8n.pt");
  });

  it("tell FLUX.2 Klein which picture is which", () => {
    expect(introduce([])).toBe("");
    expect(introduce([{ asset: "a", role: "person" }, { asset: "b", role: "person" }, { asset: "c", role: "place" }])).toBe(
      "Pictures 1 to 2 show who is in it; Picture 3 shows the place: the scene is there. Keep each person's face, hair and build exactly as in their pictures.",
    );
    expect(introduce([{ asset: "c", role: "clothing" }], 2)).toBe("Picture 2 shows what is worn.");
  });

  it("work at about a megapixel, and add room evenly to change a shape", () => {
    expect(kleinSize({ width: 3000, height: 2000 })).toEqual({ width: 1248, height: 832 });
    expect(kleinSize(undefined)).toEqual({ width: 1024, height: 1024 });
    expect(padsFor(600, 900, "Square 1:1")).toEqual({ left: 150, right: 150, top: 0, bottom: 0, width: 900, height: 900 });
    expect(padsFor(1600, 900, "Phone 9:16")).toMatchObject({ left: 0, right: 0, top: 972, bottom: 972, width: 1600, height: 2844 });
    // already that shape: nothing to add
    expect(padsFor(1600, 900, "Widescreen 16:9")).toMatchObject({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("go over an enlarged picture only when it is small enough", () => {
    const sharper = recipeById("klein.sharper")!;
    const slots = { unet: "k.safetensors", clip: "q.safetensors", vae: "v.safetensors" };
    const build = (width: number, height: number) =>
      sharper.build(parseInput(sharper, { source: "p", upscaler: "u.pth" }), dryContext({ slots, uploads: { source: "s.png" }, media: { source: { width, height } } }));
    const small = build(640, 960);
    expect(Object.values(small.graph).some((n) => n.class_type === "SamplerCustomAdvanced")).toBe(true);
    // a quarter of the steps: only the end of them is run
    expect(small.totalSteps).toBe(5);
    expect(small.loads).toContain("diffusion_models/k.safetensors");
    const large = build(1536, 2048);
    expect(Object.values(large.graph).some((n) => n.class_type === "SamplerCustomAdvanced")).toBe(false);
    expect(large.loads).toEqual(["upscale_models/u.pth"]);
  });
});

describe("fixing faces with FLUX.2 Klein", () => {
  const fix = recipeById("klein.fix-face")!;
  const slots = { unet: "k.safetensors", clip: "q.safetensors", vae: "v.safetensors" };
  const graphOf = (input: Record<string, unknown>, uploads: Record<string, string>) =>
    Object.values(fix.build(parseInput(fix, { source: "p", detector: "bbox/face.pt", ...input }), dryContext({ slots, uploads: { source: "s.png", ...uploads } })).graph);

  it("redraws the left face from the first person's pictures and the right one from the second's", () => {
    const graph = graphOf(
      { references: [{ asset: "a", role: "person" }], second: [{ asset: "b", role: "person" }, { asset: "c", role: "person" }] },
      { "references.0": "left.png", "second.0": "right1.png", "second.1": "right2.png" },
    );
    const byId = Object.fromEntries(Object.entries(fix.build(parseInput(fix, { source: "p", detector: "bbox/face.pt", references: [{ asset: "a", role: "person" }], second: [{ asset: "b", role: "person" }] }), dryContext({ slots, uploads: { source: "s.png", "references.0": "left.png", "second.0": "right.png" } })).graph));
    expect(graph.filter((n) => n.class_type === "FaceDetailer")).toHaveLength(0);
    const picks = graph.filter((n) => n.class_type === "ImpactSEGSOrderedFilter");
    // the two largest faces, then each of them by its place from the left
    expect(picks.map((n) => [n.inputs.target, n.inputs.order, n.inputs.take_start, n.inputs.take_count])).toEqual([
      ["area(=w*h)", true, 0, 2], ["x1", false, 0, 1], ["x1", false, 1, 1],
    ]);
    const passes = graph.filter((n) => n.class_type === "DetailerForEach");
    expect(passes).toHaveLength(2);
    // the second pass works on what the first one gave back
    expect(Object.values(byId).filter((n) => n.class_type === "DetailerForEach")[1]!.inputs.image).toEqual([Object.keys(byId).find((id) => byId[id]!.class_type === "DetailerForEach"), 0]);
    // each pass follows its own person's pictures: one reference for the left, two for the right
    const loaded = graph.filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
    expect(loaded).toEqual(["s.png", "left.png", "right1.png", "right2.png"]);
  });

  it("with one list of pictures, redraws every face from it, whichever list it is", () => {
    const first = graphOf({ references: [{ asset: "a", role: "person" }] }, { "references.0": "one.png" });
    const second = graphOf({ second: [{ asset: "a", role: "person" }] }, { "second.0": "one.png" });
    for (const graph of [first, second]) {
      expect(graph.filter((n) => n.class_type === "FaceDetailer")).toHaveLength(1);
      expect(graph.filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image)).toEqual(["s.png", "one.png"]);
    }
  });
});
