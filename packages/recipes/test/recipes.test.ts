import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGraph, choicesOf, dryContext, joinFrames, joinKindOf, madeAroundRecording, recordingSpecOf, parseInput, pickChoice, ruledDefaults, schemaFor, type ChoiceInput, type NodeCatalog, type Wanted } from "@afflatus/core";
import { seedvrChunk, families, familyById, krea2Picture, h3Canvas, h3Frames, h3Prompt, h3Video, introduce, kleinSize, padsFor, recipeById, recipes, sdxlTextToPicture, wanCanvas, wanFrames, wanVideo, ltxCanvas, ltxFrames, ltxLipSync, ltxVideo, ltx25LipSync, LTX_REFINE_SIGMAS, LTX_SIGMAS, fluxEdit, fluxPicture, qwenEdit, qwenPicture, flux, qwen, wan, ltx, zimage, zimagePicture } from "../src";

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

  it("puts in each phase the kind of node its label says, in every variant", () => {
    // what the status strip and the render times call each phase has to be true of what runs in it
    const kinds: Record<string, RegExp> = {
      sampling: /Sampler/, refining: /Sampler|UltimateUpscale/, restoring: /SeedVR2|KSampler/, detailing: /Detailer/, processing: /RemoveBackground|Canny|Preprocessor|SAM3_VideoTrack|SwapMask|SDPose|RTDETR/,
      upscaling: /Upscale|Upsampler|SuperRes|Resize|Rebatch|Params|SeedVR2|VAEEncodeTiled|VAELoader|UNETLoader|LoadImage|ImageScale|LTXVPreprocess|LTXVImgToVideoInplace|VAEDecode|VAEEncode|PreviewImage|LatentUpscaleModelLoader|UpscaleModelLoader|RTX/,
      decoding: /Decode|PreviewImage|FrameInterpolationModelLoader/, interpolating: /Interpolat|Upsampler|LatentUpscaleModelLoader|Sampler|Sigmas|Noise|Guider|Latent/, encoding: /VideoCombine|CreateVideo|SaveVideo|PreviewImage/,
    };
    for (const r of recipes) for (const v of r.variants) {
      const input = parseInput(r, v.input);
      const built = r.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) }));
      const byPhase = new Map<string, string[]>();
      for (const [id, phase] of Object.entries(built.phases)) byPhase.set(phase, [...(byPhase.get(phase) ?? []), built.graph[id]!.class_type]);
      for (const [phase, classes] of byPhase) {
        if (phase === "loading") continue;
        const kind = kinds[phase];
        expect(kind, `${r.id} · ${v.name}: phase "${phase}" is not one the labels know`).toBeDefined();
        // the phase holds at least one node of its kind, and nothing that plainly belongs to another phase
        expect(classes.some((c) => kind!.test(c)), `${r.id} · ${v.name}: phase "${phase}" holds ${classes.join(", ")}`).toBe(true);
        if (phase === "sampling" || phase === "refining") expect(classes.some((c) => /Sampler(Custom)?(Advanced)?$|^KSampler|UltimateUpscale/.test(c)), `${r.id} · ${v.name}: "${phase}" without a sampler: ${classes.join(", ")}`).toBe(true);
      }
    }
  });

  it("builds every variant into a graph the node catalog accepts", () => {
    for (const r of recipes) {
      expect(r.variants.length, r.id).toBeGreaterThan(0);
      for (const v of r.variants) {
        const input = parseInput(r, v.input);
        const built = r.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) }));
        expect(checkGraph(built, catalog), `${r.id} · ${v.name}`).toEqual([]);
        // what the graph uses is what nodes() says, plus the extras it only takes when ComfyUI has them or the server sends
        // them (a node can be both: LTX's LoadImage, for a picture asked for and for the clip before's look, sent or not; Wan's
        // WanImageToVideo, a way its continuation is made and the node of a clip opening on a picture)
        const used = new Set(Object.values(built.graph).map((n) => n.class_type).filter((c) => !r.optionalNodes?.includes(c)));
        expect([...used].sort(), `${r.id} · ${v.name}: nodes()`).toEqual([...new Set(r.nodes(input).filter((c) => !r.optionalNodes?.includes(c)))].sort());
      }
    }
  });
});

describe("every recipe, its inputs as parsed", () => {
  const ctxOf = (v: (typeof recipes)[number]["variants"][number], has?: (n: string) => boolean) =>
    dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(has ?? v.has ? { has: has ?? v.has } : {}) });

  it("are the form's inputs and nothing else: what build() and nodes() read is an input the form has", () => {
    // the parsed values are cast to the recipe's own interface: a field the interface has and the form does not is always undefined
    for (const r of recipes) {
      const ids = new Set(r.inputs.map((i) => i.id));
      for (const v of r.variants) {
        const parsed = parseInput(r, v.input) as Record<string, unknown>;
        expect(Object.keys(parsed).filter((k) => !ids.has(k)), `${r.id} · ${v.name}: parsed`).toEqual([]);
        // every input comes out of the parse, unless it may be left out (a picture not given, a model left to its slot)
        const absent = [...ids].filter((id) => !(id in parsed));
        for (const id of absent) expect(schemaFor(r.inputs.filter((i) => i.id === id)).safeParse({}).success, `${r.id}.${id} is required and missing`).toBe(true);
        const read = new Set<string>();
        const watched = new Proxy(parsed, { get: (o, k) => (typeof k === "string" && read.add(k), Reflect.get(o, k)), has: (o, k) => (typeof k === "string" && read.add(k), Reflect.has(o, k)) });
        r.nodes(watched);
        r.build(watched, ctxOf(v));
        expect([...read].filter((k) => !ids.has(k)), `${r.id} · ${v.name}: read`).toEqual([]);
      }
    }
  });

  it("list in optionalNodes only what some variant does without, or what this ComfyUI may lack", () => {
    // an optional node every variant uses, and that stays when ComfyUI does not have it, is a node the recipe needs:
    // it belongs in nodes(), where it is checked before queueing (listed as optional, nothing checked it)
    for (const r of recipes) {
      const built = r.variants.map((v) => ({ v, classes: new Set(Object.values(r.build(parseInput(r, v.input), ctxOf(v)).graph).map((n) => n.class_type)) }));
      for (const node of r.optionalNodes ?? []) {
        if (!built.every((b) => b.classes.has(node))) continue;
        const { v } = built[0]!;
        const base = v.has ?? (() => true);
        let stays = false;
        try {
          stays = Object.values(r.build(parseInput(r, v.input), ctxOf(v, (n) => n !== node && base(n))).graph).some((n) => n.class_type === node);
        } catch {
          /* refused in words without it: optional is right */
        }
        expect(stays, `${r.id}: ${node} is used by every variant, with or without it in ComfyUI`).toBe(false);
      }
    }
  });

  it("a free size is held within the most pixels its model takes, max × max typed or saved (review K-4)", () => {
    let checked = 0;
    for (const r of recipes) {
      const spec = r.inputs.find((i) => i.type === "size" && !i.ratioOnly && i.maxPixels) as Extract<(typeof r.inputs)[number], { type: "size" }> | undefined;
      if (!spec) continue;
      const most = spec.maxPixels!;
      for (const typed of [{ width: spec.max, height: spec.max }, { width: spec.max, height: spec.min }]) {
        const parsed = (parseInput(r, { ...r.variants[0]!.input, [spec.id]: typed }) as Record<string, { width: number; height: number }>)[spec.id]!;
        expect(parsed.width * parsed.height, `${r.id} ${typed.width}×${typed.height}`).toBeLessThanOrEqual(most);
        expect(parsed.width % spec.grid + (parsed.height % spec.grid), r.id).toBe(0);
        // the proportions kept, within a step of the grid
        expect(Math.abs(parsed.width / parsed.height - typed.width / typed.height), r.id).toBeLessThan(0.05 * (typed.width / typed.height));
      }
      // a size within it is left as it is
      const shape = spec.shapes[0]!;
      expect((parseInput(r, { ...r.variants[0]!.input, [spec.id]: { width: shape.width, height: shape.height } }) as Record<string, unknown>)[spec.id]).toEqual({ width: shape.width, height: shape.height });
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("a slot used by one recipe alone names it, and Swap's files are only Swap's (review K-9; Veda's predictor since 2026-10-17)", () => {
    for (const f of families) for (const slot of f.slots) for (const id of slot.onlyFor ?? []) expect(recipeById(id), `${f.id}.${slot.id} → ${id}`).toBeDefined();
    const h3Slots = families.find((f) => f.id === "h3")!.slots;
    expect(h3Slots.filter((x) => x.onlyFor?.includes("h3.swap")).map((x) => x.id)).toEqual(["swapUnet", "swapLora", "swapSam", "veda"]);
  });

  it("Colour match leaves out a First frame the clip does not use, carrying on from a Previous clip (review K-6)", () => {
    let checked = 0;
    for (const r of recipes) {
      if (!r.inputs.some((i) => i.id === "colourMatch") || !r.inputs.some((i) => i.id === "start")) continue;
      for (const v of r.variants) {
        if (!(v.input as Record<string, unknown>).previous) continue;
        const input = parseInput(r, { ...v.input, start: "p", colourMatch: true });
        const ctx = dryContext({ slots: v.slots ?? {}, uploads: { ...v.uploads, start: "zz-unrelated.png" }, media: { ...v.media, start: { width: 640, height: 640 } }, canvas: v.canvas });
        const graph = r.build(input, ctx).graph;
        // a match to anything else (Wan's to the clip before, through SVI) is not this one
        const toPicture = (n: { inputs: Record<string, unknown> }) => graph[(n.inputs.image_ref as [string, number])[0]]?.class_type === "LoadImage";
        expect(Object.values(graph).filter((n) => n.class_type === "ColorTransfer" && toPicture(n)), `${r.id} · ${v.name}`).toEqual([]);
        expect(Object.values(graph).some((n) => n.inputs.image === "zz-unrelated.png"), `${r.id} · ${v.name}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1);
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
    const { built } = build({ hires: true, hiresScale: 2, hiresSteps: 12, hiresUpscaler: "latent" });
    expect(nodesOf(built, "KSampler")).toHaveLength(2);
    expect(nodesOf(built, "LatentUpscale")[0]!.inputs).toMatchObject({ width: 1664, height: 2432 });
    expect(built.totalSteps).toBe(28 + 12);
    // left alone, an upscale model: the enlarged latent is noisy and asks for a denoise that redraws
    expect(nodesOf(build({ hires: true }).built, "ImageUpscaleWithModel")).toHaveLength(1);
    expect(nodesOf(build({ hires: true }).built, "KSampler")[1]!.inputs.denoise).toBe(0.45);
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
    // the nearest count the model takes, unless that is more than four frames short: 1 s is 22 (two short), 5.9 s is 141 (one over), 4 s is 107 (90 would be six short)
    expect([1, 5, 5.2, 5.9, 4, 10].map(h3Frames)).toEqual([22, 124, 124, 141, 107, 243]);
    for (const n of [2, 5, 9, 15].map(h3Frames)) expect(n % 17).toBe(5);
    expect(h3Canvas(832, 1216, 576)).toEqual({ width: 576, height: 832 });
    expect(h3Canvas(1920, 1080, 768)).toEqual({ width: 1344, height: 768 });
    const big = h3Canvas(1000, 1000, 2000);
    expect(big.width * big.height).toBeLessThanOrEqual(768 * 1344);
  });

  it("picks the sampler and the shifts from the steps, unless they are set in the form", () => {
    const of = (b: ReturnType<typeof build>) => ({
      sampler: one(b, "KSamplerSelect")[0]!.inputs.sampler_name,
      scheduler: one(b, "BasicScheduler")[0]!.inputs.scheduler,
      video: one(b, "MiniMaxH3SigmaShift")[0]!.inputs.shift_video,
      audio: one(b, "MiniMaxH3SigmaShift")[0]!.inputs.shift_audio,
    });
    // left alone: what suits a turbo's few steps, and what suits full steps
    expect(of(build({ fast: true }))).toEqual({ sampler: "euler", scheduler: "simple", video: 12, audio: 3 });
    expect(of(build({ fast: false }))).toEqual({ sampler: "res_multistep", scheduler: "simple", video: 11, audio: 4 });
    // the turbo LoRA runs the form's numbers, whatever its name says
    const four = build({ fast: true }, { slots: { ...slots, turbo: "minimax_h3_fl2v_turbo_4step_v1.0_768p.safetensors" } });
    expect(of(four)).toMatchObject({ video: 12, audio: 3 });
    expect(one(four, "BasicScheduler")[0]!.inputs.steps).toBe(8);
    // 0, from drafts saved before the form showed the numbers: left alone, so what the form starts on (Turbo: 12 / 3)
    const old = build({ fast: true, turboSteps: 0, shiftVideo: 0, shiftAudio: 0 });
    expect(of(old)).toMatchObject({ video: 12, audio: 3 });
    expect(one(old, "BasicScheduler")[0]!.inputs.steps).toBe(8);
    expect(of(build({ fast: false, shiftVideo: 0 }))).toMatchObject({ video: 11, audio: 4 });
    // set in the form: used as they are, with Turbo or without
    const own = { sampler: "dpmpp_2m", scheduler: "beta", shiftVideo: 9, shiftAudio: 3.5 };
    expect(of(build({ fast: true, ...own }))).toEqual({ sampler: "dpmpp_2m", scheduler: "beta", video: 9, audio: 3.5 });
    expect(of(build({ fast: false, ...own }))).toEqual({ sampler: "dpmpp_2m", scheduler: "beta", video: 9, audio: 3.5 });
    // one of the two shifts alone
    expect(of(build({ fast: true, shiftAudio: 6 }))).toMatchObject({ video: 12, audio: 6 });
    // the steps Turbo takes are a setting: the LoRA's name, else 8, unless set
    const steps = (b: ReturnType<typeof build>) => one(b, "BasicScheduler")[0]!.inputs.steps;
    expect(steps(build({ fast: true }))).toBe(8);
    expect(steps(build({ fast: true, turboSteps: 6 }))).toBe(6);
    expect(steps(build({ fast: false, turboSteps: 6 }))).toBe(20);
  });

  it("writes the prompt in the model's layout, by what the clip opens and ends on", () => {
    const free = h3Prompt("free", 5, { description: "She waves.", soundscape: "wind" });
    expect(free).toBe("integrated_multimodal_description: [Shot 1] She waves.\n\noverall_soundscape: wind\n\nnon_diegetic_music: N/A");
    expect(h3Prompt("start", 5, { description: "x" })).toMatch(/^For the target video, at 0\.00 seconds .*<Picture 1>/);
    expect(h3Prompt("both", 5, { description: "x" })).toContain("Picture 2 (from Shot 1) aligns with the 5.17-second mark");
    expect(h3Prompt("land", 5, { description: "x" })).toContain("<Picture 1> (from [Shot 1]) aligns with the 5.17-second mark");
    // a prompt already in the layout is sent as written
    const own = "integrated_multimodal_description: [Shot 1] mine\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
    expect(h3Prompt("start", 5, { description: own })).toBe(own);
  });

  it("is 8 steps with the turbo LoRA, and the full count (20, left alone) without it or with Fast off", () => {
    expect(build().totalSteps).toBe(20);
    const fast = build({ fast: true });
    expect(fast.totalSteps).toBe(8);
    expect(one(fast, "KSamplerSelect")[0]!.inputs.sampler_name).toBe("euler");
    expect(one(fast, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 12, shift_audio: 3 });
    const slow = build({ fast: false, steps: 25 });
    expect(slow.totalSteps).toBe(25);
    expect(one(slow, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(one(slow, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 11, shift_audio: 4 });
    // Fast asked for but the LoRA is not installed: it runs the slow way instead of failing
    const { turbo: _none, ...without } = slots;
    expect(build({ fast: true }, { slots: without }).totalSteps).toBe(20);
  });

  it("stays within the 362 frames the model was trained on, joins included", () => {
    expect(one(build({ seconds: 15 }), "MiniMaxH3ImageToVideo")[0]!.inputs.length).toBe(362);
    const long = { ...clip, frames: 39 };
    const joined = build({ seconds: 15, previous: { asset: "a" }, next: { asset: "b" } }, { uploads: { previous: "a.mp4", next: "b.mp4" }, media: { previous: clip, next: long } });
    expect(one(joined, "MiniMaxH3ImageToVideo")[0]!.inputs.length).toBe(362);
    expect(joined.overlap).toEqual({ headMs: Math.round((22 / 24) * 1000), tailMs: Math.round((39 / 24) * 1000) });
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
    expect(one(b, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024, length: 141 });
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
    // a canvas gives the shape, the form the size: a clip opening on a large picture on a 1080p timeline is still 576p
    const big = build({ start: "p", short: 576 }, { uploads: { start: "p.png" }, media: { start: { width: 3024, height: 4032 } }, canvas: { width: 1080, height: 1920 } });
    expect(one(big, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024 });
    // a clip carried on keeps the clip before's own size, the canvas's shape
    const carried = build({ previous: { asset: "v" } }, { uploads: { previous: "v.mp4" }, media: { previous: clip }, canvas: { width: 1080, height: 1920 } });
    expect(one(carried, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024 });
  });

  it("leaves out the speed-ups ComfyUI does not have, and smoothing without its model", () => {
    const bare = build({ cache: true }, { has: (c) => !["MiniMaxH3Cache", "ModelPatchTorchSettings", "FrameInterpolate"].includes(c) });
    expect(one(bare, "MiniMaxH3Cache")).toHaveLength(0);
    expect(one(bare, "ModelPatchTorchSettings")).toHaveLength(0);
    expect(one(bare, "FrameInterpolate")).toHaveLength(0);
    expect(one(bare, "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(24);
    expect(one(build(), "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(48);
    expect(() => build({ previous: { asset: "v" } }, { uploads: { previous: "v.mp4" }, media: { previous: { ...clip, frames: 10 } } })).toThrow(/5, 22 or 39/);
  });
});

describe("h3.video with references", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", turbo: "t.safetensors", refUnet: "ref.safetensors" };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
    h3Video.build(parseInput(h3Video, { description: "She waves.", fast: true, references: [{ asset: "r", role: "person" }], ...over }), dryContext({ seed: 7, slots, uploads: { "references.0": "r.png", start: "s.png", voice: "v.wav" }, ...ctx }));
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("uses the reference model, with the usual turbo LoRA when it has none of its own", () => {
    const b = build();
    expect(one(b, "UNETLoader")[0]!.inputs.unet_name).toBe("ref.safetensors");
    expect(one(b, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["t.safetensors"]);
    expect(b.totalSteps).toBe(8);
    const own = build({}, { slots: { ...slots, refTurbo: "rt.safetensors" } });
    expect(one(own, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["rt.safetensors"]);
    expect(one(own, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 12, shift_audio: 3 });
    // its own 4-step LoRA: the form starts the steps and shifts on what it was made for, and the render runs them
    const refFour = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors";
    const form = { fast: true, references: [{ asset: "r", role: "person" }], hybrid: "From the name" };
    expect(ruledDefaults(h3Video.starts, form, { ...slots, refTurbo: refFour })).toEqual({ turboSteps: 4, shiftVideo: 6, shiftAudio: 3 });
    // not with a hybrid model (it takes the references itself), without references, with Turbo off, or with the usual LoRA alone
    expect(ruledDefaults(h3Video.starts, form, { ...slots, unet: "dasiwaHybridTurboV3.safetensors", refTurbo: refFour })).toEqual({});
    expect(ruledDefaults(h3Video.starts, { ...form, references: [] }, { ...slots, refTurbo: refFour })).toEqual({});
    expect(ruledDefaults(h3Video.starts, { ...form, fast: false }, { ...slots, refTurbo: refFour })).toEqual({});
    expect(ruledDefaults(h3Video.starts, form, slots)).toEqual({});
    const four = build({ turboSteps: 4, shiftVideo: 6 }, { slots: { ...slots, refTurbo: refFour } });
    expect(four.totalSteps).toBe(4);
    expect(one(four, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 6, shift_audio: 3 });
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

describe("h3.video: watching it form, and videos of the person", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", turbo: "t.safetensors", refUnet: "ref.safetensors" };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
    h3Video.build(parseInput(h3Video, { description: "She waves.", ...over }), dryContext({ seed: 7, slots, ...ctx }));
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("sends an animated preview each step when the node for it is there, with the tiny VAE when that is there too", () => {
    const b = build();
    const node = one(b, "ModelPreviewOverrideKJ")[0]!;
    expect(node.inputs).toMatchObject({ preview_frames: 16, preview_fps: 12, max_resolution: 512, suppress_default_preview: true, tiny_vae: "none" });
    // it sits on the model the sampler runs, and is given the sound decoder for the sound so far
    expect(one(b, "BasicGuider")[0]!.inputs.model).toEqual([Object.entries(b.graph).find(([, n]) => n === node)![0], 0]);
    expect(node.inputs.audio_vae).toBeDefined();
    expect(one(build({}, { slots: { ...slots, tinyVae: "taeh3.safetensors" } }), "ModelPreviewOverrideKJ")[0]!.inputs.tiny_vae).toBe("taeh3.safetensors");
    // turned off, or without the node: the render is the same without it
    expect(one(build({ livePreview: false }), "ModelPreviewOverrideKJ")).toHaveLength(0);
    expect(one(build({}, { has: (c: string) => c !== "ModelPreviewOverrideKJ" }), "ModelPreviewOverrideKJ")).toHaveLength(0);
  });

  it("takes videos of the person next to the pictures: their frames, and their sound as the voice", () => {
    const media = { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: false } };
    const uploads = { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "references.0": "p.png", voice: "v.wav" };
    const b = build({ refVideos: [{ asset: "v1", role: "person" }, { asset: "v2", role: "person" }], references: [{ asset: "r", role: "place" }] }, { uploads, media });
    expect(one(b, "UNETLoader")[0]!.inputs.unet_name).toBe("ref.safetensors");
    const node = one(b, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(node.inputs).filter((k) => /^ref_(videos|images|video_audios)\./.test(k)).sort()).toEqual(["ref_images.ref_image_0", "ref_video_audios.ref_video_audio_0", "ref_videos.ref_video_0", "ref_videos.ref_video_1"]);
    expect(one(b, "LoadVideo").map((n) => n.inputs.file)).toEqual(["a.mp4", "b.mp4"]);
    const prompt = String(node.inputs.prompt);
    // the videos are who the person is; the first one's sound is their voice; the picture is the place
    expect(prompt).toContain("<Subject 1> is the character in <Video 1> and <Video 2>.");
    expect(prompt).toContain("<Audio 1> is the soundtrack of <Video 1>: the voice of <Subject 1> (S1).");
    expect(prompt).toContain("<Subject 2> is the location shown in <Picture 1>.");
    expect(prompt).toContain("[reference generation + video reference + audio reference]");
    expect(prompt).toContain("<Audio 1>: reference - the voice timbre is followed without copying the signal.");

    // with a voice sample, that is the voice: the videos' sound is left out, and the sample is the only <Audio>
    const voiced = build({ refVideos: [{ asset: "v1", role: "person" }], voice: "s" }, { uploads, media });
    const v = one(voiced, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(v.inputs).filter((k) => /audio_\d/.test(k))).toEqual(["ref_audios.ref_audio_0"]);
    expect(String(v.inputs.prompt)).toContain("<Audio 1> is the voice-timbre reference for <Subject 1> (S1).");
    expect(String(v.inputs.prompt)).not.toContain("soundtrack");
    // a video takes the pictures' roles, no other
    expect(() => parseInput(h3Video, { description: "a", refVideos: [{ asset: "v", role: "voice" }] })).toThrow();
    expect(() => parseInput(h3Video, { description: "a", refVideos: [1, 2, 3, 4].map((n) => ({ asset: `v${n}`, role: "person" })) })).toThrow();
  });

  it("takes a video of a place, clothes, an object or a look as its own subject, and only a person's video gives its sound (card #86)", () => {
    const sounding = { width: 384, height: 682, frames: 72, fps: 24, hasSound: true };
    const media = { "refVideos.0": sounding, "refVideos.1": sounding, "refVideos.2": sounding };
    const uploads = { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "refVideos.2": "c.mp4" };
    const b = build({ refVideos: [{ asset: "v1", role: "place" }, { asset: "v2", role: "person" }, { asset: "v3", role: "style" }] }, { uploads, media });
    const node = one(b, "MiniMaxH3ReferenceToVideo")[0]!;
    // the three videos go in, the person's sound only, by its own number
    expect(Object.keys(node.inputs).filter((k) => /^ref_(videos|video_audios)\./.test(k)).sort()).toEqual(["ref_video_audios.ref_video_audio_1", "ref_videos.ref_video_0", "ref_videos.ref_video_1", "ref_videos.ref_video_2"]);
    const prompt = String(node.inputs.prompt);
    expect(prompt).toContain("<Subject 1> is the character in <Video 2>.");
    expect(prompt).toContain("<Subject 2> is the location shown in <Video 1>.");
    expect(prompt).toContain("<Subject 3> is the visual style of <Video 3>.");
    expect(prompt).toContain("<Audio 1> is the soundtrack of <Video 2>: the voice of <Subject 1> (S1).");
    expect(prompt).not.toContain("<Audio 2>");

    // a place's video alone: no sound goes in, and no audio reference is said
    const alone = one(build({ refVideos: [{ asset: "v1", role: "place" }] }, { uploads, media }), "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(alone.inputs).filter((k) => /audio_\d/.test(k))).toEqual([]);
    expect(String(alone.inputs.prompt)).not.toContain("audio reference");
    expect(String(alone.inputs.prompt)).not.toContain("<Subject 1> is the character");
  });
});

describe("h3.video with another H3 model", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", turbo: "t.safetensors", refUnet: "ref.safetensors" };
  const refs = { references: [{ asset: "r", role: "person" }] };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
    h3Video.build(parseInput(h3Video, { description: "She waves.", fast: true, ...over }), dryContext({ seed: 7, slots, uploads: { "references.0": "r.png" }, ...ctx }));
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const unet = (b: ReturnType<typeof build>) => one(b, "UNETLoader")[0]!.inputs.unet_name;
  const loras = (b: ReturnType<typeof build>) => one(b, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name);

  it("is the usual one when none is picked, or when the usual one is picked", () => {
    expect(unet(build())).toBe("u.safetensors");
    const same = build({ model: "u.safetensors" });
    expect(unet(same)).toBe("u.safetensors");
    expect(loras(same)).toEqual(["t.safetensors"]);
    expect(unet(build({ model: "u.safetensors", ...refs }))).toBe("ref.safetensors");
  });

  it("a fine-tune is loaded in its place: Fast still adds the turbo LoRA, references still go to MiniMax's reference model", () => {
    const b = build({ model: "sub\\SomeoneH3_v3.safetensors" });
    expect(unet(b)).toBe("sub\\SomeoneH3_v3.safetensors");
    expect(loras(b)).toEqual(["t.safetensors"]);
    expect(b.totalSteps).toBe(8);
    expect(b.loads).toContain("diffusion_models/sub\\SomeoneH3_v3.safetensors");
    expect(unet(build({ model: "SomeoneH3_v3.safetensors", ...refs }))).toBe("ref.safetensors");
  });

  it("a turbo one gets no turbo LoRA and few steps: 8 with Fast, the steps typed without", () => {
    const b = build({ model: "SomeoneH3_TurboV3.safetensors" });
    expect(loras(b)).toEqual([]);
    expect(b.totalSteps).toBe(8);
    expect(one(b, "KSamplerSelect")[0]!.inputs.sampler_name).toBe("euler");
    expect(one(b, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 12, shift_audio: 3 });
    expect(b.loads.some((l) => l.startsWith("loras/"))).toBe(false);
    expect(build({ model: "SomeoneH3_TurboV3.safetensors", fast: false, steps: 4 }).totalSteps).toBe(4);
    // the step cache is for full renders
    expect(one(build({ model: "SomeoneH3_TurboV3.safetensors", fast: false, steps: 6, cache: true }), "MiniMaxH3Cache")).toHaveLength(0);
    // the user's own LoRAs still go on it
    expect(loras(build({ model: "SomeoneH3_TurboV3.safetensors", loras: [{ file: "mine.safetensors", weight: 0.7 }] }))).toEqual(["mine.safetensors"]);
  });

  it("a hybrid one follows references itself, with no reference model installed", () => {
    const { refUnet: _none, ...without } = slots;
    const b = build({ model: "SomeoneH3_hybridV3.safetensors", ...refs }, { slots: without });
    expect(unet(b)).toBe("SomeoneH3_hybridV3.safetensors");
    expect(one(b, "MiniMaxH3ReferenceToVideo")).toHaveLength(1);
    expect(loras(b)).toEqual(["t.safetensors"]);
    // a hybrid turbo one: one file, no LoRA at all
    expect(loras(build({ model: "SomeoneH3_hybridTurboV3.safetensors", ...refs }, { slots: without }))).toEqual([]);
    expect(() => build({ model: "SomeoneH3_v3.safetensors", ...refs }, { slots: without })).toThrow(/hybrid model/);
  });

  it("is read from its name too when it is the usual model itself: MiniMax's own files are not installed", () => {
    const only = { ...slots, unet: "SomeoneH3_hybridTurboV3.safetensors", refUnet: "SomeoneH3_hybridTurboV3.safetensors" };
    const plain = build({}, { slots: only });
    expect(unet(plain)).toBe("SomeoneH3_hybridTurboV3.safetensors");
    expect(loras(plain)).toEqual([]);
    expect(loras(build(refs, { slots: only }))).toEqual([]);
    // told it is no hybrid, the clip goes to the reference slot, which is that same turbo file: still no LoRA
    expect(loras(build({ ...refs, hybrid: "No" }, { slots: only }))).toEqual([]);
  });

  it("what the name says can be overruled, and saved for the model", () => {
    // named like nothing, said to be both
    const said = build({ model: "mystery.safetensors", turboIn: "Yes", hybrid: "Yes", ...refs });
    expect(unet(said)).toBe("mystery.safetensors");
    expect(loras(said)).toEqual([]);
    // named turbo and hybrid, said to be neither
    const not = build({ model: "SomeoneH3_hybridTurboV3.safetensors", turboIn: "No", hybrid: "No", ...refs });
    expect(unet(not)).toBe("ref.safetensors");
    expect(loras(not)).toEqual(["t.safetensors"]);
    expect(h3Video.inputs.filter((i) => i.perModel).map((i) => i.id)).toEqual(["fast", "turboSteps", "steps", "sampler", "scheduler", "shiftVideo", "shiftAudio", "turboIn", "hybrid"]);
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

  it("go over an enlarged picture whole when it is small enough, in tiles when it is not", () => {
    const sharper = recipeById("klein.sharper")!;
    const slots = { unet: "k.safetensors", clip: "q.safetensors", vae: "v.safetensors" };
    const build = (width: number, height: number, over: Record<string, unknown> = {}) =>
      sharper.build(parseInput(sharper, { source: "p", upscaler: "u.pth", ...over }), dryContext({ slots, uploads: { source: "s.png" }, media: { source: { width, height } } }));
    const small = build(640, 960);
    expect(Object.values(small.graph).some((n) => n.class_type === "SamplerCustomAdvanced")).toBe(true);
    // a quarter of the steps: only the end of them is run
    expect(small.totalSteps).toBe(5);
    expect(small.loads).toContain("diffusion_models/k.safetensors");
    const large = build(1536, 2048);
    const classes = Object.values(large.graph).map((n) => n.class_type);
    expect(classes).toEqual(expect.arrayContaining(["SplitImageToTileList", "SamplerCustomAdvanced", "ImageMergeTileList"]));
    // each tile keeps its own piece as its reference
    const reference = Object.values(large.graph).find((n) => n.class_type === "ImageScaleToTotalPixels")!;
    expect(large.graph[(reference.inputs.image as [string, number])[0]]!.class_type).toBe("SplitImageToTileList");
    // asked whole: gone over whole, whatever its size (never skipped for it)
    const whole = build(1536, 2048, { tiles: "Whole picture" });
    expect(Object.values(whole.graph).some((n) => n.class_type === "SamplerCustomAdvanced")).toBe(true);
    expect(Object.values(whole.graph).some((n) => n.class_type === "SplitImageToTileList")).toBe(false);
    expect(whole.loads).toContain("diffusion_models/k.safetensors");
  });

  it("run the img2img pass with the form's Steps, whole or in tiles (review K-5)", () => {
    const sharper = recipeById("klein.sharper")!;
    const slots = { unet: "k.safetensors", clip: "q.safetensors", vae: "v.safetensors" };
    const scheduled = (width: number, steps: number) => {
      const b = sharper.build(parseInput(sharper, { source: "p", upscaler: "u.pth", steps }), dryContext({ slots, uploads: { source: "s.png" }, media: { source: { width, height: width } } }));
      return Object.values(b.graph).filter((n) => n.class_type === "Flux2Scheduler").map((n) => n.inputs.steps);
    };
    // a distilled Klein's 4, not the base model's 20
    expect(scheduled(640, 4)).toEqual([4]);
    expect(scheduled(2048, 4)).toEqual([4]);
    expect(scheduled(640, 20)).toEqual([20]);
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

describe("krea2: built the way ComfyUI's own templates build it", () => {
  const slots = { unet: "krea2_turbo.safetensors", clip: "qwen3vl_4b.safetensors", vae: "qwen_image_vae.safetensors", styleRef: "krea2_style_reference.safetensors" };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
    krea2Picture.build(parseInput(krea2Picture, { prompt: "A lighthouse.", ...over }), dryContext({ seed: 7, slots, uploads: { "references.0": "a.png", "references.1": "b.png" }, ...ctx }));
  const of = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("txt2img is Turbo's plain recipe: 8 steps at CFG 1, euler / simple, the negative side emptied, the model's own shift", () => {
    const b = build();
    expect(of(b, "KSampler")[0]!.inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, seed: 7 });
    expect(of(b, "CLIPLoader")[0]!.inputs).toMatchObject({ type: "krea2" });
    expect(of(b, "EmptyLatentImage")[0]!.inputs).toMatchObject({ width: 896, height: 1152 });
    expect(of(b, "ConditioningZeroOut")).toHaveLength(1);
    expect(of(b, "ModelSamplingAuraFlow")).toHaveLength(0);
    expect(of(b, "ModelSamplingFlux")).toHaveLength(0);
    expect(b.totalSteps).toBe(8);
    expect(b.loads).toEqual(["diffusion_models/krea2_turbo.safetensors", "text_encoders/qwen3vl_4b.safetensors", "vae/qwen_image_vae.safetensors"]);
  });

  it("a fine-tune is picked under Model, with the shift, steps and CFG it asks for; a negative prompt is read once it is written", () => {
    const b = build({ model: "Krea2\someone_v1.safetensors", shift: 4, steps: 25, cfg: 3, negative: "blurry" });
    expect(of(b, "UNETLoader")[0]!.inputs.unet_name).toBe("Krea2\someone_v1.safetensors");
    expect(of(b, "ModelSamplingAuraFlow")[0]!.inputs).toMatchObject({ shift: 4 });
    expect(of(b, "KSampler")[0]!.inputs).toMatchObject({ steps: 25, cfg: 3 });
    expect(of(b, "ConditioningZeroOut")).toHaveLength(0);
    expect(of(b, "CLIPTextEncode").map((n) => n.inputs.text)).toEqual(["A lighthouse.", "blurry"]);
  });

  it("hires fix upscales with a model to the size asked for, whatever the model's own factor, then goes over it", () => {
    const b = build({ hires: true, hiresUpscaler: "4x.pth", hiresScale: 1.25, size: { width: 1152, height: 1536 } });
    expect(of(b, "ImageScale")[0]!.inputs).toMatchObject({ width: 1440, height: 1920, upscale_method: "lanczos" });
    const passes = of(b, "KSampler").map((n) => [n.inputs.steps, n.inputs.denoise]);
    expect(passes).toEqual([[8, 1], [4, 0.35]]);
    // the second pass keeps the model's own shift: Krea's is one constant at every size
    expect(of(b, "ModelSamplingFlux")).toHaveLength(0);
    expect(b.totalSteps).toBe(12);
    expect(b.loads).toContain("upscale_models/4x.pth");
  });

  it("style reference images are read next to the prompt, with the style-reference LoRA on the model", () => {
    const b = build({ references: [{ asset: "a", role: "style" }, { asset: "b", role: "style" }] });
    expect(Object.keys(of(b, "TextEncodeQwenImageEditPlus")[0]!.inputs).sort()).toEqual(["clip", "image1", "image2", "prompt", "vae"]);
    expect(of(b, "FluxKontextMultiReferenceLatentMethod")[0]!.inputs.reference_latents_method).toBe("index_timestep_zero");
    expect(of(b, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["krea2_style_reference.safetensors", 1]]);
    expect(of(b, "ModelSamplingFlux")[0]!.inputs).toMatchObject({ width: 896, height: 1152 });
    expect(b.loads).toContain("loras/krea2_style_reference.safetensors");
    // without the LoRA it is said in words, with where it goes
    const { styleRef: _none, ...without } = slots;
    expect(() => build({ references: [{ asset: "a", role: "style" }] }, { slots: without })).toThrow(/krea2_style_reference/);
    // it takes pictures of a style, not of a person
    expect(() => parseInput(krea2Picture, { prompt: "a", references: [{ asset: "a", role: "person" }] })).toThrow();
  });

  it("img2img and inpaint work at sizes the model draws well, both edges multiples of 16", () => {
    const redraw = recipeById("krea2.redraw")!;
    const r = redraw.build(parseInput(redraw, { source: "p", prompt: "a", strength: 0.4 }), dryContext({ seed: 1, slots, uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } } }));
    const scale = Object.values(r.graph).find((n) => n.class_type === "ImageScale")!.inputs as { width: number; height: number };
    expect([scale.width % 16, scale.height % 16]).toEqual([0, 0]);
    expect(scale.width * scale.height).toBeLessThan(1.7 * 1024 * 1024);
    expect(Object.values(r.graph).find((n) => n.class_type === "KSampler")!.inputs).toMatchObject({ denoise: 0.4, steps: 8 });
    const paint = recipeById("krea2.paint-over")!;
    const p = paint.build(parseInput(paint, { source: "p", mask: "m", prompt: "a" }), dryContext({ seed: 1, slots, uploads: { source: "s.png", mask: "m.png" }, media: { source: { width: 1536, height: 2048 }, mask: { width: 1536, height: 2048, box: { x: 300, y: 500, width: 400, height: 300 } } } }));
    expect(Object.values(p.graph).filter((n) => n.class_type === "SetLatentNoiseMask")).toHaveLength(1);
    expect(Object.values(p.graph).find((n) => n.class_type === "ImageCompositeMasked")!.inputs).toMatchObject({ x: 300, y: 500 });
  });
});

describe("wan.video", () => {
  const slots = { i2vHigh: "i2v_high.safetensors", i2vLow: "i2v_low.safetensors", clip: "umt5.safetensors", vae: "wan_vae.safetensors" };
  const turbo = { ...slots, i2vTurboHigh: "th.safetensors", i2vTurboLow: "tl.safetensors" };
  const words = { ...turbo, t2vHigh: "t2v_high.safetensors", t2vLow: "t2v_low.safetensors", t2vTurboHigh: "wh.safetensors", t2vTurboLow: "wl.safetensors" };
  const picture = { width: 832, height: 1216 };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) => {
    const input = parseInput(wanVideo, { prompt: "She waves.", start: "p", ...over });
    return wanVideo.build(input, dryContext({ seed: 7, slots: turbo, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture }, ...ctx }));
  };
  const all = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const passes = (b: ReturnType<typeof build>) => all(b, "KSamplerAdvanced").map((n) => n.inputs);

  it("counts frames on the model's grid and keeps canvases within what it takes", () => {
    expect([1, 3, 5, 5.2, 10].map(wanFrames)).toEqual([17, 49, 81, 85, 161]);
    for (const n of [1.5, 4, 7.5].map(wanFrames)) expect(n % 4).toBe(1);
    expect(wanCanvas(480, 832, 480)).toEqual({ width: 480, height: 832 });
    expect(wanCanvas(832, 1216, 480)).toEqual({ width: 480, height: 704 });
    const big = wanCanvas(1000, 1000, 2000);
    expect(big.width * big.height).toBeLessThanOrEqual(1280 * 720);
    expect(big.width % 16).toBe(0);
  });

  it("makes the clip in two passes over one schedule: the high-noise model, then the low-noise one", () => {
    const b = build({ fast: false, steps: 20, split: 0.5, cfg: 3.5 });
    const [first, second] = passes(b);
    expect(first).toMatchObject({ add_noise: "enable", noise_seed: 7, steps: 20, cfg: 3.5, start_at_step: 0, end_at_step: 10, return_with_leftover_noise: "enable" });
    expect(second).toMatchObject({ add_noise: "disable", steps: 20, cfg: 3.5, start_at_step: 10, return_with_leftover_noise: "disable" });
    // each pass has its own model, shifted the same way
    expect(all(b, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual(["i2v_high.safetensors", "i2v_low.safetensors"]);
    expect(all(b, "ModelSamplingSD3").map((n) => n.inputs.shift)).toEqual([8, 8]);
    expect(all(build({ fast: false, shift: 6 }), "ModelSamplingSD3").map((n) => n.inputs.shift)).toEqual([6, 6]);
    expect(b.passes!.map((p) => p.steps)).toEqual([10, 10]);
    expect(build({ fast: false, steps: 30, split: 0.4 }).passes!.map((p) => p.steps)).toEqual([12, 18]);
  });

  it("runs Turbo with the two lightx2v LoRAs, with none on a model made for it, and at full steps without their files", () => {
    // plain Turbo (Hybrid, on by default, adds a motion step: tested on its own)
    const fast = build({ fast: true, turboHybrid: false });
    expect(passes(fast)[0]).toMatchObject({ steps: 4, cfg: 1, end_at_step: 2 });
    expect(all(fast, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["th.safetensors", 1], ["tl.safetensors", 1]]);
    // the shift the LoRAs are made for; the high-noise LoRA eased when asked
    expect(all(fast, "ModelSamplingSD3").map((n) => n.inputs.shift)).toEqual([5, 5]);
    expect(all(build({ fast: true, turboStrength: 0.7 }), "LoraLoaderModelOnly").map((n) => n.inputs.strength_model)).toEqual([0.7, 1]);
    // a fine-tune named for it, or said to be one
    const named = build({ fast: true, model: "High\\SomeoneWAN22_lightningHigh.safetensors", modelLow: "Low\\SomeoneWAN22_lightningLow.safetensors" });
    expect(all(named, "LoraLoaderModelOnly")).toEqual([]);
    expect(passes(named)[0]).toMatchObject({ steps: 4, cfg: 1 });
    const said = build({ fast: true, model: "mine_high.safetensors", modelLow: "mine_low.safetensors", turboIn: "Yes", turboSteps: 6 });
    expect(all(said, "LoraLoaderModelOnly")).toEqual([]);
    // DaSiWa's name is not a mark: his TrueVision line is made for the full steps and takes the LoRAs, his Lightspeed line is distilled
    const trueVision = build({ fast: true, model: "High\\DasiwaWAN22I2V14BTruevision_snatchkissHighV11.safetensors", modelLow: "Low\\DasiwaWAN22I2V14BTruevision_snatchkissLowV11.safetensors" });
    expect(all(trueVision, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["th.safetensors", "tl.safetensors"]);
    const lightspeed = build({ fast: true, model: "High\\DasiwaWAN22I2V14BLightspeed_snatchkissHighV11.safetensors", modelLow: "Low\\DasiwaWAN22I2V14BLightspeed_snatchkissLowV11.safetensors" });
    expect(all(lightspeed, "LoraLoaderModelOnly")).toEqual([]);
    expect(passes(said)[0]).toMatchObject({ steps: 6, end_at_step: 3 });
    // no turbo files and a model that is not distilled: the full steps, and the CFG of the form
    const none = build({ fast: true }, { slots });
    expect(all(none, "LoraLoaderModelOnly")).toEqual([]);
    expect(passes(none)[0]).toMatchObject({ steps: 20, cfg: 3.5 });
  });

  it("opens on a picture, ends on one, or is made from words alone with the words-to-video models", () => {
    const opens = build({});
    expect(all(opens, "WanImageToVideo")[0]!.inputs).toMatchObject({ width: 480, height: 704, length: 81 });
    expect(all(opens, "WanImageToVideo")[0]!.inputs.end_image).toBeUndefined();
    const both = build({ end: "q" });
    expect(Object.keys(all(both, "WanFirstLastFrameToVideo")[0]!.inputs)).toEqual(expect.arrayContaining(["start_image", "end_image"]));
    const fromWords = build({ start: undefined, seconds: 3, shape: { width: 832, height: 480 }, fast: true }, { slots: words });
    expect(all(fromWords, "EmptyHunyuanLatentVideo")[0]!.inputs).toMatchObject({ width: 832, height: 480, length: 49 });
    expect(all(fromWords, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual(["t2v_high.safetensors", "t2v_low.safetensors"]);
    expect(all(fromWords, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["wh.safetensors", "wl.safetensors"]);
    // without those models, it says what to do
    expect(() => build({ start: undefined })).toThrow(/words-to-video \(T2V\) models.*Or give it a start image/);
  });

  it("puts each LoRA on the model it is for, and takes a timeline's frame", () => {
    const b = build({ fast: false, loras: [{ file: "a_high.safetensors", weight: 0.8 }], lorasLow: [{ file: "a_low.safetensors", weight: 0.7 }, { file: "off.safetensors", weight: 0 }] }, { canvas: { width: 1024, height: 576 } });
    const loras = Object.entries(b.graph).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
    expect(loras.map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["a_high.safetensors", 0.8], ["a_low.safetensors", 0.7]]);
    const source = (lora: (typeof loras)[number]) => b.graph[(lora[1].inputs.model as [string, number])[0]]!.inputs.unet_name;
    expect(loras.map(source)).toEqual(["i2v_high.safetensors", "i2v_low.safetensors"]);
    expect(all(b, "WanImageToVideo")[0]!.inputs).toMatchObject({ width: 1024, height: 576 });
    expect(b.loads).toEqual(expect.arrayContaining(["loras/a_high.safetensors", "loras/a_low.safetensors"]));
    expect(b.loads).not.toContain("loras/off.safetensors");
    // 16 pictures a second, 32 when smoothed
    expect(all(b, "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(16);
    expect(all(build({}, { slots: { ...turbo, rife: "r.pth" } }), "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(32);
  });

  it("runs Hybrid turbo as a 3-sampler split: two full steps without the turbo LoRA in front of Turbo's four", () => {
    const [lead, high, low] = passes(build({ fast: true }));
    expect(lead).toMatchObject({ steps: 6, cfg: 3.5, start_at_step: 0, end_at_step: 2, add_noise: "enable" });
    expect(high).toMatchObject({ steps: 6, cfg: 1, start_at_step: 2, end_at_step: 3, add_noise: "disable" });
    expect(low).toMatchObject({ steps: 6, cfg: 1, start_at_step: 3, end_at_step: 10000 });
    expect(build({ fast: true }).passes!.map((p) => p.steps)).toEqual([2, 1, 3]);
    // the high-noise model with its LoRA keeps a step, however few Turbo's are
    const [, short] = passes(build({ fast: true, turboSteps: 2 }));
    expect(short).toMatchObject({ steps: 4, start_at_step: 2, end_at_step: 3 });
  });

  describe("carrying on from the clip before", () => {
    const svi = { ...turbo, sviHigh: "svi_high.safetensors", sviLow: "svi_low.safetensors" };
    const carry = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) =>
      build({ start: undefined, previous: { asset: "v0", at: 5000 }, ...over }, { slots: svi, uploads: { previous: "prev.mp4", end: "b.png" }, media: { previous: { width: 480, height: 832, frames: 9, fps: 16 }, end: picture }, ...ctx });
    const ref = (b: ReturnType<typeof build>, r: unknown) => b.graph[(r as [string, number])[0]]!;

    it("goes through SVI 2.0 Pro: the clip before's last frame the anchor, its last latent frame the motion", () => {
      const b = carry({ fast: true });
      const node = all(b, "WanImageToVideoSVIPro")[0]!.inputs;
      // 5 s: the 2 frames dropped, the 4 frames of the head, and its own 79
      expect(node).toMatchObject({ length: 85, motion_latent_count: 1 });
      const anchor = ref(b, ref(b, node.anchor_samples).inputs.pixels);
      expect(anchor).toMatchObject({ class_type: "ImageFromBatch", inputs: { batch_index: -1, length: 1 } });
      expect(ref(b, ref(b, node.prev_samples).inputs.pixels)).toMatchObject({ class_type: "ImageScale", inputs: { width: 480, height: 832, crop: "center" } });
      expect(all(b, "WanImageToVideo")).toEqual([]);
      // its LoRAs on both models, under the turbo ones
      expect(all(b, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["svi_high.safetensors", "th.safetensors", "svi_low.safetensors", "tl.safetensors"]);
      expect(b.loads).toEqual(expect.arrayContaining(["loras/svi_high.safetensors", "loras/svi_low.safetensors"]));
      // and on the 3-sampler split's model without the turbo LoRA
      const lead = passes(b)[0]!;
      const leadLoras: string[] = [];
      for (let m = ref(b, lead.model); m; m = m.inputs.model ? ref(b, m.inputs.model) : undefined!) if (m.class_type === "LoraLoaderModelOnly") leadLoras.push(String(m.inputs.lora_name));
      expect(leadLoras).toEqual(["svi_high.safetensors"]);
    });

    it("drops the anchor and the frame after it, keeps the head hidden for a moving fade, and matches its colours to the clip before's last frame", () => {
      const b = carry({ smooth: false });
      // the decoded frames from the third on: with the anchor alone dropped, the head was one frame early (measured, card #82)
      const kept = all(b, "ImageFromBatch").filter((n) => ref(b, n.inputs.image).class_type === "VAEDecode");
      expect(kept.map((n) => n.inputs)).toEqual([expect.objectContaining({ batch_index: 2, length: 4096 })]);
      const match = all(b, "ColorTransfer")[0]!.inputs;
      expect(match).toMatchObject({ source_stats: "target_frame", "source_stats.target_index": 3, strength: 1 });
      expect(ref(b, match.image_ref).inputs).toMatchObject({ batch_index: -1, length: 1 });
      // 4 frames at 16 a second; with RIFE, from the frame it makes between the head's last and the clip's first
      expect(b.overlap).toEqual({ headMs: 250, tailMs: 0, moving: true });
      expect(joinKindOf(b.overlap)).toBe("window");
      expect(carry({}, { slots: { ...svi, rife: "r.pth" } }).overlap!.headMs).toBe(219);
      expect(b.frames).toBe(85);
      // its own First frame's colour match is not made: it does not open on it
      expect(all(carry({ start: "p", colourMatch: true }, { slots: svi, uploads: { previous: "prev.mp4", start: "a.png" } }), "LoadImage")).toEqual([]);
    });

    it("opens on the clip before's last frame, still, without SVI's LoRAs or node, or with a Last frame, and says so", () => {
      const without = carry({}, { slots: turbo });
      expect(all(without, "WanImageToVideoSVIPro")).toEqual([]);
      const opening = all(without, "WanImageToVideo")[0]!.inputs;
      expect(opening.length).toBe(81);
      expect(ref(without, opening.start_image)).toMatchObject({ class_type: "ImageFromBatch", inputs: { batch_index: -1 } });
      expect(without.overlap).toEqual({ headMs: 0, tailMs: 0, still: true });
      expect(joinKindOf(without.overlap)).toBe("still");
      expect(without.warnings!.join(" ")).toMatch(/A cut.*SVI 2\.0 Pro's two LoRAs/);
      const noNode = carry({}, { has: (n: string) => n !== "WanImageToVideoSVIPro" });
      expect(noNode.warnings!.join(" ")).toMatch(/no WanImageToVideoSVIPro node/);
      expect(joinKindOf(noNode.overlap)).toBe("still");
      // a Last frame: SVI takes none, the clip goes from the clip before's last frame to it, a plain cut
      const ends = carry({ end: "q" });
      expect(Object.keys(all(ends, "WanFirstLastFrameToVideo")[0]!.inputs)).toEqual(expect.arrayContaining(["start_image", "end_image"]));
      expect(ends.overlap).toBeUndefined();
      expect(ends.warnings!.join(" ")).toMatch(/takes no last frame/);
    });

    it("asks for SVI's LoRAs where it carries on, never with a Last frame, and its models are picture-to-video ones", () => {
      const needs = (over: Record<string, unknown>) => wanVideo.needsWith!(parseInput(wanVideo, { prompt: "a", ...over }), turbo);
      expect(needs({ previous: { asset: "v0" }, fast: false, smooth: false })).toEqual(["sviHigh", "sviLow"]);
      expect(needs({ previous: { asset: "v0" }, end: "q", fast: false, smooth: false })).toEqual([]);
      expect(needs({ start: "p", fast: false, smooth: false })).toEqual([]);
      // no start picture, yet not from words: the i2v models
      expect(all(carry(), "UNETLoader").map((n) => n.inputs.unet_name)).toEqual(["i2v_high.safetensors", "i2v_low.safetensors"]);
      expect(wanVideo.traits!.continues).toBe("clip");
    });
  });

  describe("under a recording it plays over (card #82)", () => {
    const rec = { recording: { width: 0, height: 0, seconds: 5.9, after: 4 } };
    const ref = (b: ReturnType<typeof build>, r: unknown) => b.graph[(r as [string, number])[0]]!;

    it("lasts as long as its part, at 16 a second whatever its Frame rate, and its files carry the part", () => {
      const b = build({ recording: "a1", recordingSeconds: 5.9, fps: 24, smooth: false }, { uploads: { start: "a.png", recording: "rec.wav" }, media: { start: picture, ...rec } });
      // 5.9 s and the quarter second after the words: 98 frames, 101 on the grid
      expect(all(b, "WanImageToVideo")[0]!.inputs.length).toBe(101);
      const save = all(b, "VHS_VideoCombine")[0]!.inputs;
      expect(save.frame_rate).toBe(16);
      const part = ref(b, save.audio);
      expect(part).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0, duration: 101 / 16 } });
      expect(ref(b, part.inputs.audio)).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "rec.wav" } });
      expect(all(b, "AudioConcat")).toEqual([]);
      // its form is the recording's internal one: never drawn, the same ids as H3's
      expect(wanVideo.inputs.filter((i) => i.id.startsWith("recording")).every((i) => i.internal)).toBe(true);
    });

    it("carrying on through SVI, sounds of silence under its head, then the part", () => {
      const b = build(
        { start: undefined, previous: { asset: "v0" }, recording: "a1", recordingSeconds: 5.9, smooth: false },
        { slots: { ...turbo, sviHigh: "h.safetensors", sviLow: "l.safetensors" }, uploads: { previous: "prev.mp4", recording: "rec.wav" }, media: { previous: { width: 480, height: 832, frames: 9, fps: 16 }, ...rec } },
      );
      const joined = ref(b, all(b, "VHS_VideoCombine")[0]!.inputs.audio);
      expect(joined.class_type).toBe("AudioConcat");
      const head = ref(b, joined.inputs.audio1);
      expect(head.inputs).toMatchObject({ start_index: 0, duration: 4 / 16 });
      expect(ref(b, head.inputs.audio)).toMatchObject({ class_type: "AudioAdjustVolume", inputs: { volume: -100 } });
      // the file's frames: the head and its own 99 (101 on the grid, less the 2 frames dropped); the part after the head
      expect(ref(b, joined.inputs.audio2).inputs.duration).toBe(99 / 16);
    });
  });
});

describe("ltx.video", () => {
  const one = { checkpoint: "ltx-2.3-22b-distilled.safetensors", clip: "gemma.safetensors" };
  const parts = { unet: "SomeoneLTX23.safetensors", videoVae: "video_vae.safetensors", audioVae: "audio_vae.safetensors", projection: "projection.safetensors", clip: "gemma.safetensors" };
  const extras = { upscaler: "up.safetensors", turbo: "distilled_lora.safetensors" };
  const picture = { width: 1216, height: 832 };
  const build = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}) => {
    const input = parseInput(ltxVideo, { prompt: "She waves.", ...over });
    return ltxVideo.build(input, dryContext({ seed: 7, slots: { ...one, ...extras }, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture }, ...ctx }));
  };
  const all = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);

  it("counts frames on the model's grid and keeps both edges on multiples of 64", () => {
    expect([1, 5, 5.2, 10].map(ltxFrames)).toEqual([25, 129, 129, 249]);
    for (const n of [2, 3.5, 7].map(ltxFrames)) expect(n % 8).toBe(1);
    expect(ltxCanvas(1280, 704, 704)).toEqual({ width: 1280, height: 704 });
    const c = ltxCanvas(1216, 832, 704);
    expect([c.width % 64, c.height % 64]).toEqual([0, 0]);
  });

  it("loads the model from one checkpoint, or from its parts when a diffusion model is there", () => {
    const whole = build({});
    expect(all(whole, "CheckpointLoaderSimple")[0]!.inputs.ckpt_name).toBe("ltx-2.3-22b-distilled.safetensors");
    expect(all(whole, "LTXAVTextEncoderLoader")[0]!.inputs).toMatchObject({ text_encoder: "gemma.safetensors", ckpt_name: "ltx-2.3-22b-distilled.safetensors" });
    expect(all(whole, "LTXVAudioVAELoader")).toHaveLength(1);
    expect(all(whole, "UNETLoader")).toEqual([]);

    const split = build({}, { slots: { ...parts, ...extras } });
    expect(all(split, "UNETLoader")[0]!.inputs.unet_name).toBe("SomeoneLTX23.safetensors");
    expect(all(split, "DualCLIPLoader")[0]!.inputs).toMatchObject({ clip_name1: "gemma.safetensors", clip_name2: "projection.safetensors", type: "ltxv" });
    expect(all(split, "VAELoader").map((n) => n.inputs.vae_name)).toEqual(["video_vae.safetensors", "audio_vae.safetensors"]);
    expect(all(split, "CheckpointLoaderSimple")).toEqual([]);
    // a diffusion model without its other parts says what is missing
    expect(() => build({}, { slots: { unet: "x.safetensors", clip: "gemma.safetensors" } })).toThrow(/video VAE and the audio VAE/);
    expect(() => build({}, { slots: { clip: "gemma.safetensors" } })).toThrow(/LTX 2.3 was not found/);
  });

  it("puts the distilled LoRA on a model that is not distilled, and on no other", () => {
    const lorasOf = (b: ReturnType<typeof build>) => all(b, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model]);
    expect(lorasOf(build({}))).toEqual([]); // "distilled" is in its name
    expect(lorasOf(build({}, { slots: { ...parts, ...extras } }))).toEqual([["distilled_lora.safetensors", 0.5]]);
    expect(lorasOf(build({ turboIn: "Yes" }, { slots: { ...parts, ...extras } }))).toEqual([]);
    expect(lorasOf(build({ turboIn: "No" }))).toEqual([["distilled_lora.safetensors", 0.5]]);
    // not distilled and no LoRA file: it is run as it is
    expect(lorasOf(build({}, { slots: parts }))).toEqual([]);
    // DaSiWa's lines by name: DragonLeap and SolsticeCoin are distilled, GoldenLace is not
    expect(lorasOf(build({}, { slots: { ...parts, ...extras, unet: "DasiwaLTX23_dragonleapV4.safetensors" } }))).toEqual([]);
    expect(lorasOf(build({}, { slots: { ...parts, ...extras, unet: "DasiwaLTX23_solsticecoinV2.safetensors" } }))).toEqual([]);
    expect(lorasOf(build({}, { slots: { ...parts, ...extras, unet: "DasiwaLTX23_goldenlaceV3.safetensors" } }))).toEqual([["distilled_lora.safetensors", 0.5]]);
  });

  it("makes the clip in two passes: half the size, enlarged, then refined, keeping the sound of the first", () => {
    const b = build({ start: "p" });
    expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs).toMatchObject({ width: 512, height: 352, length: 129 });
    expect(all(b, "LTXVLatentUpsampler")).toHaveLength(1);
    expect(all(b, "ManualSigmas").map((n) => n.inputs.sigmas)).toEqual([LTX_SIGMAS, "0.85, 0.725, 0.4219, 0.0"]);
    // the same numbers as LTX's own refining schedule, to the digit
    expect(String(all(b, "ManualSigmas")[1]!.inputs.sigmas).split(",").map(Number)).toEqual(LTX_REFINE_SIGMAS.split(",").map(Number));
    expect(b.passes!.map((p) => p.steps)).toEqual([8, 3]);
    expect(b.totalSteps).toBe(11);
    // the opening picture goes in at both sizes: loosely first, then as the first frame itself
    expect(all(b, "LTXVImgToVideoInplace").map((n) => n.inputs.strength)).toEqual([0.7, 1]);
    expect(all(b, "ImageScale").map((n) => [n.inputs.width, n.inputs.height])).toEqual([[512, 352], [1024, 704]]);
    expect(all(b, "LTXVEmptyLatentAudio")[0]!.inputs).toMatchObject({ frames_number: 129, frame_rate: 25 });
    expect(all(b, "VHS_VideoCombine")[0]!.inputs.audio).toBeDefined();
  });

  it("carries on from the clip before: its last frames guide frame 0 in both passes, hidden as the overlap, the first picture set aside", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true };
    const b = build({ start: "p", previous: { asset: "c" }, seconds: 5 }, { uploads: { start: "p.png", previous: "c.mp4" }, media: { start: { width: 832, height: 1216 }, previous: prev } });
    // the clip before's frames, scaled to each pass's size, as a guide at frame 0 held exactly; no first-frame picture in the latent
    expect(all(b, "LTXVImgToVideoInplace")).toEqual([]);
    expect(all(b, "LoadImage")).toEqual([]);
    expect(all(b, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[0, 1], [0, 1]]);
    expect(all(b, "ImageScale").map((n) => [n.inputs.width, n.inputs.height])).toEqual([[352, 640], [704, 1280]]);
    expect(all(b, "LTXVCropGuides")).toHaveLength(2);
    // 5 s of its own after the second it shares: 150 frames on the grid, the overlap said for the timeline (a join on pixels)
    expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs.length).toBe(ltxFrames(6));
    expect(b.frames).toBe(ltxFrames(6));
    expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, sound: true });
    // the keyframe's moment is counted after the shared frames
    const mid = build({ previous: { asset: "c" }, mid: "m", midAt: 2 }, { uploads: { previous: "c.mp4", mid: "m.png" }, media: { previous: prev, mid: { width: 832, height: 1216 } } });
    expect(all(mid, "LTXVAddGuide").map((n) => n.inputs.frame_idx)).toEqual([0, 25 + 48, 0, 25 + 48]);
    // fewer frames than the join takes are refused with the counts it takes
    expect(() => build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4" }, media: { previous: { ...prev, frames: 17 } } })).toThrow(/25 or 9/);
  });

  it("carries the clip before's sound on: encoded under its frames at the head and pinned there in every pass", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true };
    const b = build({ previous: { asset: "c" }, seconds: 5 }, { uploads: { previous: "c.mp4" }, media: { previous: prev } });
    const [video] = all(b, "GetVideoComponents");
    const id = Object.entries(b.graph).find(([, n]) => n === video)![0];
    // the sound of the frames handed over, encoded with the model's audio VAE
    // (2.3's: through Room Tone, which fills its stretches of exact silence first)
    const encoded = all(b, "LTXVAudioVAEEncode")[0]!.inputs.audio as [string, number];
    expect(b.graph[encoded[0]]).toMatchObject({ class_type: "AfflatusRoomTone", inputs: { audio: [id, 1], level_db: -50 } });
    // laid into the clip's silence (its length stays the silence's), the head's frames less one pinned
    const silence = Object.entries(b.graph).find(([, n]) => n.class_type === "LTXVEmptyLatentAudio")![0];
    expect(all(b, "LatentCompositeMasked")[0]!.inputs).toMatchObject({ destination: [silence, 0], x: 0, y: 0 });
    expect(all(b, "SolidMask").map((n) => [n.inputs.value, n.inputs.height])).toEqual([[1, ltxFrames(6)], [0, 24]]);
    expect(all(b, "MaskComposite")[0]!.inputs.operation).toBe("multiply");
    // the first pass starts from it, the refining pass gets the pin back on the first pass's sound
    const pins = Object.entries(b.graph).filter(([, n]) => n.class_type === "SetLatentNoiseMask").map(([k]) => k);
    expect(pins).toHaveLength(2);
    // (the passes' latents: the last one is the clip's own, kept beside it)
    expect(all(b, "LTXVConcatAVLatent").slice(0, 2).map((n) => (n.inputs.audio_latent as [string, number])[0])).toEqual(pins);
    // the interpolation's settling pass too
    const doubled = build({ previous: { asset: "c" }, smooth: true, smoothWith: "LTX temporal (latent)" }, { slots: { ...one, ...extras, temporal: "t.safetensors" }, uploads: { previous: "c.mp4" }, media: { previous: prev } });
    expect(all(doubled, "SetLatentNoiseMask")).toHaveLength(3);
    // a clip before without sound, or a ComfyUI without the nodes: the head's sound is made, as before, and the take says so
    const silent = build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4" }, media: { previous: { ...prev, hasSound: false } } });
    expect(all(silent, "LTXVAudioVAEEncode")).toEqual([]);
    expect(silent.overlap).toEqual({ headMs: 1000, tailMs: 0 });
    const old = build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4" }, media: { previous: prev }, has: (n: string) => n !== "LatentCompositeMasked" });
    expect(all(old, "SetLatentNoiseMask")).toEqual([]);
    expect(old.overlap).toEqual({ headMs: 1000, tailMs: 0 });
    // nothing of it on a clip that starts on its own
    expect(all(build({}), "LTXVAudioVAEEncode")).toEqual([]);
  });

  it("lands on the clip after: its first frames guide the clip's last in both passes, hidden as the tail", () => {
    const after = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true };
    const b = build({ next: { asset: "n", at: 0 }, seconds: 5 }, { uploads: { next: "n.mp4" }, media: { next: after } });
    const frames = ltxFrames(6);
    expect(b.frames).toBe(frames);
    expect(all(b, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[frames - 25, 1], [frames - 25, 1]]);
    expect((frames - 25) % 8).toBe(0);
    // the frame is the clip after's
    expect(all(b, "ImageScale").map((n) => [n.inputs.width, n.inputs.height])).toEqual([[352, 640], [704, 1280]]);
    expect(b.overlap).toEqual({ headMs: 0, tailMs: 1000 });
    // between two clips: both guides, the clip that long again
    const prev = { ...after };
    const both = build({ previous: { asset: "c" }, next: { asset: "n", at: 0 }, seconds: 5 }, { uploads: { previous: "c.mp4", next: "n.mp4" }, media: { previous: prev, next: after } });
    expect(both.frames).toBe(ltxFrames(7));
    expect(all(both, "LTXVAddGuide").map((n) => n.inputs.frame_idx)).toEqual([0, ltxFrames(7) - 25, 0, ltxFrames(7) - 25]);
    expect(both.overlap).toEqual({ headMs: 1000, tailMs: 1000, sound: true });
    // a last picture of its own wins: the clip after is not landed on
    const pinned = build({ start: "p", end: "q", next: { asset: "n", at: 0 } }, { uploads: { start: "a.png", end: "b.png", next: "n.mp4" }, media: { start: picture, end: picture, next: after } });
    expect(all(pinned, "GetVideoComponents")).toEqual([]);
    expect(pinned.overlap).toBeUndefined();
    expect(ltxVideo.traits?.endAnchor).toBe(true);
  });

  it("keeps every clip's own latent beside it, at the model's rate, for the clips that carry on from it", () => {
    const b = build({ start: "p" });
    const [save] = Object.entries(b.graph).filter(([, n]) => n.class_type === "AfflatusSaveLTXLatent");
    expect(save![1].inputs).toMatchObject({ fps: 25, filename_prefix: "Afflatus/ltx" });
    expect(b.outputs).toContainEqual({ node: save![0], kind: "video", role: "latent" });
    // the latent sampled, not the one the temporal upscaler doubled
    const doubled = build({ start: "p", smooth: true, smoothWith: "LTX temporal (latent)" }, { slots: { ...one, ...extras, temporal: "t.safetensors" } });
    const concat = all(doubled, "AfflatusSaveLTXLatent")[0]!.inputs.samples as [string, number];
    const separated = Object.entries(doubled.graph).filter(([, n]) => n.class_type === "LTXVSeparateAVLatent").map(([k]) => k);
    expect((doubled.graph[concat[0]]!.inputs.audio_latent as [string, number])[0]).toBe(separated[1]);
    // without the node pack: nothing kept
    expect(all(build({}, { has: (n: string) => n !== "AfflatusSaveLTXLatent" }), "AfflatusSaveLTXLatent")).toEqual([]);
    expect(ltxVideo.traits).toMatchObject({ latentNodes: ["AfflatusLoadLTXLatent", "AfflatusLTXContinuation", "AfflatusLTXSeamLatent"], latentTrim: "AfflatusTrimLTXLatent" });
  });

  it("carries on in the clip before's own latent: its last tokens pinned at full size, its sound under them, the join decoded as one piece", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true, latentFrames: 97, latentCut: 97, latentSize: { width: 704, height: 1280 } };
    const b = build({ previous: { asset: "c" }, seconds: 5 }, { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: prev }, canvas: { width: 1024, height: 576 } });
    const id = (cls: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === cls).map(([k]) => k);
    const frames = ltxFrames(6);
    // made at the latent's own size, whatever the canvas
    expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs).toMatchObject({ width: 352, height: 640, length: frames });
    // the latent loaded, cut at its hand-over frame, its last 4 tokens (25 frames) and their sound taken
    expect(all(b, "AfflatusLoadLTXLatent")[0]!.inputs.latent).toBe("c.safetensors");
    expect(all(b, "AfflatusTrimLTXLatent")[0]!.inputs).toMatchObject({ samples: [id("AfflatusLoadLTXLatent")[0], 0], frames: 97 });
    const [cont] = id("AfflatusLTXContinuation");
    expect(b.graph[cont!]!.inputs).toMatchObject({ previous_av_latent: [id("AfflatusTrimLTXLatent")[0], 0], overlap_frames: 25 });
    // the first pass, at half the size, guided by the frames; the refining pass at full size by the tokens themselves
    expect(all(b, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[0, 1]]);
    expect(all(b, "LTXVAddLatentGuide")[0]!.inputs).toMatchObject({ guiding_latent: [cont, 0], latent_idx: 0, strength: 1 });
    // the sound: the continuation's, pinned again on the refining pass by its mask; nothing encoded from the frames
    expect(all(b, "LTXVAudioVAEEncode")).toEqual([]);
    expect(all(b, "LTXVConcatAVLatent")[0]!.inputs.audio_latent).toEqual([cont, 1]);
    expect(all(b, "SetLatentNoiseMask")[0]!.inputs.mask).toEqual([cont, 2]);
    // decoded after 4 tokens of the clip before besides the run-up, their 32 frames dropped
    expect(all(b, "AfflatusLTXSeamLatent")[0]!.inputs).toMatchObject({ overlap_frames: 25, context: 4 });
    expect(all(b, "ImageFromBatch")[0]!.inputs).toMatchObject({ batch_index: 32, length: frames });
    expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, latent: true, seam: true });
    // a short clip before: as much context as it has (97 frames are 13 tokens; 4 of a run-up of 25 leave 9)
    const short = build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: { ...prev, latentFrames: 33, latentCut: undefined } } });
    expect(all(short, "AfflatusTrimLTXLatent")).toEqual([]);
    expect(all(short, "AfflatusLTXSeamLatent")[0]!.inputs.context).toBe(1);
    expect(all(short, "ImageFromBatch")[0]!.inputs.batch_index).toBe(8);
  });

  it("carries on with the run-up asked (card #87): 9, 25 or 41 frames of the clip before, as H3's 5, 22 or 39", () => {
    const runUp = ltxVideo.inputs.find((i) => i.id === "context");
    expect(runUp).toMatchObject({ type: "choice", label: "Frames from the clip before", options: ["9", "25", "41"], default: "41", showWhen: "previous", advanced: true, section: "rare" });
    expect(ltxVideo.inputs.find((i) => i.id === "previous")).toMatchObject({ frames: [25, 9], framesFrom: "context" });
    // the same choice on every LTX form, in the same place: right after the clip it is about
    for (const r of [ltxVideo, ltxLipSync, ltx25LipSync]) expect(r.inputs.findIndex((i) => i.id === "context")).toBe(r.inputs.findIndex((i) => i.id === "previous") + 1);
    // the count the server cuts the clip before to: the one asked, else the form's default
    expect(joinFrames(ltxVideo, "previous", { context: "41" })).toBe(41);
    expect(joinFrames(ltxVideo, "previous", {})).toBe(41);
    // handed over with 41: 6 tokens pinned, the clip that much longer, the head that much longer hidden
    const prev = { width: 704, height: 1280, frames: 41, fps: 25, hasSound: true, latentFrames: 97, latentSize: { width: 704, height: 1280 } };
    const b = build({ previous: { asset: "c" }, seconds: 5, context: "41" }, { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: prev } });
    expect(all(b, "AfflatusLTXContinuation")[0]!.inputs.overlap_frames).toBe(41);
    expect(all(b, "AfflatusLTXSeamLatent")[0]!.inputs).toMatchObject({ overlap_frames: 41, context: 4 });
    expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs.length).toBe(ltxFrames(5 + 41 / 25));
    expect(b.overlap).toEqual({ headMs: 1640, tailMs: 0, latent: true, seam: true });
    // on frames: the 41 frames as the guide, the head's sound a frame short of them
    const frames = build({ previous: { asset: "c" }, context: "41" }, { uploads: { previous: "c.mp4" }, media: { previous: { ...prev, latentSize: undefined } } });
    expect(all(frames, "SolidMask").map((n) => n.inputs.height)).toContain(40);
    expect(frames.overlap).toEqual({ headMs: 1640, tailMs: 0, sound: true });
    // a clip after is landed on with 25 or 9 still: 41 is a run-up only
    expect(() => build({ next: { asset: "n", at: 0 } }, { uploads: { next: "n.mp4" }, media: { next: { ...prev, latentSize: undefined } } })).toThrow(/lands on 25 or 9 frames/);
  });

  it("carries on from the frames when the latent cannot be continued", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true, latentFrames: 121, latentSize: { width: 704, height: 1280 } };
    const up = { previous: "c.mp4", "previous.latent": "c.safetensors" };
    const onFrames = (b: ReturnType<typeof build>) => {
      expect(all(b, "AfflatusLoadLTXLatent")).toEqual([]);
      expect(all(b, "LTXVAddLatentGuide")).toEqual([]);
      expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, sound: true });
    };
    // no size said (a latent kept before 0.37.0 cannot be: they are H3's), no pack, no latent guide, a size the half pass cannot take
    onFrames(build({ previous: { asset: "c" } }, { uploads: up, media: { previous: { ...prev, latentSize: undefined } } }));
    onFrames(build({ previous: { asset: "c" } }, { uploads: up, media: { previous: prev }, has: (n: string) => n !== "AfflatusLTXSeamLatent" }));
    onFrames(build({ previous: { asset: "c" } }, { uploads: up, media: { previous: prev }, has: (n: string) => n !== "LTXVAddLatentGuide" }));
    onFrames(build({ previous: { asset: "c" } }, { uploads: up, media: { previous: { ...prev, latentSize: { width: 736, height: 1280 } } } }));
    // cut at a hand-over frame without the pack's trim
    onFrames(build({ previous: { asset: "c" } }, { uploads: up, media: { previous: { ...prev, latentCut: 97 } }, has: (n: string) => n !== "AfflatusTrimLTXLatent" }));
    // one pass takes a size on 32 pixels
    const one = build({ previous: { asset: "c" }, twoPass: false }, { uploads: up, media: { previous: { ...prev, latentSize: { width: 736, height: 1280 } } } });
    expect(all(one, "LTXVAddLatentGuide")).toHaveLength(1);
    expect(all(one, "LTXVAddGuide")).toEqual([]);
  });

  it("decodes a join carried on in the latent alone when the temporal upscaler doubles its frames", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true, latentFrames: 121, latentSize: { width: 704, height: 1280 } };
    const b = build({ previous: { asset: "c" }, smooth: true, smoothWith: "LTX temporal (latent)" }, { slots: { ...one, ...extras, temporal: "t.safetensors" }, uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: prev } });
    expect(all(b, "LTXVAddLatentGuide")).toHaveLength(1);
    expect(all(b, "AfflatusLTXSeamLatent")).toEqual([]);
    expect(all(b, "ImageFromBatch")).toEqual([]);
    expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, latent: true });
    // the pin put back on the settling pass too
    expect(all(b, "SetLatentNoiseMask")).toHaveLength(2);
  });

  it("carries a chain's colour match on, at the head's last frame, when the clip before's chain was matched", () => {
    const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true };
    const look = build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4", "previous.look": "look.png" }, media: { previous: prev }, has: (n: string) => n !== "AfflatusColorFollow" });
    expect(all(look, "ColorTransfer")[0]!.inputs).toMatchObject({ source_stats: "target_frame", "source_stats.target_index": 24, strength: 1 });
    expect(all(build({ previous: { asset: "c" } }, { uploads: { previous: "c.mp4" }, media: { previous: prev } }), "ColorTransfer")).toEqual([]);
    expect(ltxVideo.inputs.find((i) => i.id === "previous")).toMatchObject({ look: "matched" });
  });

  it("makes it in one pass at full size when it ends on a picture, when asked, or without the upscaler", () => {
    const ends = build({ start: "p", end: "q", endStrength: 0.9 });
    expect(all(ends, "LTXVLatentUpsampler")).toEqual([]);
    expect(all(ends, "EmptyLTXVLatentVideo")[0]!.inputs).toMatchObject({ width: 1024, height: 704 });
    expect(all(ends, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[0, 0.7], [-1, 0.9]]);
    expect(all(ends, "LTXVCropGuides")).toHaveLength(1);
    expect(ends.passes!.map((p) => p.steps)).toEqual([8]);
    expect(all(build({ twoPass: false }), "LTXVLatentUpsampler")).toEqual([]);
    expect(all(build({}, { slots: one }), "LTXVLatentUpsampler")).toEqual([]);
    // from words alone there is no guide to take out again
    expect(all(build({ twoPass: false }), "LTXVCropGuides")).toEqual([]);
  });

  it("takes a schedule by steps on LTX's own scheduler, in place of LTX's 8 sigmas", () => {
    const b = build({ schedule: "By steps", steps: 12, maxShift: 2.5, terminal: 0.05, cfg: 3 });
    expect(all(b, "LTXVScheduler")[0]!.inputs).toMatchObject({ steps: 12, max_shift: 2.5, base_shift: 0.95, stretch: true, terminal: 0.05 });
    expect(all(b, "LTXVScheduler")[0]!.inputs.latent).toBeDefined();
    expect(all(b, "BasicScheduler")).toEqual([]);
    expect(all(b, "CFGGuider").map((n) => n.inputs.cfg)).toEqual([3, 3]);
    expect(b.passes!.map((p) => p.steps)).toEqual([12, 3]);
    expect(all(build({ schedule: "By steps", stretch: false }), "LTXVScheduler")[0]!.inputs.stretch).toBe(false);
    // the dev model samples on its own schedule; the distilled LoRA refines only (with LTX's own 8 sigmas it is on the whole render)
    const sourceOf = (b: ReturnType<typeof build>, id: string): string => {
      const n = b.graph[id]!;
      return n.class_type === "ModelPreviewOverrideKJ" ? sourceOf(b, (n.inputs.model as [string, number])[0]) : n.class_type;
    };
    const dev = build({ schedule: "By steps" }, { slots: { ...parts, ...extras } });
    expect(all(dev, "CFGGuider").map((n) => sourceOf(dev, (n.inputs.model as [string, number])[0]))).toEqual(["UNETLoader", "LoraLoaderModelOnly"]);
    const own = build({}, { slots: { ...parts, ...extras } });
    expect(all(own, "CFGGuider").map((n) => sourceOf(own, (n.inputs.model as [string, number])[0]))).toEqual(["LoraLoaderModelOnly", "LoraLoaderModelOnly"]);
  });

  describe("a keyframe", () => {
    const mids = { uploads: { start: "a.png", end: "b.png", mid: "c.png" }, media: { start: picture, end: picture, mid: picture } };
    const from = (b: ReturnType<typeof build>, ref: unknown) => b.graph[(ref as [string, number])[0]]!;
    // the size a guide's picture is scaled to, through its LTXVPreprocess
    const sizeOf = (b: ReturnType<typeof build>, guide: { inputs: Record<string, unknown> }) => {
      const scaled = from(b, from(b, guide.inputs.image).inputs.image);
      return [scaled.inputs.width, scaled.inputs.height];
    };

    it("is a guide at its moment between the first and the last picture in one pass, taken out once with the others", () => {
      const b = build({ start: "p", mid: "m", end: "q" }, mids);
      expect(all(b, "LTXVLatentUpsampler")).toEqual([]);
      // 2.5 s at 25 frames a second, on the model's 8-frame steps (62.5 → 64); the last picture still at -1, which ComfyUI counts without the guide frames
      expect(all(b, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[0, 0.7], [64, 0.8], [-1, 0.7]]);
      expect(all(b, "LTXVCropGuides")).toHaveLength(1);
      expect(all(b, "LoadImage").map((n) => n.inputs.image)).toEqual(["a.png", "c.png", "b.png"]);
      // a keyframe alone is a guide too, and is taken out again
      const alone = build({ mid: "m", twoPass: false, midStrength: 0.6 }, mids);
      expect(all(alone, "LTXVAddGuide").map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[64, 0.6]]);
      expect(all(alone, "LTXVCropGuides")).toHaveLength(1);
    });

    it("guides both passes at their own size, and is taken out before the clip is enlarged and before it is decoded", () => {
      const b = build({ start: "p", mid: "m" }, mids);
      const guides = all(b, "LTXVAddGuide");
      expect(guides.map((n) => [n.inputs.frame_idx, n.inputs.strength])).toEqual([[64, 0.8], [64, 0.8]]);
      expect(guides.map((n) => sizeOf(b, n))).toEqual([[512, 352], [1024, 704]]);
      // the first frame is still put in place in the latent, not given as a guide
      expect(all(b, "LTXVImgToVideoInplace").map((n) => n.inputs.strength)).toEqual([0.7, 1]);
      const crops = all(b, "LTXVCropGuides");
      expect(crops).toHaveLength(2);
      // each crop takes out the guide its own pass was given, from what that pass sampled
      crops.forEach((crop, i) => {
        expect(from(b, crop.inputs.positive)).toBe(guides[i]);
        expect(from(b, crop.inputs.latent).class_type).toBe("LTXVSeparateAVLatent");
      });
      expect(from(b, all(b, "LTXVLatentUpsampler")[0]!.inputs.samples)).toBe(crops[0]);
      expect(from(b, all(b, "VAEDecodeTiled")[0]!.inputs.samples)).toBe(crops[1]);
      // the full-size guide goes on the enlarged clip with its first frame put back, from the prompt's own conditioning
      expect(from(b, guides[1]!.inputs.latent).class_type).toBe("LTXVImgToVideoInplace");
      expect(from(b, guides[1]!.inputs.positive).class_type).toBe("LTXVConditioning");
    });

    it("gives the temporal upscaler a clip without its guide frames", () => {
      const b = build({ start: "p", mid: "m", smooth: true }, { ...mids, slots: { ...one, ...extras, temporal: "temporal.safetensors" } });
      const upsamplers = all(b, "LTXVLatentUpsampler");
      expect(upsamplers).toHaveLength(2);
      expect(from(b, upsamplers[1]!.inputs.samples)).toBe(all(b, "LTXVCropGuides")[1]);
    });

    it("stays off the first and the last frame, however late it is asked for", () => {
      const at = (midAt: number, seconds = 5) => all(build({ mid: "m", midAt, seconds, twoPass: false }, mids), "LTXVAddGuide")[0]!.inputs.frame_idx;
      // a step of 8 off either end, on the 8-frame steps
      expect(at(19.5)).toBe(ltxFrames(5) - 9);
      expect(at(0.5)).toBe(16);
      expect(at(4, 2)).toBe(ltxFrames(2) - 9);
    });

    it("decides the shape when it is the only picture", () => {
      const tall = { width: 832, height: 1216 };
      const b = build({ mid: "m" }, { uploads: { mid: "c.png" }, media: { mid: tall } });
      const c = ltxCanvas(tall.width, tall.height, 704);
      expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs).toMatchObject({ width: c.width / 2, height: c.height / 2 });
      expect(ltxVideo.inputs.find((i) => i.id === "shape")).toMatchObject({ decidedBy: ["start", "end", "mid"] });
    });

    it("leaves a clip without one as it was", () => {
      for (const b of [build({ start: "p" }), build({ twoPass: false })]) {
        expect(all(b, "LTXVAddGuide")).toEqual([]);
        expect(all(b, "LTXVCropGuides")).toEqual([]);
      }
    });
  });
});

describe("LTX under a recording (card #2)", () => {
  const one = { checkpoint: "ltx-2.3-22b-distilled.safetensors", clip: "gemma.safetensors", upscaler: "up.safetensors" };
  const picture = { width: 1216, height: 832 };
  const rec = (seconds: number, more: Record<string, number> = {}) => ({ recording: { width: 0, height: 0, seconds, ...more } });
  const prev = { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true };
  type Built = ReturnType<typeof ltxLipSync.build>;
  const build = (recipe: typeof ltxLipSync, over: Record<string, unknown>, ctx: Parameters<typeof dryContext>[0] = {}) =>
    recipe.build(parseInput(recipe, { prompt: "A man at a café terrace.", recording: "a1", ...over }), dryContext({ seed: 7, slots: one, uploads: { start: "a.png", recording: "rec.wav", previous: "c.mp4" }, ...ctx }));
  const all = (b: Built, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const ref = (b: Built, r: unknown) => b.graph[(r as [string, number])[0]]!;
  const idOf = (b: Built, cls: string) => Object.entries(b.graph).find(([, n]) => n.class_type === cls)![0];
  const save = (b: Built) => all(b, "VHS_VideoCombine")[0]!.inputs;
  // the sound the model is pinned to, as it was before 2.3's Room Tone fills its silences (the take carries it so)
  const waveOf = (b: Built) => {
    const encoded = all(b, "LTXVAudioVAEEncode")[0]!.inputs.audio as [string, number];
    const node = b.graph[encoded[0]]!;
    return node.class_type === "AfflatusRoomTone" ? node.inputs.audio : encoded;
  };

  it("Lip sync: the recording drawn in its form, no Duration, its part's length on the model's grid", () => {
    expect(madeAroundRecording(ltxLipSync.inputs)).toBe(true);
    expect(ltxLipSync.inputs.find((i) => i.id === "seconds")).toBeUndefined();
    // 15 s at most, 377 frames at 25 a second; the pad after the words outlasts one step of the 8-frame grid
    expect(recordingSpecOf(ltxLipSync.inputs)!.window.fits).toMatchObject({ frames: 377, fps: 25, pad: 0.32, min: 1, grid: { step: 8, offset: 1 }, less: ["speechAt"] });
    expect(recordingSpecOf(ltx25LipSync.inputs)!.window.fits).toMatchObject({ frames: 361, fps: 24, pad: 0.34 });
    // Video with audio takes it as the recording's internal inputs, under the same ids: a recording it plays over
    expect(madeAroundRecording(ltxVideo.inputs)).toBe(false);
    expect(ltxVideo.inputs.filter((i) => i.id.startsWith("recording")).every((i) => i.internal)).toBe(true);
    expect(recordingSpecOf(ltxVideo.inputs)!.id).toBe(recordingSpecOf(ltxLipSync.inputs)!.id);
  });

  it("Lip sync: the part is the clip's sound from the first step, pinned in every pass, and the take's sound itself", () => {
    const b = build(ltxLipSync, { start: "p", recordingSeconds: 5.9 }, { media: { start: picture, ...rec(5.9) } });
    // 5.9 s and the pad: 156 frames, brought down to 153 on the grid
    expect(b.frames).toBe(153);
    expect(all(b, "EmptyLTXVLatentVideo")[0]!.inputs.length).toBe(153);
    const part = waveOf(b);
    expect(ref(b, part)).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0, duration: 153 / 25 } });
    expect(ref(b, ref(b, part).inputs.audio)).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "rec.wav" } });
    // laid into the silence, all of it pinned: a mask of 0 as tall as the clip's frames
    expect(all(b, "LatentCompositeMasked")[0]!.inputs).toMatchObject({ destination: [idOf(b, "LTXVEmptyLatentAudio"), 0], x: 0, y: 0 });
    expect(all(b, "SolidMask").map((n) => [n.inputs.value, n.inputs.height])).toEqual([[0, 153]]);
    const pins = Object.entries(b.graph).filter(([, n]) => n.class_type === "SetLatentNoiseMask").map(([k]) => k);
    const sampled = all(b, "SamplerCustomAdvanced").map((n) => ref(b, n.inputs.latent_image).inputs.audio_latent as [string, number]);
    expect(sampled.map(([id]) => id)).toEqual(pins);
    expect(pins).toHaveLength(2);
    // nothing decoded: the take's sound is the part it was made to
    expect(all(b, "LTXVAudioVAEDecode")).toEqual([]);
    expect(save(b).audio).toEqual(part);
    // the scene, then that the person speaks
    expect(String(all(b, "CLIPTextEncode")[0]!.inputs.text)).toBe("A man at a café terrace. The person speaks throughout, the lips moving with every word.");
    expect(b.overlap).toBeUndefined();
  });

  it("Lip sync carrying on, the words a moment in: the clip before's sound under the head, silence, then the part, all pinned", () => {
    const b = build(ltxLipSync, { previous: { asset: "c" }, recordingSeconds: 4.2, speechAt: 0.5 }, { media: { previous: prev, ...rec(4.2) } });
    // 13 frames before the words, 4.2 s, the pad, and the 25 frames of the head: 151, brought down to 145
    expect(b.frames).toBe(145);
    const wave = ref(b, waveOf(b));
    expect(wave.class_type).toBe("AudioConcat");
    const ahead = ref(b, wave.inputs.audio1);
    expect(ahead.inputs).toMatchObject({ start_index: 0, duration: 38 / 25 });
    const [heard, quiet] = [ref(b, ref(b, ahead.inputs.audio).inputs.audio1), ref(b, ref(b, ahead.inputs.audio).inputs.audio2)];
    expect(heard.inputs).toMatchObject({ audio: [idOf(b, "GetVideoComponents"), 1], start_index: 0, duration: 1 });
    expect(quiet.inputs).toMatchObject({ start_index: 0, duration: 13 / 25 });
    expect(ref(b, quiet.inputs.audio)).toMatchObject({ class_type: "AudioAdjustVolume", inputs: { volume: -100 } });
    expect(ref(b, wave.inputs.audio2).inputs).toMatchObject({ start_index: 0, duration: (145 - 38) / 25 });
    // the take's sound is the same; its head is the clip before's, carried: the sound hands over at the join
    expect(save(b).audio).toEqual(waveOf(b));
    expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, sound: true });
    expect(all(b, "SolidMask").map((n) => [n.inputs.value, n.inputs.height])).toEqual([[0, 145]]);
    // a clip before without sound: silence under the head, the join not carried
    const mute = build(ltxLipSync, { previous: { asset: "c" }, recordingSeconds: 4.2 }, { media: { previous: { ...prev, hasSound: false }, ...rec(4.2) } });
    const muteWave = ref(mute, waveOf(mute));
    expect(ref(mute, ref(mute, muteWave.inputs.audio1).inputs.audio)).toMatchObject({ class_type: "AudioAdjustVolume" });
    expect(mute.overlap).toEqual({ headMs: 1000, tailMs: 0 });
  });

  it("Lip sync carrying on in the clip before's latent (card #40): the picture from its latent, the sound the recording's, pinned whole", () => {
    const latentOf = { ...prev, latentFrames: 97, latentCut: 97, latentSize: { width: 704, height: 1280 } };
    const b = build(ltxLipSync, { previous: { asset: "c" }, recordingSeconds: 5 }, { uploads: { start: "a.png", recording: "rec.wav", previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: latentOf, ...rec(5) } });
    expect(all(b, "AfflatusLTXContinuation")).toHaveLength(1);
    expect(b.overlap).toMatchObject({ headMs: 1000, latent: true });
    // the sound sampled from is the recording's, laid after the clip before's own under the head, pinned whole
    const sampled = all(b, "SamplerCustomAdvanced").map((n) => ref(b, ref(b, n.inputs.latent_image).inputs.audio_latent));
    expect(sampled.every((n) => n.class_type === "SetLatentNoiseMask" && ref(b, n.inputs.mask).class_type === "SolidMask")).toBe(true);
    expect(ref(b, waveOf(b)).class_type).toBe("AudioConcat");
    expect(save(b).audio).toEqual(waveOf(b));
  });

  it("Lip sync sung up to its part by the clip before: the recording under the head too, one stretch of it", () => {
    const b = build(ltxLipSync, { previous: { asset: "c" }, recordingSeconds: 6, recordingLeadIn: true }, { media: { previous: prev, ...rec(6, { before: 1, after: 6 }) } });
    const wave = ref(b, waveOf(b));
    expect(wave).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0, duration: b.frames! / 25 } });
    expect(all(b, "AudioConcat")).toEqual([]);
    expect(b.overlap).toEqual({ headMs: 1000, tailMs: 0, sound: true });
  });

  it("Lip sync's sound cues: added over the recording at their moments, before it is pinned, and the take carries them", () => {
    const cues = [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }];
    const ctx = { uploads: { recording: "rec.wav", previous: "c.mp4", "cues.0": "clap.wav" }, media: { previous: prev, ...rec(5), "cues.0": { width: 0, height: 0, seconds: 0.6 } } };
    const b = build(ltxLipSync, { previous: { asset: "c" }, recordingSeconds: 5, cues }, ctx);
    const encoded = waveOf(b);
    // after the cue: the recording again, from where the cue ends (25 frames of head and 2.4 s in: 85 frames, 3.4 s)
    const after = ref(b, encoded);
    expect(after.class_type).toBe("AudioConcat");
    expect(ref(b, after.inputs.audio2).inputs).toMatchObject({ start_index: 85 / 25 + 0.6 });
    // before it, the recording up to the cue, then the cue added over its stretch (AudioMerge "add"), on LTX's 25 a second
    const upTo = ref(b, after.inputs.audio1);
    expect(ref(b, upTo.inputs.audio1).inputs).toMatchObject({ start_index: 0, duration: 85 / 25 });
    const merged = ref(b, upTo.inputs.audio2);
    expect(merged).toMatchObject({ class_type: "AudioMerge", inputs: { merge_method: "add" } });
    expect(ref(b, merged.inputs.audio1).inputs).toMatchObject({ start_index: 85 / 25, duration: 0.6 });
    expect(ref(b, ref(b, merged.inputs.audio2).inputs.audio)).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "clap.wav" } });
    // the same sound is the take's, and it is pinned whole
    expect(save(b).audio).toEqual(encoded);
    expect(all(b, "SolidMask").map((n) => n.inputs.value)).toEqual([0]);
    // one past the clip's own end is refused in words
    expect(() => build(ltxLipSync, { recordingSeconds: 5, cues: [{ ...cues[0]!, at: 9 }] }, { media: { ...rec(5), "cues.0": { width: 0, height: 0, seconds: 0.6 } } })).toThrow(/Sound cue 1 lands at 9 s, past the clip's end/);
    // no "In the take" on Lip sync: the take carries the cue as it was pinned
    expect(ltxLipSync.inputs.some((i) => i.type === "cues")).toBe(true);
    expect(ltxLipSync.inputs.some((i) => i.id === "cueSound")).toBe(false);
  });

  it("Video with audio's sound cues: each part laid into a silence the clip's length, its own stretch held, the rest the model's", () => {
    const cue = { asset: "s1", start: 0, seconds: 0.6, at: 2.4 };
    const cueMedia = { "cues.0": { width: 0, height: 0, seconds: 0.6 } };
    const b = build(ltxVideo, { recording: undefined, seconds: 5, cues: [cue] }, { uploads: { "cues.0": "clap.wav" }, media: cueMedia });
    expect(b.frames).toBe(129);
    // a silence as long as the clip, the cue laid in at 2.4 s (frame 60), encoded
    const wave = ref(b, waveOf(b));
    expect(wave.class_type).toBe("AudioConcat");
    const upTo = ref(b, wave.inputs.audio1);
    expect(ref(b, ref(b, upTo.inputs.audio1).inputs.audio)).toMatchObject({ class_type: "EmptyAudio", inputs: { duration: 129 / 25 } });
    expect(ref(b, ref(b, upTo.inputs.audio2).inputs.audio)).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "clap.wav" } });
    // held over the cue's 15 frames only, from frame 60: the rest of the column left to the model
    expect(all(b, "SolidMask").map((n) => [n.inputs.value, n.inputs.height])).toEqual([[1, 129], [0, 15]]);
    expect(all(b, "MaskComposite")[0]!.inputs).toMatchObject({ y: 60, operation: "multiply" });
    expect(all(b, "SetLatentNoiseMask")).toHaveLength(2);
    // the take: the model's sound, the cue's part laid in over its stretch
    const take = ref(b, save(b).audio);
    expect(take.class_type).toBe("AudioConcat");
    expect(ref(b, ref(b, ref(b, take.inputs.audio1).inputs.audio1).inputs.audio)).toMatchObject({ class_type: "LTXVAudioVAEDecode" });
    // the model's own asked for: its decoded sound alone in the take, the cue still held for it to hear
    const own = build(ltxVideo, { recording: undefined, seconds: 5, cues: [cue], cueSound: "LTX 2.3's own" }, { uploads: { "cues.0": "clap.wav" }, media: cueMedia });
    expect(ref(own, save(own).audio).class_type).toBe("LTXVAudioVAEDecode");
    expect(all(own, "MaskComposite")).toHaveLength(1);
    expect(ltxVideo.inputs.find((i) => i.id === "cueSound")).toMatchObject({ options: ["The file's sound", "LTX 2.3's own"] });
  });

  it("Video with audio's cues carrying on: the clip before's sound under the head from its file, head and cue held", () => {
    const cue = { asset: "s1", start: 0, seconds: 0.6, at: 2.4 };
    const latentOf = { ...prev, latentFrames: 97, latentCut: 97, latentSize: { width: 704, height: 1280 } };
    for (const [media, uploads] of [[{ previous: prev }, {}], [{ previous: latentOf }, { "previous.latent": "c.safetensors" }]] as const) {
      const b = build(ltxVideo, { recording: undefined, previous: { asset: "c" }, seconds: 5, cues: [cue] }, { uploads: { previous: "c.mp4", "cues.0": "clap.wav", ...uploads }, media: { ...media, "cues.0": { width: 0, height: 0, seconds: 0.6 } } });
      const frames = ltxFrames(6);
      const head = ref(b, ref(b, ref(b, ref(b, waveOf(b)).inputs.audio1).inputs.audio1).inputs.audio);
      expect(head.class_type).toBe("AudioConcat");
      expect(ref(b, head.inputs.audio1).inputs).toMatchObject({ audio: [idOf(b, "GetVideoComponents"), 1], duration: 1 });
      expect(ref(b, head.inputs.audio2)).toMatchObject({ class_type: "EmptyAudio", inputs: { duration: (frames - 25) / 25 } });
      // the head a frame short, then the cue at 25 + 60
      expect(all(b, "MaskComposite").map((n) => n.inputs.y)).toEqual([0, 85]);
      expect(all(b, "SolidMask").map((n) => n.inputs.height)).toEqual([frames, 24, 15]);
      expect(b.overlap).toMatchObject({ headMs: 1000 });
    }
  });

  it("LTX 2.5's Lip sync at 24 a second, under its dual guider", () => {
    const parts = { unet: "ltx-2.5-distilled.safetensors", clip: "gemma4.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };
    const b = build(ltx25LipSync, { recordingSeconds: 5.9 }, { slots: parts, media: rec(5.9) });
    // 5.9 s and the pad at 24: 150 frames, 145 on the grid
    expect(b.frames).toBe(145);
    expect(all(b, "LTXVEmptyLatentAudio")[0]!.inputs).toMatchObject({ frames_number: 145, frame_rate: 24 });
    expect(all(b, "LTXVDualCFGGuider")).toHaveLength(1);
    expect(all(b, "SetLatentNoiseMask")).toHaveLength(1);
  });

  it("Video with audio under a recording: the clip as long as its part, its own sound made, the part laid in as the take's", () => {
    const b = build(ltxVideo, { recordingSeconds: 5.9, seconds: 9 }, { media: rec(5.9, { after: 4 }) });
    expect(b.frames).toBe(153);
    // the model's sound is made freely, as on any clip, and dropped from the take
    expect(all(b, "SetLatentNoiseMask")).toEqual([]);
    expect(all(b, "LTXVAudioVAEDecode")).toHaveLength(1);
    expect(ref(b, save(b).audio)).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0, duration: 153 / 25 } });
    // carrying on: the head's own sound (the clip before's, pinned) before the part
    const c = build(ltxVideo, { previous: { asset: "c" }, recordingSeconds: 4.2 }, { media: { previous: prev, ...rec(4.2) } });
    const joined = ref(c, save(c).audio);
    expect(joined.class_type).toBe("AudioConcat");
    expect(ref(c, joined.inputs.audio1).inputs).toMatchObject({ audio: [idOf(c, "LTXVAudioVAEDecode"), 0], start_index: 0, duration: 1 });
    expect(ref(c, joined.inputs.audio2).inputs).toMatchObject({ duration: (c.frames! - 25) / 25 });
    // not under one, as before: Duration decides, the model's sound is the take's
    const free = build(ltxVideo, { recording: undefined, seconds: 5 });
    expect(free.frames).toBe(ltxFrames(5));
    expect(ref(free, save(free).audio).class_type).toBe("LTXVAudioVAEDecode");
  });
});

describe("flux and qwen image, from what is said once about each", () => {
  const fluxFiles = { unet: "flux1-dev.safetensors", clipL: "clip_l.safetensors", t5: "t5xxl.safetensors", vae: "ae.safetensors" };
  const qwenFiles = { unet: "qwen_image.safetensors", clip: "qwen_2.5_vl_7b.safetensors", vae: "qwen_image_vae.safetensors" };
  const all = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const fluxOf = (over: Record<string, unknown> = {}) => fluxPicture.build(parseInput(fluxPicture, { prompt: "a cat", ...over }), dryContext({ seed: 7, slots: fluxFiles }));
  const qwenOf = (over: Record<string, unknown> = {}, slots: Record<string, string> = qwenFiles) => qwenPicture.build(parseInput(qwenPicture, { prompt: "a cat", ...over }), dryContext({ seed: 7, slots }));

  it("builds FLUX.1 as ComfyUI's template does: two text encoders, guidance on the prompt, CFG 1, no negative prompt", () => {
    const b = fluxOf();
    expect(all(b, "DualCLIPLoader")[0]!.inputs).toMatchObject({ clip_name1: "clip_l.safetensors", clip_name2: "t5xxl.safetensors", type: "flux" });
    expect(all(b, "FluxGuidance")[0]!.inputs.guidance).toBe(3.5);
    expect(all(b, "KSampler")[0]!.inputs).toMatchObject({ steps: 20, cfg: 1, sampler_name: "euler", scheduler: "simple", seed: 7 });
    expect(all(b, "ConditioningZeroOut")).toHaveLength(1);
    expect(all(b, "EmptySD3LatentImage")[0]!.inputs).toMatchObject({ width: 896, height: 1152 });
    // the shift follows the size of the picture, the model's own 1.15 as the largest; one that is typed takes its place
    expect(all(b, "ModelSamplingFlux")[0]!.inputs).toMatchObject({ max_shift: 1.15, base_shift: 0.5, width: 896, height: 1152 });
    expect(all(fluxOf({ shift: 1.5 }), "ModelSamplingFlux")[0]!.inputs).toMatchObject({ max_shift: 1.5, width: 896, height: 1152 });
    // the weights as the file holds them, or fp8 when asked
    expect(all(b, "UNETLoader")[0]!.inputs.weight_dtype).toBe("default");
    expect(all(fluxOf({ precision: "fp8_e4m3fn" }), "UNETLoader")[0]!.inputs.weight_dtype).toBe("fp8_e4m3fn");
    // a negative prompt that is written is encoded
    expect(all(fluxOf({ negative: "blurry", cfg: 2 }), "ConditioningZeroOut")).toEqual([]);
    expect(fluxPicture.inputs.map((i) => i.id)).toContain("guidance");
    expect(fluxPicture.inputs.map((i) => i.id)).not.toContain("fast");
  });

  it("builds Qwen Image with its shift and a CFG, and in a few steps with its Lightning LoRA", () => {
    const b = qwenOf();
    expect(all(b, "CLIPLoader")[0]!.inputs).toMatchObject({ clip_name: "qwen_2.5_vl_7b.safetensors", type: "qwen_image" });
    expect(all(b, "ModelSamplingAuraFlow")[0]!.inputs.shift).toBe(3.1);
    expect(all(b, "KSampler")[0]!.inputs).toMatchObject({ steps: 50, cfg: 4 });
    // the negative prompt starts on Qwen's own; emptied, it is an empty text, as the template has it
    expect(all(b, "CLIPTextEncode").map((n) => n.inputs.text)[1]).toMatch(/^低分辨率/);
    expect(all(qwenOf({ negative: "" }), "CLIPTextEncode").map((n) => n.inputs.text)).toEqual(["a cat", ""]);
    expect(all(b, "FluxGuidance")).toEqual([]);
    const fast = qwenOf({ fast: true }, { ...qwenFiles, turbo: "lightning.safetensors" });
    expect(all(fast, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["lightning.safetensors"]);
    expect(all(fast, "KSampler")[0]!.inputs).toMatchObject({ steps: 4, cfg: 1 });
    // Turbo with no LoRA and a model that is not made for it: the full steps
    expect(all(qwenOf({ fast: true }), "KSampler")[0]!.inputs).toMatchObject({ steps: 50, cfg: 4 });
    // a model named for it needs none, and runs at its few steps whether Turbo is on or not
    const made = qwenOf({ fast: true, turboSteps: 8, model: "someone_qwen_lightning_8steps.safetensors" }, { ...qwenFiles, turbo: "lightning.safetensors" });
    expect(all(made, "LoraLoaderModelOnly")).toEqual([]);
    expect(all(made, "KSampler")[0]!.inputs).toMatchObject({ steps: 8, cfg: 1 });
    expect(all(qwenOf({ fast: false, turboSteps: 8, model: "someone_qwen_lightning_8steps.safetensors" }), "KSampler")[0]!.inputs).toMatchObject({ steps: 8, cfg: 1 });
  });

  it("starts few-step SDXL checkpoints on few steps, and leaves the names that only look alike", () => {
    const first = (name: string) => sdxlTextToPicture.presets!.filter((p) => new RegExp(p.match, "i").test(name)).map((p) => p.note);
    expect(first("BabesIllustriousBSY_DMD2_C36.safetensors")[0]).toMatch(/DMD2/);
    expect(first("BabesIllustriousBSY_DMD2_C36.safetensors")[1]).toMatch(/Illustrious/);
    expect(first("juggernautXL_v9Lightning4S.safetensors")[0]).toMatch(/Lightning/);
    expect(first("dreamshaperXL_v21TurboDPMSDE.safetensors")[0]).toMatch(/Turbo/);
    expect(first("Hyper-SDXL-8steps.safetensors")[0]).toMatch(/Hyper/);
    for (const name of ["HyperRealismXL_v3.safetensors", "realvisxlV50.safetensors", "noobaiXLNAIXL_vPred10.safetensors"]) expect(first(name).join(), name).not.toMatch(/few steps/);
  });
  it("finds each family's files by name, and not the files of another model that are named alike", () => {
    const found = (family: { slots: Array<{ id: string; detect: string[] }> }, slot: string, files: string[]) => {
      const patterns = family.slots.find((x) => x.id === slot)!.detect.map((d) => new RegExp(d, "i"));
      for (const p of patterns) { const hit = files.find((f) => p.test(f)); if (hit) return hit; }
      return null;
    };
    // FLUX.1: never FLUX.2 Klein, never Kontext as the model that draws, never Wan's UMT5 as T5, never FLUX.2's VAE
    expect(found(flux, "unet", ["flux-2-klein-base-4b.safetensors", "flux1-dev-kontext_fp8_scaled.safetensors"])).toBeNull();
    expect(found(flux, "unet", ["flux1-dev-kontext_fp8_scaled.safetensors", "flux1-schnell.safetensors", "Flux/flux1-dev-fp8.safetensors"])).toBe("Flux/flux1-dev-fp8.safetensors");
    expect(found(flux, "kontext", ["flux1-dev.safetensors", "flux1-dev-kontext_fp8_scaled.safetensors"])).toBe("flux1-dev-kontext_fp8_scaled.safetensors");
    expect(found(flux, "t5", ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"])).toBeNull();
    expect(found(flux, "t5", ["umt5_xxl_fp8_e4m3fn_scaled.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors"])).toBe("t5xxl_fp8_e4m3fn_scaled.safetensors");
    expect(found(flux, "vae", ["flux2-vae.safetensors", "Wan/wan_2.1_vae.safetensors"])).toBeNull();
    expect(found(flux, "vae", ["flux2-vae.safetensors", "ae.safetensors"])).toBe("ae.safetensors");
    expect(found(flux, "clipL", ["clip_vision_h.safetensors", "clip_l.safetensors"])).toBe("clip_l.safetensors");
    // Qwen Image: never the Edit model as the one that draws, never another Qwen text encoder
    expect(found(qwen, "unet", ["qwen_image_edit_2511_fp8mixed.safetensors"])).toBeNull();
    expect(found(qwen, "unet", ["qwen_image_fp8_e4m3fn.safetensors", "qwen_image_2512_fp8_e4m3fn.safetensors"])).toBe("qwen_image_2512_fp8_e4m3fn.safetensors");
    expect(found(qwen, "edit", ["qwen_image_2512_fp8_e4m3fn.safetensors", "qwen_image_edit_2511_fp8mixed.safetensors"])).toBe("qwen_image_edit_2511_fp8mixed.safetensors");
    expect(found(qwen, "clip", ["qwen3vl_4b_fp8_scaled.safetensors", "qwen_3_4b.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"])).toBeNull();
    expect(found(qwen, "clip", ["qwen_2.5_vl_7b_fp8_scaled.safetensors"])).toBe("qwen_2.5_vl_7b_fp8_scaled.safetensors");
    expect(found(qwen, "turbo", ["Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"])).toBeNull();
    // Z-Image: Turbo first, never the Omni or Edit models; its text encoder is Klein's Qwen3 4B, never Krea 2's Qwen3-VL;
    // FLUX.1's VAE, never FLUX.2's; and no other family takes its models, nor it theirs
    expect(found(zimage, "unet", ["z_image_omni_bf16.safetensors", "z_image_edit_bf16.safetensors", "flux1-dev.safetensors", "qwen_image_2512_fp8_e4m3fn.safetensors"])).toBeNull();
    expect(found(zimage, "unet", ["z_image_bf16.safetensors", "ZImage/someone_zimage_turbo_v2.safetensors", "z_image_turbo_bf16.safetensors"])).toBe("ZImage/someone_zimage_turbo_v2.safetensors");
    expect(found(zimage, "unet", ["z_image_base_bf16.safetensors", "z_image_turbo_bf16.safetensors"])).toBe("z_image_turbo_bf16.safetensors");
    expect(found(zimage, "unet", ["z_image_base_bf16.safetensors"])).toBe("z_image_base_bf16.safetensors");
    expect(found(zimage, "unet", ["Realism/ZIT_realism_v3.safetensors"])).toBe("Realism/ZIT_realism_v3.safetensors");
    expect(found(zimage, "clip", ["qwen3vl_4b_fp8_scaled.safetensors", "qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"])).toBeNull();
    expect(found(zimage, "clip", ["qwen3vl_4b_fp8_scaled.safetensors", "qwen_3_4b.safetensors"])).toBe("qwen_3_4b.safetensors");
    expect(found(zimage, "vae", ["flux2-vae.safetensors", "qwen_image_vae.safetensors", "Wan/wan_2.1_vae.safetensors", "klein_flux_vae.safetensors"])).toBeNull();
    expect(found(zimage, "vae", ["flux2-vae.safetensors", "ae.safetensors"])).toBe("ae.safetensors");
    const zFiles = ["z_image_turbo_bf16.safetensors", "z_image_bf16.safetensors", "ZImage/someone_zimage_turbo_v2.safetensors"];
    for (const family of [flux, qwen, ...["klein", "krea2", "qwen21", "h3", "wan", "ltx"].map((id) => familyById(id)!)]) {
      for (const slot of family.slots.filter((x) => x.folder === "diffusion_models")) expect(found(family, slot.id, zFiles), `${family.id}.${slot.id}`).toBeNull();
    }
    expect(found(zimage, "unet", ["flux-2-klein-base-4b.safetensors", "krea2_turbo_fp8_scaled.safetensors", "qwen_image_2.1_int8_convrot.safetensors", "minimax_h3_fl2va.safetensors", "flux1-dev-kontext_fp8_scaled.safetensors"])).toBeNull();
    // Wan and LTX: each half of Wan goes to its own slot; LTX's two VAEs are told apart
    expect(found(wan, "i2vHigh", ["Low/SomeoneWAN22I2V14B_LowV1.safetensors", "High/SomeoneWAN22I2V14B_HighV1.safetensors"])).toBe("High/SomeoneWAN22I2V14B_HighV1.safetensors");
    expect(found(wan, "i2vLow", ["High/SomeoneWAN22I2V14B_HighV1.safetensors", "Low/SomeoneWAN22I2V14B_LowV1.safetensors"])).toBe("Low/SomeoneWAN22I2V14B_LowV1.safetensors");
    expect(found(wan, "t2vHigh", ["High/SomeoneWAN22I2V14B_HighV1.safetensors"])).toBeNull();
    expect(found(ltx, "videoVae", ["taeltx2_3.safetensors", "LTX23_audio_vae_bf16.safetensors", "LTX23_video_vae_bf16.safetensors"])).toBe("LTX23_video_vae_bf16.safetensors");
    expect(found(ltx, "audioVae", ["LTX23_video_vae_bf16.safetensors", "LTX23_audio_vae_bf16.safetensors"])).toBe("LTX23_audio_vae_bf16.safetensors");
    // the two passes halve the first one, so only the ×2 latent upscaler fits: never the ×1.5 one
    expect(found(ltx, "upscaler", ["ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors"])).toBeNull();
    expect(found(ltx, "upscaler", ["ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors", "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"])).toBe("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
  });

  it("gives every picture model the same six operations, under the names the tools look for", () => {
    for (const family of ["flux", "qwen"]) {
      const ids = recipes.filter((r) => r.family === family).map((r) => r.id);
      expect(ids).toEqual([`${family}.text-to-picture`, `${family}.edit`, `${family}.redraw`, `${family}.paint-over`, `${family}.outpaint`, `${family}.sharper`, `${family}.fix-face`]);
    }
  });

  it("edits a picture with the model made for it, and says which file is missing without it", () => {
    const kontext = fluxEdit.build(parseInput(fluxEdit, { source: "p", prompt: "make it red" }), dryContext({ seed: 7, slots: { ...fluxFiles, kontext: "kontext.safetensors" }, uploads: { source: "s.png" } }));
    expect(all(kontext, "UNETLoader")[0]!.inputs.unet_name).toBe("kontext.safetensors");
    expect(all(kontext, "ReferenceLatent")).toHaveLength(1);
    expect(all(kontext, "FluxGuidance")[0]!.inputs.guidance).toBe(2.5);
    expect(() => fluxEdit.build(parseInput(fluxEdit, { source: "p", prompt: "x" }), dryContext({ slots: fluxFiles, uploads: { source: "s.png" } }))).toThrow(/Edit needs FLUX.1 Kontext/);
    expect(fluxEdit.needs).toEqual(["kontext"]);

    const edit = qwenEdit.build(
      parseInput(qwenEdit, { source: "p", prompt: "put her in image 2", references: [{ asset: "a", role: "place" }] }),
      dryContext({ seed: 7, slots: { ...qwenFiles, edit: "qwen_image_edit.safetensors" }, uploads: { source: "s.png", "references.0": "a.png" } }),
    );
    const read = all(edit, "TextEncodeQwenImageEditPlus");
    expect(read.map((n) => n.inputs.prompt)[0]).toBe("put her in image 2");
    expect(read.map((n) => n.inputs.prompt)[1]).toMatch(/^低分辨率/);
    expect(Object.keys(read[0]!.inputs)).toEqual(expect.arrayContaining(["image1", "image2"]));
    expect(all(edit, "KSampler")[0]!.inputs).toMatchObject({ steps: 40, cfg: 4, denoise: 1 });
    expect(all(edit, "CFGNorm")).toHaveLength(1);
    expect(() => qwenEdit.build(parseInput(qwenEdit, { source: "p", prompt: "x" }), dryContext({ slots: qwenFiles, uploads: { source: "s.png" } }))).toThrow(/Edit needs Qwen Image Edit/);
  });
});

describe("zimage: built the way ComfyUI's own Z-Image Turbo template builds it", () => {
  const files = { unet: "z_image_turbo_bf16.safetensors", clip: "qwen_3_4b.safetensors", vae: "ae.safetensors" };
  const all = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const build = (over: Record<string, unknown> = {}) => zimagePicture.build(parseInput(zimagePicture, { prompt: "a cat", ...over }), dryContext({ seed: 7, slots: files }));

  it("reads with Qwen3 4B as Lumina 2's encoder, shifts by 3, and samples 8 steps of res_multistep at CFG 1 with the negative side emptied", () => {
    const b = build();
    expect(all(b, "UNETLoader")[0]!.inputs).toMatchObject({ unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" });
    expect(all(b, "CLIPLoader")[0]!.inputs).toMatchObject({ clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" });
    expect(all(b, "VAELoader")[0]!.inputs.vae_name).toBe("ae.safetensors");
    expect(all(b, "ModelSamplingAuraFlow")[0]!.inputs.shift).toBe(3);
    expect(all(b, "ModelSamplingFlux")).toEqual([]);
    expect(all(b, "KSampler")[0]!.inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1, seed: 7 });
    expect(all(b, "ConditioningZeroOut")).toHaveLength(1);
    expect(all(b, "CLIPTextEncode").map((n) => n.inputs.text)).toEqual(["a cat"]);
    expect(all(b, "FluxGuidance")).toEqual([]);
    expect(all(b, "EmptySD3LatentImage")[0]!.inputs).toMatchObject({ width: 896, height: 1152, batch_size: 1 });
    // on a grid of 16
    expect(all(build({ size: { width: 1000, height: 1300 } }), "EmptySD3LatentImage")[0]!.inputs).toMatchObject({ width: 1008, height: 1296 });
    // a negative prompt that is written is encoded; a shift of 0 leaves the model's own
    expect(all(build({ negative: "blurry", cfg: 3 }), "CLIPTextEncode").map((n) => n.inputs.text)).toEqual(["a cat", "blurry"]);
    expect(all(build({ shift: 0 }), "ModelSamplingAuraFlow")).toEqual([]);
    expect(zimagePicture.inputs.map((i) => i.id)).not.toContain("guidance");
    expect(zimagePicture.inputs.map((i) => i.id)).not.toContain("fast");
    expect(b.loads).toEqual(["diffusion_models/z_image_turbo_bf16.safetensors", "text_encoders/qwen_3_4b.safetensors", "vae/ae.safetensors"]);
  });

  it("has the operations of the other picture models but Edit, which Z-Image has no model for", () => {
    expect(recipes.filter((r) => r.family === "zimage").map((r) => r.id)).toEqual(["zimage.text-to-picture", "zimage.redraw", "zimage.paint-over", "zimage.outpaint", "zimage.sharper", "zimage.fix-face"]);
    expect(familyById("zimage")!.name).toBe("Z-Image");
  });

  it("starts Z-Image Base on its own sampling, only by its own names: never Turbo or a fine-tune of it", () => {
    const matched = (name: string) => zimagePicture.presets!.filter((p) => new RegExp(p.match, "i").test(name)).map((p) => p.values);
    expect(matched("z_image_bf16.safetensors")).toEqual([{ steps: 30, cfg: 4, sampler: "res_multistep" }]);
    expect(matched("ZImage\\z_image_fp8_e4m3fn.safetensors")).toHaveLength(1);
    expect(matched("Z-Image-Base-fp16.safetensors")).toHaveLength(1);
    for (const name of ["z_image_turbo_bf16.safetensors", "ZImage/z_image_turbo_fp8.safetensors", "someone_zimage_v2.safetensors", "Realism/ZIT_realism_v3.safetensors"]) expect(matched(name), name).toEqual([]);
  });

  it("warns on weights and quality words in a prompt", () => {
    const lint = (text: string) => zimage.lint!({ text, main: "prompt", changes: {} }).map((l) => l.text);
    expect(lint("A photograph of a (red:1.3) door.")).toEqual([expect.stringMatching(/weight/)]);
    expect(lint("masterpiece, a door")).toEqual([expect.stringMatching(/Quality words/)]);
    expect(lint("A photograph of a red door in the rain.")).toEqual([]);
  });
});

describe("klein: the model and how it samples are the user's to set", () => {
  const picture = recipes.find((r) => r.id === "klein.picture")!;
  const slots = { unet: "flux-2-klein-base-4b.safetensors", clip: "qwen_3_4b.safetensors", vae: "flux2-vae.safetensors" };
  const build = (over: Record<string, unknown> = {}) => picture.build(parseInput(picture, { prompt: "a cat", ...over }), dryContext({ seed: 7, slots }));
  const one = (b: ReturnType<typeof build>, cls: string) => Object.values(b.graph).find((n) => n.class_type === cls)!.inputs;

  it("starts on the base model's values, and takes another model, steps, CFG and sampler", () => {
    const usual = build();
    expect(one(usual, "UNETLoader").unet_name).toBe("flux-2-klein-base-4b.safetensors");
    expect(one(usual, "Flux2Scheduler").steps).toBe(20);
    expect(one(usual, "CFGGuider").cfg).toBe(5);
    expect(one(usual, "KSamplerSelect").sampler_name).toBe("euler");
    // a distilled model, set the way it wants
    const fast = build({ model: "flux-2-klein-4b-distilled.safetensors", steps: 4, cfg: 1, sampler: "res_multistep" });
    expect(one(fast, "UNETLoader").unet_name).toBe("flux-2-klein-4b-distilled.safetensors");
    expect(one(fast, "Flux2Scheduler").steps).toBe(4);
    expect(one(fast, "CFGGuider").cfg).toBe(1);
    expect(one(fast, "KSamplerSelect").sampler_name).toBe("res_multistep");
    expect(fast.loads).toContain("diffusion_models/flux-2-klein-4b-distilled.safetensors");
    // every Klein operation has the model to pick, and keeps steps, CFG, sampler and negative prompt per model
    for (const r of recipes.filter((x) => x.family === "klein")) {
      expect(r.inputs[0], r.id).toMatchObject({ id: "model", type: "model", slot: "unet" });
      expect(r.inputs.filter((i) => i.perModel).map((i) => i.id), r.id).toEqual(expect.arrayContaining(["steps", "cfg", "sampler"]));
    }
  });
});

describe("what was fixed inside the recipes is the user's to set", () => {
  const byId = (id: string) => recipes.find((r) => r.id === id)!;
  const node = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls).map((n) => n.inputs);
  const photo = { width: 1536, height: 2048 };
  const files: Record<string, Record<string, string>> = {
    sdxl: {},
    klein: { unet: "klein.safetensors", clip: "qwen_3_4b.safetensors", vae: "flux2-vae.safetensors" },
    krea2: { unet: "krea2.safetensors", clip: "qwen3vl_4b.safetensors", vae: "qwen_image_vae.safetensors" },
    flux: { unet: "flux1-dev.safetensors", clipL: "clip_l.safetensors", t5: "t5xxl.safetensors", vae: "ae.safetensors" },
    qwen: { unet: "qwen_image.safetensors", clip: "qwen_2.5_vl_7b.safetensors", vae: "qwen_image_vae.safetensors" },
    zimage: { unet: "z_image_turbo_bf16.safetensors", clip: "qwen_3_4b.safetensors", vae: "ae.safetensors" },
  };
  const build = (id: string, input: Record<string, unknown>, ctx: Parameters<typeof dryContext>[0] = {}) => {
    const r = byId(id);
    const family = id.split(".")[0]!;
    return r.build(parseInput(r, { ...(family === "sdxl" ? { checkpoint: "c.safetensors" } : {}), ...input }), dryContext({ seed: 7, slots: files[family] ?? {}, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } }, ...ctx }));
  };
  const families = ["sdxl", "klein", "krea2", "flux", "qwen", "zimage"];

  it("the face detailer: how sure it must be, the room around the face, and the sizes it works at", () => {
    for (const family of families) {
      const usual = node(build(`${family}.fix-face`, { source: "p", detector: "bbox/face.pt" }), "FaceDetailer")[0]!;
      expect(usual, family).toMatchObject({ bbox_threshold: 0.5, bbox_dilation: 10, bbox_crop_factor: 3, guide_size: 1024, guide_size_for: false, max_size: 1280, feather: 5 });
      const set = node(build(`${family}.fix-face`, { source: "p", detector: "bbox/face.pt", faceThreshold: 0.3, faceGrow: 20, faceCrop: 2, faceSize: 1024, faceMax: 1536, faceFeather: 12 }), "FaceDetailer")[0]!;
      expect(set, family).toMatchObject({ bbox_threshold: 0.3, bbox_dilation: 20, bbox_crop_factor: 2, guide_size: 1024, max_size: 1536, feather: 12 });
      // the largest size is never under the size it is redrawn at
      expect(node(build(`${family}.fix-face`, { source: "p", detector: "bbox/face.pt", faceSize: 1280, faceMax: 1024 }), "FaceDetailer")[0]!.max_size, family).toBe(1280);
    }
  });

  it("the inpaint mask: how far it reaches and how soft its edge is, picked from the part's size when left at 0", () => {
    for (const family of families) {
      const usual = build(`${family}.paint-over`, { source: "p", mask: "m", prompt: "a" });
      expect(node(usual, "GrowMask")[0]!.expand, family).toBe(6);
      expect(node(usual, "ImageBlur")[0]!.blur_radius, family).toBe(12);
      const set = build(`${family}.paint-over`, { source: "p", mask: "m", prompt: "a", maskGrow: 24, maskBlur: 30 });
      expect(node(set, "GrowMask")[0]!.expand, family).toBe(24);
      expect(node(set, "ImageBlur")[0]!.blur_radius, family).toBe(30);
    }
  });

  it("an upscale: by how much", () => {
    for (const family of families) {
      const scale = (factor?: number) => node(build(`${family}.sharper`, { source: "p", upscaler: "u.pth", refine: false, ...(factor ? { factor } : {}) }, { media: { source: { width: 640, height: 960 } } }), "ImageScale")[0]!;
      expect([scale().width, scale().height], family).toEqual([1280, 1920]);
      expect([scale(3).width, scale(3).height], family).toEqual([1920, 2880]);
    }
  });

  it("a hires second pass: its own sampler and scheduler, or the first pass's", () => {
    for (const id of ["sdxl.text-to-picture", "krea2.text-to-picture", "flux.text-to-picture", "qwen.text-to-picture", "zimage.text-to-picture"]) {
      const same = node(build(id, { prompt: "a", hires: true, hiresUpscaler: "u.pth", sampler: "euler", scheduler: "simple" }), "KSampler");
      expect(same.map((k) => [k.sampler_name, k.scheduler]), id).toEqual([["euler", "simple"], ["euler", "simple"]]);
      const own = node(build(id, { prompt: "a", hires: true, hiresUpscaler: "u.pth", sampler: "euler", scheduler: "simple", hiresSampler: "dpmpp_2m", hiresScheduler: "beta" }), "KSampler");
      expect(own.map((k) => [k.sampler_name, k.scheduler]), id).toEqual([["euler", "simple"], ["dpmpp_2m", "beta"]]);
    }
  });

  it("a video: how it is encoded, Wan's frame rate, LTX's refining pass and decoding, H3's step cache", () => {
    const h3 = (over: Record<string, unknown>) => h3Video.build(parseInput(h3Video, { description: "a", ...over }), dryContext({ slots: { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" } }));
    expect(node(h3({}), "VHS_VideoCombine")[0]!.crf).toBe(19);
    expect(node(h3({ crf: 12 }), "VHS_VideoCombine")[0]!.crf).toBe(12);
    expect(node(h3({ fast: false, cache: true }), "MiniMaxH3Cache")[0]).toMatchObject({ reuse_threshold: 0.05, start_percent: 0.15, end_percent: 0.9, max_steps: 2 });
    expect(node(h3({ fast: false, cache: true, cacheThreshold: 0.1, cacheStart: 0.3, cacheEnd: 0.8, cacheSteps: 3 }), "MiniMaxH3Cache")[0]).toMatchObject({ reuse_threshold: 0.1, start_percent: 0.3, end_percent: 0.8, max_steps: 3 });

    const wanOf = (over: Record<string, unknown>, rife = false) => wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors", ...(rife ? { rife: "r.pth" } : {}) }, uploads: { start: "a.png" }, media: { start: photo } }));
    expect(node(wanOf({}), "VHS_VideoCombine")[0]).toMatchObject({ frame_rate: 16, crf: 19 });
    expect(node(wanOf({ fps: 24, crf: 23 }), "VHS_VideoCombine")[0]).toMatchObject({ frame_rate: 24, crf: 23 });
    expect(node(wanOf({ fps: 24 }, true), "VHS_VideoCombine")[0]!.frame_rate).toBe(48);

    const ltxOf = (over: Record<string, unknown>, slots: Record<string, string> = {}) => ltxVideo.build(parseInput(ltxVideo, { prompt: "a", ...over }), dryContext({ slots: { checkpoint: "ltx-2.3-22b-dev.safetensors", clip: "gemma.safetensors", upscaler: "up.safetensors", turbo: "lora.safetensors", ...slots } }));
    const usual = ltxOf({});
    expect(node(usual, "LoraLoaderModelOnly")[0]!.strength_model).toBe(0.5);
    expect(node(usual, "VAEDecodeTiled")[0]).toMatchObject({ tile_size: 768, temporal_size: 4096 });
    const set = ltxOf({ refineStrength: 0.6, refineSteps: 5, loraStrength: 0.8, tile: 512, tileFrames: 64, crf: 15 });
    expect(node(set, "LoraLoaderModelOnly")[0]!.strength_model).toBe(0.8);
    expect(node(set, "VAEDecodeTiled")[0]).toMatchObject({ tile_size: 512, temporal_size: 64 });
    expect(node(set, "VHS_VideoCombine")[0]!.crf).toBe(15);
    const refine = String(node(set, "ManualSigmas")[1]!.sigmas).split(",").map(Number);
    expect(refine).toHaveLength(6);
    expect(refine[0]).toBe(0.6);
    expect(refine.at(-1)).toBe(0);
    // it comes down all the way, never back up
    expect(refine.every((x, i) => i === 0 || x < refine[i - 1]!)).toBe(true);
    // LTX's 3 refine steps, and one more past 241 frames (a 10 s clip is 251) when the count was left at 3
    const steps = (b: ReturnType<typeof ltxOf>) => String(node(b, "ManualSigmas")[1]!.sigmas).split(",").length - 1;
    expect(steps(ltxOf({ seconds: 5 }))).toBe(3);
    expect(steps(ltxOf({ seconds: 10 }))).toBe(4);
    expect(steps(ltxOf({ seconds: 10, refineSteps: 2 }))).toBe(2);
    expect(set.passes!.map((x) => x.steps)).toEqual([8, 5]);
  });
});

describe("the animated live preview of Wan and LTX", () => {
  const node = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const photo = { width: 1536, height: 2048 };
  const wanOf = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}, more: Record<string, string> = {}) =>
    wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors", ...more }, uploads: { start: "a.png" }, media: { start: photo }, ...ctx }));
  const ltxOf = (over: Record<string, unknown> = {}, ctx: Parameters<typeof dryContext>[0] = {}, more: Record<string, string> = {}) =>
    ltxVideo.build(parseInput(ltxVideo, { prompt: "a", ...over }), dryContext({ slots: { checkpoint: "ltx-2.3-22b-distilled.safetensors", clip: "gemma.safetensors", upscaler: "up.safetensors", ...more }, ...ctx }));

  it("Wan: both models send a short clip each step, in place of ComfyUI's still first frame", () => {
    const b = wanOf();
    const previews = node(b, "ModelPreviewOverrideKJ");
    expect(previews).toHaveLength(2);
    for (const p of previews) expect(p.inputs).toMatchObject({ suppress_default_preview: true, preview_frames: 16, tiny_vae: "none" });
    // each sampling pass runs on a model that previews
    const ids = Object.entries(b.graph).filter(([, n]) => n.class_type === "ModelPreviewOverrideKJ").map(([id]) => id);
    expect(node(b, "KSamplerAdvanced").map((k) => (k.inputs.model as [string, number])[0]).sort()).toEqual([...ids].sort());
    expect(node(wanOf({}, {}, { tinyVae: "taew2_1.safetensors" }), "ModelPreviewOverrideKJ")[0]!.inputs.tiny_vae).toBe("taew2_1.safetensors");
  });

  it("LTX: one preview on the model of every pass", () => {
    const b = ltxOf();
    const previews = Object.entries(b.graph).filter(([, n]) => n.class_type === "ModelPreviewOverrideKJ");
    expect(previews).toHaveLength(1);
    expect(previews[0]![1].inputs).toMatchObject({ suppress_default_preview: true, preview_frames: 16, tiny_vae: "none" });
    // no sound: the node plays it for H3 alone
    expect(previews[0]![1].inputs.audio_vae).toBeUndefined();
    for (const guider of node(b, "CFGGuider")) expect((guider.inputs.model as [string, number])[0]).toBe(previews[0]![0]);
    expect(node(ltxOf({}, {}, { tinyVae: "taeltx_2.safetensors" }), "ModelPreviewOverrideKJ")[0]!.inputs.tiny_vae).toBe("taeltx_2.safetensors");
  });

  it("is left out when switched off, and when ComfyUI has no such node", () => {
    for (const of of [wanOf, ltxOf]) {
      expect(node(of({ livePreview: false }), "ModelPreviewOverrideKJ")).toHaveLength(0);
      expect(node(of({}, { has: (c: string) => c !== "ModelPreviewOverrideKJ" }), "ModelPreviewOverrideKJ")).toHaveLength(0);
    }
  });
});

describe("Wan: the models fit the way the clip is made", () => {
  const node = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const i2v = { i2vHigh: "wan2.2_i2v_high_noise_14B.safetensors", i2vLow: "wan2.2_i2v_low_noise_14B.safetensors", clip: "c.safetensors", vae: "v.safetensors" };
  const t2v = { t2vHigh: "wan2.2_t2v_high_noise_14B.safetensors", t2vLow: "wan2.2_t2v_low_noise_14B.safetensors" };
  const tuned = { model: "High/SomeoneWAN22I2V14B_HighV1.safetensors", modelLow: "Low/SomeoneWAN22I2V14B_LowV1.safetensors" };
  const build = (input: Record<string, unknown>, slots: Record<string, string>, picture = false) =>
    wanVideo.build(parseInput(wanVideo, { prompt: "a", ...(picture ? { start: "p" } : {}), ...input }), dryContext({ slots, ...(picture ? { uploads: { start: "a.png" }, media: { start: { width: 720, height: 1280 } } } : {}) }));
  const unets = (b: ReturnType<typeof build>) => node(b, "UNETLoader").map((n) => n.inputs.unet_name);

  it("words alone with picture-to-video models and no words-to-video ones renders nothing, and says why", () => {
    // what the form holds when only I2V files are there: they would make a flat gray clip
    expect(() => build(tuned, i2v)).toThrow(/words-to-video \(T2V\) models.*picture-to-video \(I2V\) models.*gray.*start image/s);
    expect(() => build({}, i2v)).toThrow(/words-to-video \(T2V\) models/);
  });

  it("words alone takes the words-to-video files in place of a picture-to-video model picked on the form", () => {
    expect(unets(build(tuned, { ...i2v, ...t2v }))).toEqual([t2v.t2vHigh, t2v.t2vLow]);
    expect(node(build(tuned, { ...i2v, ...t2v }), "WanImageToVideo")).toHaveLength(0);
  });

  it("a picked model made for the way, or that does not say, is the one used", () => {
    expect(unets(build(tuned, i2v, true))).toEqual([tuned.model, tuned.modelLow]);
    const mine = { model: "my-wan-high.safetensors", modelLow: "my-wan-low.safetensors" };
    expect(unets(build(mine, i2v))).toEqual([mine.model, mine.modelLow]);
    const words = { model: "tune_T2V_high.safetensors", modelLow: "tune_T2V_low.safetensors" };
    expect(unets(build(words, i2v))).toEqual([words.model, words.modelLow]);
  });

  it("a start image with words-to-video models picked takes the picture-to-video files, or says why it cannot", () => {
    const words = { model: "tune_T2V_high.safetensors", modelLow: "tune_T2V_low.safetensors" };
    expect(unets(build(words, i2v, true))).toEqual([i2v.i2vHigh, i2v.i2vLow]);
    expect(() => build(words, { clip: "c.safetensors", vae: "v.safetensors" }, true)).toThrow(/do not look at the start image/);
  });
});

describe("H3's upscale pass", () => {
  const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };
  const node = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const build = (over: Record<string, unknown>, more: Record<string, string> = {}, has: (c: string) => boolean = () => true) =>
    h3Video.build(parseInput(h3Video, { description: "a", ...over }), dryContext({ slots: { ...slots, ...more }, has }));

  it("is off by itself: the clip is decoded as it was sampled", () => {
    const b = build({});
    expect(node(b, "MMH3UltimateUpscale")).toHaveLength(0);
    expect((node(b, "VAEDecodeTiled")[0] ?? node(b, "VAEDecode")[0])!.inputs.samples).toEqual((node(b, "VAEDecodeTiled")[0] ?? node(b, "VAEDecode")[0])!.inputs.samples);
  });

  it("carries a chain's colour match on: its frames brought to the clip before's last frame as filed, moment by moment", () => {
    const joined = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 124 };
    const at = (uploads: Record<string, string>, has?: (n: string) => boolean) => h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5 }), dryContext({ slots, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", ...uploads }, media: { previous: joined }, ...(has ? { has } : {}) }));
    // handed the clip before's last frame as filed (the server does when that clip's chain was matched, see colourMatchedChain)
    const followed = node(at({ "previous.look": "look.png" }), "AfflatusColorFollow");
    expect(followed).toHaveLength(1);
    expect(followed[0]!.inputs).toMatchObject({ radius: 12, strength: 1 });
    // without the node pack's Follow Colours: one transform from its run-up's last frame (the clip before's last moment) to it
    const carried = node(at({ "previous.look": "look.png" }, (n) => n !== "AfflatusColorFollow"), "ColorTransfer");
    expect(carried).toHaveLength(1);
    expect(carried[0]!.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 21, strength: 1 });
    // not handed it: the model's own colours, as before
    expect(node(at({}), "ColorTransfer")).toHaveLength(0);
    expect(node(at({}), "AfflatusColorFollow")).toHaveLength(0);
    // a clip that opens a chain has no run-up to read: matched to its first frame only when asked
    expect(node(h3Video.build(parseInput(h3Video, { description: "a", seconds: 5 }), dryContext({ slots, uploads: { "previous.look": "look.png" } })), "ColorTransfer")).toHaveLength(0);
  });

  it("continues in the latent with the Afflatus node pack: window, the exact latent's tail guide, decoded as one piece with the clip before, its latent kept", () => {
    const joined = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 124 };
    const ctx = (has: (c: string) => boolean = () => true) => dryContext({ slots, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors [temp]" }, media: { previous: joined }, has });
    const b = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5 }), ctx());
    const win = node(b, "MiniMaxH3GuidedContinuationWindow")[0]!;
    const winId = Object.entries(b.graph).find(([, n]) => n === win)![0];
    // 22 frames of the clip before as the hidden overlap, the new frames a multiple of 17
    expect(win.inputs.overlap_frames).toBe(22);
    expect(Number(win.inputs.extension_frames) % 17).toBe(0);
    // the window counts its frames as an overlap and an extension: the clip says them itself, what the forecast reads
    expect(b.frames).toBe(Number(win.inputs.overlap_frames) + Number(win.inputs.extension_frames));
    const loaded = node(b, "AfflatusLoadH3Latent")[0]!;
    expect(loaded.inputs.latent).toBe("a.safetensors [temp]");
    const loadedId = Object.entries(b.graph).find(([, n]) => n === loaded)![0];
    // the conditioning takes the window's length, the sampler the window's latent
    expect(node(b, "MiniMaxH3ImageToVideo")[0]!.inputs.length).toEqual([winId, 1]);
    expect(node(b, "SamplerCustomAdvanced")[0]!.inputs.latent_image).toEqual([winId, 0]);
    // Auto: the exact latent's own tail guide (re-encoded frames softened a full-step chain ~35 % a clip), no frames read
    expect(node(b, "MiniMaxH3LatentTailGuide")[0]!.inputs).toMatchObject({ target_av_latent: [winId, 0], overlap_video_tokens: [winId, 2], overlap_audio_tokens: [winId, 3] });
    expect(node(b, "AfflatusH3TailGuide")).toHaveLength(0);
    expect(node(b, "LoadVideo")).toHaveLength(0);
    expect(node(b, "MiniMaxH3AddGuide")).toHaveLength(0);
    // the continuation is told what its opening frames are, before what happens in it
    const words = String(node(b, "MiniMaxH3ImageToVideo")[0]!.inputs.prompt);
    expect(words).toMatch(/carries on the previous shot without a break/);
    expect(words).toMatch(/Next: a/);
    // decoded as one piece with the clip before: its own last tokens in front of the window's new ones (the join then
    // matches the whole chain decoded at once), the window itself kept as the clip's latent
    const sampled = node(b, "SamplerCustomAdvanced")[0]!;
    const sampledId = Object.entries(b.graph).find(([, n]) => n === sampled)![0];
    const seam = node(b, "AfflatusH3SeamLatent")[0]!;
    expect(seam.inputs).toEqual({ previous_av_latent: [loadedId, 0], sampled_window: [sampledId, 0], overlap_frames: 22 });
    const seamId = Object.entries(b.graph).find(([, n]) => n === seam)![0];
    expect(node(b, "VAEDecode")[0]!.inputs.samples).toEqual([seamId, 0]);
    expect(node(b, "MiniMaxH3AppendContinuation")).toHaveLength(0);
    expect(node(b, "AfflatusNormalizeH3Latent")[0]!.inputs.samples).toEqual([sampledId, 0]);
    expect(node(b, "AfflatusSaveH3Latent")).toHaveLength(1);
    expect(b.outputs.map((o) => o.role)).toEqual(["result", "latent"]);
    expect(checkGraph(b, catalog)).toEqual([]);
    // the take will know: a seamless join (played as a plain cut)
    expect(b.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true, seam: true });
    // "Latent", saved by an older form, is Auto
    const older = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5, joinFrom: "Latent" }), ctx());
    expect(older.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true, seam: true });
    // a pack without the seam node: the window decoded on its own, a plain latent join
    const noSeam = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5 }), ctx((c) => c !== "AfflatusH3SeamLatent"));
    expect(node(noSeam, "VAEDecode")[0]!.inputs.samples).toEqual([Object.entries(noSeam.graph).find(([, n]) => n.class_type === "SamplerCustomAdvanced")![0], 0]);
    expect(noSeam.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true });
    // asked for frames: ComfyUI's own pinned frames, no window; the clip's latent is still kept for later
    const frames = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5, joinFrom: "Frames" }), ctx());
    expect(node(frames, "MiniMaxH3AddGuide")).toHaveLength(1);
    expect(node(frames, "MiniMaxH3GuidedContinuationWindow")).toHaveLength(0);
    expect(frames.overlap).toEqual({ headMs: 917, tailMs: 0 });
    expect(frames.outputs.map((o) => o.role)).toEqual(["result", "latent"]);
    // without the pack: the frames are pinned as before, and no latent is saved
    const plain = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5 }), ctx((c) => !c.startsWith("Afflatus") && !c.startsWith("MiniMaxH3Guided") && !c.startsWith("MiniMaxH3Latent")));
    expect(node(plain, "MiniMaxH3AddGuide")).toHaveLength(1);
    expect(node(plain, "MiniMaxH3GuidedContinuationWindow")).toHaveLength(0);
    expect(plain.outputs.map((o) => o.role)).toEqual(["result"]);
  });

  it("lands on the clip after in the latent too: a bridge gets the tail guide at frame zero and the head guide at the window's end", () => {
    const joined = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 124 };
    const uploads = { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", next: "b.mp4", "next.latent": "b.safetensors [temp]" };
    // the clip after plays from its first frame
    const b = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads, media: { previous: joined, next: { ...joined, latentAt: 0 } } }));
    const win = node(b, "MiniMaxH3GuidedContinuationWindow")[0]!;
    const winId = Object.entries(b.graph).find(([, n]) => n === win)![0];
    expect(node(b, "MiniMaxH3LatentTailGuide")).toHaveLength(1);
    const landing = node(b, "AfflatusH3LatentLanding")[0]!;
    expect(landing.inputs).toMatchObject({ guide_frames: 22, land_at: 0, target_av_latent: [winId, 0] });
    // further in, where one of its 17-frame chunks begins: landed on there, in the latent
    const chunk = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads, media: { previous: joined, next: { ...joined, latentAt: 34 } } }));
    expect(node(chunk, "AfflatusH3LatentLanding")[0]!.inputs).toMatchObject({ guide_frames: 22, land_at: 34 });
    expect(node(chunk, "MiniMaxH3AddGuide")).toHaveLength(0);
    // anywhere else (frame 22, its overlap with the clip it extended) by its frames: tokens sliced off a chunk's start are
    // placed off their time, and land late
    const further = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads, media: { previous: joined, next: { ...joined, latentAt: 22 } } }));
    expect(node(further, "AfflatusH3LatentLanding")).toHaveLength(0);
    expect(node(further, "MiniMaxH3AddGuide")).toHaveLength(1);
    // an older pack, without the landing: the head guide, onto the clip after's first frame only
    const older = (latentAt: number) => h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads, media: { previous: joined, next: { ...joined, latentAt } }, has: (c) => c !== "AfflatusH3LatentLanding" }));
    expect(node(older(0), "AfflatusH3LatentHeadGuide")[0]!.inputs).toMatchObject({ guide_frames: 22, skip_frames: 0 });
    expect(node(older(34), "AfflatusH3LatentHeadGuide")).toHaveLength(0);
    expect(node(b, "AfflatusLoadH3Latent").map((n) => n.inputs.latent).sort()).toEqual(["a.safetensors [temp]", "b.safetensors [temp]"]);
    expect(node(b, "MiniMaxH3AddGuide")).toHaveLength(0);
    // the window holds the overlap, the clip's own frames and the frames it lands on: the last 22 are the clip after's
    expect(Number(win.inputs.extension_frames) % 17).toBe(0);
    expect(b.overlap).toEqual({ headMs: 917, tailMs: 917, latent: true, seam: true });
    // the clip after without a latent: its frames are pinned at the end as before, the start stays in the latent
    const mixed = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", next: "b.mp4" }, media: { previous: joined, next: joined } }));
    expect(node(mixed, "MiniMaxH3LatentTailGuide")).toHaveLength(1);
    expect(node(mixed, "AfflatusH3LatentLanding")).toHaveLength(0);
    expect(node(mixed, "MiniMaxH3AddGuide")).toHaveLength(1);
    expect(node(mixed, "MiniMaxH3AddGuide")[0]!.inputs.frame_idx).toBe(-22);
    // a clip after that starts off the frame grid cannot be landed on in the latent: pixels then
    const off = h3Video.build(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, next: { asset: "c2" }, seconds: 5 }), dryContext({ slots, uploads, media: { previous: joined, next: { ...joined, latentAt: 10 } } }));
    expect(node(off, "AfflatusH3LatentLanding")).toHaveLength(0);
    expect(node(off, "MiniMaxH3AddGuide")).toHaveLength(1);
  });

  it("re-samples the draft's own latent as a finish, guided by the prompt alone (no sampling, no picture pinned at a frame)", () => {
    const b = h3Video.build(
      parseInput(h3Video, { description: "a", start: "s1", seconds: 5, short: 576, upscale: "Latent: re-sampled", upscaleBy: 1.5 }),
      dryContext({ slots, uploads: { start: "s.png", "self.latent": "own.safetensors [temp]" }, media: { start: { width: 576, height: 1024 } }, has: () => true }),
    );
    expect(node(b, "SamplerCustomAdvanced")).toHaveLength(0);
    const own = node(b, "AfflatusLoadH3Latent").find((n) => n.inputs.latent === "own.safetensors [temp]")!;
    const ownId = Object.entries(b.graph).find(([, n]) => n === own)![0];
    const upscale = node(b, "MMH3UltimateUpscale")[0]!;
    expect(upscale.inputs.latent).toEqual([ownId, 0]);
    const guide = b.graph[(upscale.inputs.conditioning as [string, number])[0]]!;
    expect(guide.class_type).toBe("MiniMaxH3ImageToVideo");
    expect(guide.inputs.first_frame).toBeUndefined();
    // no pass named (what loads ahead is its loaders), but the bar counts the re-sample's steps once for every piece:
    // 576 × 1024 made 864 × 1536, in 512-pixel tiles overlapping by 128 (2 × 4), and 124 frames in stretches of 85 overlapping by 17 (2)
    expect(b.passes).toEqual([]);
    expect(b.totalSteps).toBe(2 * 2 * 4 * 2);
    // its latent comes from a file, which says no frame count: the clip's frames are said by the recipe
    expect(b.frames).toBe(124);
    expect(checkGraph(b, catalog)).toEqual([]);
  });

  it("finishes a seamless continuation seamless: re-sampled from the clip before's own tokens, decoded as one piece with that clip's re-sampled latent", () => {
    const joined = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 124 };
    const uploads = { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", "previous.fine": "a.fine.safetensors [temp]" };
    const finish = (fine?: { width: number; height: number }) => h3Video.build(
      parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5, short: 576, upscale: "Latent: re-sampled", upscaleBy: 2 }),
      dryContext({ slots, uploads, media: { previous: { ...joined, ...(fine ? { fine } : {}) } }, has: () => true }),
    );
    const idOf = (b: ReturnType<typeof finish>, n: unknown) => Object.entries(b.graph).find(([, x]) => x === n)![0];
    // the clip before finished the same way, at this size: two seams, the second on the re-sampled latents
    const b = finish({ width: 1152, height: 2048 });
    const [small, big] = node(b, "AfflatusH3SeamLatent");
    const upscale = node(b, "MMH3UltimateUpscale")[0]!;
    expect(upscale.inputs.latent).toEqual([idOf(b, small), 0]);
    expect(big!.inputs.sampled_window).toEqual([idOf(b, upscale), 0]);
    const fineLoad = node(b, "AfflatusLoadH3Latent").find((n) => n.inputs.latent === "a.fine.safetensors [temp]")!;
    expect(big!.inputs.previous_av_latent).toEqual([idOf(b, fineLoad), 0]);
    expect(node(b, "VAEDecodeTiled")[0]!.inputs.samples).toEqual([idOf(b, big), 0]);
    expect(b.outputs.map((o) => o.role)).toEqual(["result", "raw", "latent", "fine"]);
    expect(b.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true, seam: true });
    expect(checkGraph(b, catalog)).toEqual([]);
    // the clip before not finished that way, or at another size: re-sampled all the same, not seamless (its join is faded)
    for (const other of [finish(), finish({ width: 864, height: 1536 })]) {
      expect(node(other, "AfflatusH3SeamLatent")).toHaveLength(1);
      expect(node(other, "VAEDecodeTiled")[0]!.inputs.samples).toEqual([idOf(other, node(other, "MMH3UltimateUpscale")[0]), 0]);
      expect(other.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true });
    }
  });

  it("keeps the model's own frames beside the result when a pass changes them: a raw side file for the clips that carry on", () => {
    // nothing changes the frames: the result, and the clip's latent (the node pack is there in the dry context)
    expect(build({}).outputs.map((o) => o.role)).toEqual(["result", "latent"]);
    expect(build({}, {}, (c) => c !== "AfflatusSaveH3Latent").outputs.map((o) => o.role)).toEqual(["result"]);
    // the latent route: the enlarged latent is decoded for the result, the sampled one plainly for the raw file
    const up = build({ upscale: "Latent: re-sampled", short: 576 });
    // and the re-sampled latent, for the finish of the clip after
    expect(up.outputs.map((o) => o.role)).toEqual(["result", "raw", "latent", "fine"]);
    const sampledId = Object.entries(up.graph).find(([, n]) => n.class_type === "SamplerCustomAdvanced")![0];
    expect(node(up, "VAEDecode")[0]!.inputs.samples).toEqual([sampledId, 0]);
    // frame interpolation alone: the raw file is the decode before it, at the model's own frame rate
    const smooth = build({ smooth: true }, { rife: "rife49.pth" });
    expect(smooth.outputs.map((o) => o.role)).toEqual(["result", "raw", "latent"]);
    expect(node(smooth, "VHS_VideoCombine").length + node(smooth, "SaveVideo").length).toBe(2);
    // the pinned frames of the clip before follow the setting: the server reads it to cut the clip (framesFrom)
    const prev = h3Video.inputs.find((i) => i.id === "previous") as { framesFrom?: string };
    expect(prev.framesFrom).toBe("context");
    expect((h3Video.inputs.find((i) => i.id === "context") as { options: string[]; default: string }).options).toEqual(["5", "22", "39"]);
  });

  it("enlarges the finished latent and re-samples it lightly, in tiles and stretches, with the sound carried through", () => {
    const b = build({ upscale: "Latent: re-sampled", short: 576 });
    const up = node(b, "MMH3UltimateUpscale")[0]!;
    expect(up.inputs).toMatchObject({ cfg: 1 });
    // what was sampled goes in; what comes out is what is decoded, video and sound alike
    const sampled = node(b, "SamplerCustomAdvanced")[0]!;
    const sampledId = Object.entries(b.graph).find(([, n]) => n === sampled)![0];
    expect(up.inputs.latent).toEqual([sampledId, 0]);
    const upId = Object.entries(b.graph).find(([, n]) => n === up)![0];
    expect((node(b, "VAEDecodeTiled")[0] ?? node(b, "VAEDecode")[0])!.inputs.samples).toEqual([upId, 0]);
    expect(node(b, "VAEDecodeAudio")[0]!.inputs.samples).toEqual([upId, 0]);
    // twice the frame, on the model's grid; without the upscaler's file, a plain resize
    expect(node(b, "MMH3LatentUpscaleParams")[0]!.inputs).toMatchObject({ method: "bicubic", width: 1152, height: 2048 });
    expect(node(b, "MMH3LatentUpscaleWithModelParams")).toHaveLength(0);
    expect(node(b, "MMH3SpatialSplitParams")[0]!.inputs).toMatchObject({ upscale_width: 1152, upscale_height: 2048, tile_width: 512, spatial_w_overlap: 128 });
    expect(node(b, "MMH3TemporalSplitParams")[0]!.inputs).toMatchObject({ chunk_length: 85, temporal_overlap: 17 });
    // two light steps
    const sigmas = node(b, "BasicScheduler").find((n) => n.inputs.denoise === 0.15)!;
    expect(sigmas.inputs.steps).toBe(2);
    expect(b.phases[upId]).toBe("refining");
  });

  it("uses H3's own upscaler when its file is there, and a plain resize while it is missing", () => {
    const b = build({ upscale: "Latent: re-sampled", upscaleBy: 1.5 }, { latentUpscaler: "minimax_h3_latent_upscaler_3d.safetensors" });
    expect(node(b, "MMH3LatentUpscaleWithModelParams")[0]!.inputs).toMatchObject({ model_name: "minimax_h3_latent_upscaler_3d.safetensors", width: 864, height: 1536, offload_model: true });
    expect(node(b, "MMH3LatentUpscaleParams")).toHaveLength(0);
    expect(node(build({ upscale: "Latent: re-sampled", upscaleWith: "Plain resize" }, { latentUpscaler: "x.safetensors" }), "MMH3LatentUpscaleParams")).toHaveLength(1);
    expect(node(build({ upscale: "Latent: re-sampled", upscaleWith: "H3's latent upscaler" }), "MMH3LatentUpscaleParams")).toHaveLength(1);
    // a draft saved with the old "Auto" is H3's own upscaler
    expect(parseInput(h3Video, { description: "a", upscaleWith: "Auto" }).upscaleWith).toBe("H3's latent upscaler");
    // without the node pack, the pass is refused, not quietly left out: the form announced an enlarged frame
    expect(() => build({ upscale: "Latent: re-sampled" }, {}, (c) => !c.startsWith("MMH3"))).toThrow(/Comfyui-MMH3-UltimateUpscale/);
    expect(() => build({ upscale: "Latent: re-sampled", upscaleWith: "Plain resize" }, {}, (c) => c !== "MMH3LatentUpscaleParams")).toThrow(/Comfyui-MMH3-UltimateUpscale/);
    // and the queue refuses up front: the route's nodes are among what the recipe needs, only when it is chosen
    const needs = (over: Record<string, unknown>) => h3Video.nodes(parseInput(h3Video, { description: "a", ...over }));
    expect(needs({ upscale: "Latent: re-sampled" })).toEqual(expect.arrayContaining(["MMH3UltimateUpscale", "MMH3SpatialSplitParams", "MMH3TemporalSplitParams"]));
    expect(needs({}).some((n) => n.startsWith("MMH3"))).toBe(false);
  });

  it("the frame: the short side in the shape's proportions, past 768p when asked, and a picture decides it instead", () => {
    expect(h3Canvas(576, 1024, 1088, 1088 * 1920)).toEqual({ width: 1088, height: 1920 });
    // the old cap still holds where nothing asked for more (a timeline's canvas)
    expect(h3Canvas(1080, 1920, 1080).width * h3Canvas(1080, 1920, 1080).height).toBeLessThanOrEqual(768 * 1344);
    const spec = h3Video.inputs.find((i) => i.id === "shape")!;
    expect(spec).toMatchObject({ type: "size", short: "short", maxPixels: 1088 * 1920, decidedBy: ["start", "end", "previous", "next"] });
    expect(h3Video.inputs.find((i) => i.id === "short")).toMatchObject({ max: 1088, picks: [480, 576, 768, 1088] });
  });
});

describe("the upscale routes of the video forms", () => {
  const node = (b: { graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }, cls: string) => Object.values(b.graph).filter((n) => n.class_type === cls);
  const photo = { width: 1536, height: 2048 };
  const wanOf = (over: Record<string, unknown> = {}, has: (c: string) => boolean = () => true, more: Record<string, string> = {}) =>
    wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors", rife: "rife.pth", ...more }, uploads: { start: "a.png" }, media: { start: photo }, has }));

  it("off by itself: nothing between the decode and the file", () => {
    const b = wanOf({ smooth: false });
    expect(node(b, "ImageUpscaleWithModel")).toHaveLength(0);
    expect(node(b, "DaSiWa_RTX_UpscalerRefiner")).toHaveLength(0);
    expect(wanVideo.nodes(parseInput(wanVideo, { prompt: "a", start: "p" }))).not.toContain("UpscaleModelLoader");
  });

  it("a pixel upscale model enlarges the model's own frames, before the frame interpolation, to the factor asked for", () => {
    const b = wanOf({ upscale: "Pixel: upscale model", upscaleModel: "4x-UltraSharp.pth", upscaleBy: 1.5 });
    expect(node(b, "UpscaleModelLoader")[0]!.inputs.model_name).toBe("4x-UltraSharp.pth");
    const scaled = node(b, "ImageScale")[0]!;
    // the clip is 480 x 640 (a 3:4 picture at 480p): 1.5 x, on a grid of 8
    expect([scaled.inputs.width, scaled.inputs.height]).toEqual([720, 960]);
    // the frames go through the upscale model a few at a time (half as many as after RIFE, none of them made up), are made one
    // batch again, then interpolated, and that goes to the file
    const chunks = Object.entries(b.graph).filter(([, n]) => n.class_type === "RebatchImages");
    expect(chunks).toHaveLength(2);
    expect(node(b, "ImageUpscaleWithModel")[0]!.inputs.image).toEqual([chunks[0]![0], 0]);
    const out = Object.entries(b.graph).find(([, n]) => n.class_type === "ImageScale")![0];
    expect(chunks[1]![1].inputs.images).toEqual([out, 0]);
    const interp = Object.entries(b.graph).find(([, n]) => n.class_type === "FrameInterpolate")!;
    expect(interp[1].inputs.images).toEqual([chunks[1]![0], 0]);
    expect(node(b, "VHS_VideoCombine")[0]!.inputs.images).toEqual([interp[0], 0]);
    expect(b.loads).toContain("upscale_models/4x-UltraSharp.pth");
    expect(wanVideo.nodes(parseInput(wanVideo, { prompt: "a", start: "p", upscale: "Pixel: upscale model" }))).toContain("ImageUpscaleWithModel");
  });

  it("RTX Video Super Resolution goes through the node that drives it, else the upscale model, else a plain resize", () => {
    // NVIDIA's own node first (a choice that brings its own input, sent as "resize_type.scale"), else DaSiWa's
    const b = wanOf({ upscale: "Pixel: RTX Video Super Resolution", upscaleBy: 2 });
    expect(node(b, "RTXVideoSuperResolution")[0]!.inputs).toMatchObject({ resize_type: "scale by multiplier", "resize_type.scale": 2, quality: "ULTRA" });
    const d = wanOf({ upscale: "Pixel: RTX Video Super Resolution", upscaleBy: 2 }, (c) => c !== "RTXVideoSuperResolution");
    expect(node(d, "DaSiWa_RTX_UpscalerRefiner")[0]!.inputs).toMatchObject({ upscale: "VSR", upscale_quality: "Ultra", resize_type: "Scale", scale: 2, width: 960, height: 1280 });
    expect(wanVideo.optionalNodes).toEqual(expect.arrayContaining(["RTXVideoSuperResolution", "DaSiWa_RTX_UpscalerRefiner"]));
    // neither driver (its pack not there, not wanted, or not an NVIDIA card): the form's upscale model when this ComfyUI has
    // it, else its first, else a plain resize; what was asked is told to the queue (ctx.wants), which says it on the job
    const none = (c: string) => c !== "DaSiWa_RTX_UpscalerRefiner" && c !== "RTXVideoSuperResolution";
    const rtx = { upscale: "Pixel: RTX Video Super Resolution", upscaleBy: 2, upscaleModel: "2x.pth" };
    const asked: Wanted[] = [];
    const build = (options: string[] | null) => wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...rtx }), dryContext({
      slots: { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors" }, uploads: { start: "a.png" }, media: { start: photo },
      has: none, options: () => options, wants: (w) => (asked.push(w), w.nodes.find(none) ?? null),
    }));
    expect(node(build(["4x.pth", "2x.pth"]), "UpscaleModelLoader")[0]!.inputs.model_name).toBe("2x.pth");
    expect(asked.find((w) => w.input === "upscale")).toMatchObject({ nodes: ["RTXVideoSuperResolution", "DaSiWa_RTX_UpscalerRefiner"], without: "RTX VSR", instead: "upscaled with 2x.pth instead" });
    expect(node(build(["4x.pth"]), "UpscaleModelLoader")[0]!.inputs.model_name).toBe("4x.pth");
    const plain = build(null);
    expect(node(plain, "UpscaleModelLoader")).toHaveLength(0);
    expect(node(plain, "ImageScale").some((n) => n.inputs.upscale_method === "lanczos" && n.inputs.width === 960)).toBe(true);
    expect(asked.at(-1)!.instead).toBe("a plain resize instead");
  });

  it("an upscale before the frame interpolation keeps the interpolated frames: the file at twice the rate holds twice the frames", () => {
    // SeedVR2 and an upscale model run on the model's own frames, then RIFE; taken again after it, the interpolation was lost
    // and the file, saved at twice the rate, played twice as fast
    for (const upscale of ["Video: SeedVR2 (restores)", "Pixel: upscale model"]) {
      const b = wanOf({ upscale, upscaleBy: 2, upscaleModel: "2x.pth", smooth: true }, undefined, { rife: "r.pth", seedvr: "s.safetensors", seedvrVae: "sv.safetensors" });
      const interp = Object.entries(b.graph).find(([, n]) => n.class_type === "FrameInterpolate")!;
      expect(node(b, "VHS_VideoCombine")[0]!.inputs.images).toEqual([interp[0], 0]);
    }
    // the frames restored together scale with the frame's size, and a number asked for is used (4n + 1)
    expect(seedvrChunk(1.7)).toBe(9);
    expect(seedvrChunk(0.5)).toBe(9);
    expect(seedvrChunk(3.8)).toBe(1);
    expect(seedvrChunk(2.4)).toBe(5);
    expect(seedvrChunk(6.8, 13)).toBe(13);
    expect(seedvrChunk(1.7, 7)).toBe(5);
  });

  it("SeedVR2's frames together: the arrows go 1, 5, 9 … 49 with 0 for by the frame's size, and an older 4n runs as 4n + 1 (review K-2)", () => {
    const spec = wanVideo.inputs.find((i) => i.id === "seedvrFrames") as { min: number; max: number; step: number; default: number; auto?: string };
    expect([spec.min, spec.max, spec.step, spec.default]).toEqual([1, 49, 4, 0]);
    expect(spec.auto).toBeTruthy();
    const takes = (v: number) => schemaFor([wanVideo.inputs.find((i) => i.id === "seedvrFrames")!]).safeParse({ seedvrFrames: v }).success;
    expect([0, 1, 5, 49].map(takes)).toEqual([true, true, true, true]);
    expect([-1, 50].map(takes)).toEqual([false, false]);
    // a draft saved when the arrows gave 4, 8 … 48: the lighter pass asked for, not one frame at a time
    expect([4, 8, 48].map((n) => seedvrChunk(1.7, n))).toEqual([5, 9, 49]);
  });

  it("every video form offers the routes; only H3 offers the latent one", () => {
    const routes = (r: { inputs: Array<{ id: string; type: string; options?: unknown }> }) => (r.inputs.find((i) => i.id === "upscale") as { options: string[] }).options;
    expect(routes(wanVideo)).toEqual(["Off", "Pixel: upscale model", "Pixel: RTX Video Super Resolution", "Video: SeedVR2 (restores)"]);
    expect(routes(ltxVideo)).toEqual(["Off", "Pixel: upscale model", "Pixel: RTX Video Super Resolution", "Video: SeedVR2 (restores)"]);
    expect(routes(h3Video)).toEqual(["Off", "Pixel: upscale model", "Pixel: RTX Video Super Resolution", "Video: SeedVR2 (restores)", "Latent: re-sampled"]);
    // SeedVR2: ComfyUI's own nodes, one step in temporal chunks, the frames matched in colour to the enlarged originals
    const sv = wanOf({ upscale: "Video: SeedVR2 (restores)", upscaleBy: 2 }, undefined, { seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" });
    expect(node(sv, "KSampler")[0]!.inputs).toMatchObject({ steps: 1, cfg: 1, denoise: 1 });
    expect(node(sv, "SeedVR2TemporalChunk")[0]!.inputs).toMatchObject({ chunking_mode: "manual", "chunking_mode.frames_per_chunk": 9, temporal_overlap: 0 });
    expect(node(sv, "ResizeImageMaskNode")[0]!.inputs).toMatchObject({ resize_type: "scale by multiplier", "resize_type.multiplier": 2 });
    expect(node(sv, "SeedVR2PostProcessing")[0]!.inputs.color_correction_method).toBe("lab");
    expect(sv.loads).toEqual(expect.arrayContaining(["diffusion_models/seedvr2_3b_int8_convrot.safetensors", "vae/seedvr2_ema_vae_fp16.safetensors"]));
    expect(() => wanOf({ upscale: "Video: SeedVR2 (restores)" })).toThrow(/SeedVR2 needs its two files/);
    const ltx = ltxVideo.build(parseInput(ltxVideo, { prompt: "a", upscale: "Pixel: upscale model", upscaleModel: "u.pth" }), dryContext({ slots: { checkpoint: "ltx-2.3-22b-distilled.safetensors", clip: "g.safetensors", upscaler: "up.safetensors" } }));
    expect(node(ltx, "ImageUpscaleWithModel")).toHaveLength(1);
  });
});
