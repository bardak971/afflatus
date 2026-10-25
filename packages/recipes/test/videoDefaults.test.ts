import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { h3Video, ltx25LipSync, ltx25Video, ltxVideo, wanVideo } from "../src";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const picture = { width: 832, height: 1216 };
const wanSlots = { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors" };
const ltxSlots = { checkpoint: "ltx-2.3-22b-distilled-fp8.safetensors", clip: "gemma.safetensors", upscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" };
const h3Slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };

const wan = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: wanSlots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;
const ltx = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  ltxVideo.build(parseInput(ltxVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: ltxSlots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;
const h3 = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  h3Video.build(parseInput(h3Video, { description: "a", start: "p", ...over }), dryContext({ slots: h3Slots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;

describe("the colour match to the first frame", () => {
  it("is off by default in every video family", () => {
    expect(of(wan({}), "ColorTransfer")).toEqual([]);
    expect(of(ltx({}), "ColorTransfer")).toEqual([]);
    expect(of(h3({}), "ColorTransfer")).toEqual([]);
  });
  it("pulls the frames towards the start picture moment by moment, averaged over about a second (the node pack's Follow Colours)", () => {
    for (const graph of [wan({ colourMatch: true }), ltx({ colourMatch: true }), h3({ colourMatch: true })]) {
      const [match] = of(graph, "AfflatusColorFollow");
      expect(match?.inputs).toMatchObject({ strength: 0.75 });
      expect(match!.inputs.radius as number).toBeGreaterThanOrEqual(8);
      const ref = graph[(match!.inputs.reference as [string, number])[0]]!;
      expect(ref).toMatchObject({ class_type: "LoadImage", inputs: { image: "a.png" } });
      expect(of(graph, "ColorTransfer")).toEqual([]);
    }
  });
  it("without the node pack's Follow Colours, one transform for the whole clip", () => {
    for (const graph of [ltx({ colourMatch: true }, (t) => t !== "AfflatusColorFollow"), h3({ colourMatch: true }, (t) => t !== "AfflatusColorFollow")]) {
      const [match] = of(graph, "ColorTransfer");
      expect(match?.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "uniform", strength: 0.75 });
    }
  });
  it("does nothing without a start picture or without either node", () => {
    const words = wanVideo.build(parseInput(wanVideo, { prompt: "a", colourMatch: true }), dryContext({ slots: { ...wanSlots, t2vHigh: "th.safetensors", t2vLow: "tl.safetensors" } })).graph as Graph;
    expect(of(words, "ColorTransfer")).toEqual([]);
    expect(of(words, "AfflatusColorFollow")).toEqual([]);
    const neither = ltx({ colourMatch: true }, (t) => t !== "ColorTransfer" && t !== "AfflatusColorFollow");
    expect([...of(neither, "ColorTransfer"), ...of(neither, "AfflatusColorFollow")]).toEqual([]);
  });
});

describe("a timeline's canvas", () => {
  // the canvas's own size up to the model's 720p, as Wan's: a 1080p timeline makes 704p clips, not 1088p ones
  it("is taken at its size up to 704p on LTX", () => {
    const at = (canvas: { width: number; height: number }) => of(ltxVideo.build(parseInput(ltxVideo, { prompt: "a", start: "p" }), dryContext({ slots: ltxSlots, uploads: { start: "a.png" }, media: { start: picture }, canvas })).graph as Graph, "EmptyLTXVLatentVideo")[0]!.inputs;
    expect(at({ width: 1080, height: 1920 })).toMatchObject({ width: 352, height: 640 });
    expect(at({ width: 576, height: 1024 })).toMatchObject({ width: 288, height: 512 });
  });
});

describe("NAG on LTX", () => {
  it("is off by default, and on it patches the model every pass samples with, fed the negative", () => {
    expect(of(ltx({}), "LTX2_NAG")).toEqual([]);
    const graph = ltx({ nag: true });
    const nags = Object.entries(graph).filter(([, n]) => n.class_type === "LTX2_NAG");
    expect(nags.length).toBeGreaterThanOrEqual(1);
    expect(nags[0]![1].inputs).toMatchObject({ nag_scale: 11, nag_alpha: 0.25, nag_tau: 2.5 });
    const guided = of(graph, "CFGGuider").map((n) => (n.inputs.model as [string, number])[0]);
    for (const id of guided) expect(graph[id]!.class_type).toBe("LTX2_NAG");
  });
  it("stays out above CFG 1, without a negative, or without KJNodes", () => {
    expect(of(ltx({ nag: true, cfg: 3 }), "LTX2_NAG")).toEqual([]);
    expect(of(ltx({ nag: true, negative: "" }), "LTX2_NAG")).toEqual([]);
    expect(of(ltx({ nag: true }, (t) => t !== "LTX2_NAG"), "LTX2_NAG")).toEqual([]);
  });
});

describe("H3's re-sample defaults", () => {
  it("start light: 0.15 in 2 steps (near sigma 0.66 at shift 11)", () => {
    const parsed = parseInput(h3Video, { description: "a" }) as { upscaleDenoise: number; upscaleSteps: number };
    expect(parsed.upscaleDenoise).toBe(0.15);
    expect(parsed.upscaleSteps).toBe(2);
  });
});

describe("LTX 2.5", () => {
  // as ComfyUI's own template (2026-10-15): split files with the projection inside the Gemma 4 file, euler_ancestral in both
  // passes on LTX's schedules, the dual CFG guider at 1 and 1, 24 frames a second, the decoder's tiles 512 / 64 / 16
  const slots = { unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors", upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" };
  const b = ltx25Video.build(parseInput(ltx25Video, { prompt: "a", start: "p" }), dryContext({ slots, uploads: { start: "a.png" }, media: { start: picture } }));
  const graph = b.graph as Graph;
  it("loads its split files, the text encoder as one file", () => {
    expect(of(graph, "CLIPLoader")[0]!.inputs).toMatchObject({ clip_name: slots.clip, type: "ltxv" });
    expect(of(graph, "DualCLIPLoader")).toEqual([]);
    expect(of(graph, "CheckpointLoaderSimple")).toEqual([]);
    expect(of(graph, "UNETLoader")[0]!.inputs.unet_name).toBe(slots.unet);
    expect(of(graph, "LoraLoaderModelOnly")).toEqual([]);
  });
  it("samples both passes with euler_ancestral on LTX's schedules, through the dual CFG guider at 1 and 1", () => {
    expect(of(graph, "KSamplerSelect").map((n) => n.inputs.sampler_name)).toEqual(["euler_ancestral"]);
    expect(of(graph, "CFGGuider")).toEqual([]);
    expect(of(graph, "LTXVDualCFGGuider").map((n) => [n.inputs.video_cfg, n.inputs.audio_cfg])).toEqual([[1, 1], [1, 1]]);
    expect(of(graph, "ManualSigmas").map((n) => n.inputs.sigmas)).toEqual(["1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0", "0.85, 0.725, 0.4219, 0.0"]);
    expect(of(graph, "LTXVImgToVideoInplace").map((n) => n.inputs.strength)).toEqual([0.7, 1]);
  });
  it("runs at 24 frames a second, 5 s being 121 frames, and decodes in the template's tiles", () => {
    expect(of(graph, "LTXVConditioning")[0]!.inputs.frame_rate).toBe(24);
    expect(of(graph, "EmptyLTXVLatentVideo")[0]!.inputs.length).toBe(121);
    expect(of(graph, "LTXVEmptyLatentAudio")[0]!.inputs).toMatchObject({ frames_number: 121, frame_rate: 24 });
    expect(of(graph, "VAEDecodeTiled")[0]!.inputs).toMatchObject({ tile_size: 512, temporal_size: 64, temporal_overlap: 16 });
    expect(of(graph, "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(24);
    expect(b.loads).toEqual(expect.arrayContaining([`diffusion_models/${slots.unet}`, `text_encoders/${slots.clip}`, `vae/${slots.videoVae}`, `vae/${slots.audioVae}`]));
  });
  it("offers no NAG, and refuses without its parts", () => {
    expect(ltx25Video.inputs.some((i) => i.id === "nag")).toBe(false);
    expect(() => ltx25Video.build(parseInput(ltx25Video, { prompt: "a" }), dryContext({ slots: { unet: slots.unet, clip: slots.clip } }))).toThrow(/video VAE/);
  });
});

describe("LTX 2.5's reference pictures and voice (the MSR LoRA)", () => {
  const slots = { unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors", upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" };
  const msr = "LTX-2.5-Licon-MSR-V2.safetensors";
  const refs = (roles: string[]) => ({
    references: roles.map((role, i) => ({ asset: `r${i}`, role })),
    uploads: Object.fromEntries(roles.map((_r, i) => [`references.${i}`, `r${i}.png`])),
  });
  const build = (input: Record<string, unknown>, uploads: Record<string, string>, more: Record<string, string> = { msr }, has?: (t: string) => boolean) =>
    ltx25Video.build(parseInput(ltx25Video, { prompt: "They talk.", ...input }), dryContext({ slots: { ...slots, ...more }, uploads, ...(has ? { has } : {}) }));
  // the picture's file, through the cut to the face a person's picture goes through
  const loadOf = (graph: Graph, ref: unknown): unknown => {
    const n = graph[(ref as [string, number])[0]]!;
    return n.class_type === "AfflatusFaceFrame" || n.class_type === "AfflatusFaceCrop" ? loadOf(graph, n.inputs.image) : n.inputs.image;
  };

  it("lays the pictures in MSR's slots, a place as the background, the voice with the first, in both passes, as its authors do", () => {
    const r = refs(["person", "place", "object"]);
    const b = build({ references: r.references, voice: "v" }, { ...r.uploads, voice: "v.wav" });
    const graph = b.graph as Graph;
    const loader = of(graph, "ComfyUILTX25MSRICLoRALoader");
    expect(loader.map((n) => n.inputs)).toEqual([expect.objectContaining({ lora_name: msr, strength_model: 1 })]);
    const guides = of(graph, "ComfyUILTX25MSRMultiReferenceGuide");
    expect(guides).toHaveLength(2);
    for (const g of guides) {
      expect([loadOf(graph, g.inputs.pic1), loadOf(graph, g.inputs.pic2), loadOf(graph, g.inputs.background), g.inputs.pic3]).toEqual(["r0.png", "r2.png", "r1.png", undefined]);
      expect(g.inputs).toMatchObject({ strength: 1, reference_frames: "33" });
      expect(graph[(g.inputs.audio_ref1 as [string, number])[0]]!.class_type).toBe("LTXVAudioVAEEncode");
    }
    // one encode of the voice and one load of each picture, for both passes
    expect(of(graph, "LTXVAudioVAEEncode")).toHaveLength(1);
    expect(of(graph, "LoadImage")).toHaveLength(3);
    // each pass's references are cropped off before the clip goes on
    expect(of(graph, "LTXVCropGuides")).toHaveLength(2);
    // the pictures said by their number before the user's words
    expect(of(graph, "CLIPTextEncode")[0]!.inputs.text).toBe("Image 1: a person.\nImage 2: an object.\nImage 3: the place, the background of the scene.\n\nThey talk.");
    expect(b.loads).toContain(`loras/${msr}`);
    expect(b.warnings).toBeUndefined();
  });

  it("asks for the MSR LoRA only with pictures or a voice: a pod is sent it, a machine without it renders without", () => {
    expect(ltx25Video.needsWith!(parseInput(ltx25Video, { prompt: "a" }), {})).not.toContain("msr");
    expect(ltx25Video.needsWith!(parseInput(ltx25Video, { prompt: "a", references: [{ asset: "r", role: "person" }] }), {})).toContain("msr");
    expect(ltx25Video.needsWith!(parseInput(ltx25Video, { prompt: "a", voice: "v" }), {})).toContain("msr");
    // LTX 2.3 takes none
    expect(ltxVideo.inputs.some((i) => i.type === "references")).toBe(false);
    // Lip sync takes the pictures, not a voice: its recording is the voice
    expect(ltx25LipSync.inputs.some((i) => i.type === "references")).toBe(true);
    expect(ltx25LipSync.inputs.filter((i) => i.id.startsWith("voice"))).toEqual([]);
  });

  it("leaves them out in words without the LoRA or its pack, the clip made as before", () => {
    const r = refs(["person"]);
    const without = build({ references: r.references, voice: "v" }, { ...r.uploads, voice: "v.wav" }, {});
    expect(of(without.graph as Graph, "ComfyUILTX25MSRMultiReferenceGuide")).toEqual([]);
    expect(of(without.graph as Graph, "CLIPTextEncode")[0]!.inputs.text).toBe("They talk.");
    expect(without.warnings).toEqual(["The reference pictures and the voice sample are left out: LTX 2.5's MSR reference LoRA is not on this ComfyUI (models/loras; Settings › Models has it)."]);
    const noPack = build({ references: r.references }, r.uploads, { msr }, (t) => !t.startsWith("ComfyUILTX25MSR"));
    expect(of(noPack.graph as Graph, "ComfyUILTX25MSRICLoRALoader")).toEqual([]);
    expect(noPack.warnings).toEqual(["The reference picture is left out: this ComfyUI lacks the ComfyUI-LTX2.5-MSR node pack, which reads the MSR LoRA's slots."]);
  });

  it("says what does not fit: four pictures and one place, a voice only for a person in the first picture", () => {
    const r = refs(["object", "person", "person", "clothing", "person"]);
    const b = build({ references: r.references, voice: "v" }, { ...r.uploads, voice: "v.wav" });
    const [guide] = of(b.graph as Graph, "ComfyUILTX25MSRMultiReferenceGuide");
    expect(loadOf(b.graph as Graph, guide!.inputs.pic4)).toBe("r3.png");
    expect(guide!.inputs.audio_ref1).toBeUndefined();
    expect(b.warnings).toEqual([
      "1 reference picture left out: LTX 2.5 takes 4, and a place.",
      "The voice sample is left out: LTX 2.5 gives a voice to the person in the first picture, and the first picture is not a person.",
    ]);
    const two = refs(["person", "place", "place"]);
    const places = build({ references: two.references }, two.uploads);
    const [one] = of(places.graph as Graph, "ComfyUILTX25MSRMultiReferenceGuide");
    expect(loadOf(places.graph as Graph, one!.inputs.background)).toBe("r1.png");
    expect(places.warnings).toEqual(["1 place picture left out: LTX 2.5 takes one place, as the background."]);
    // a place alone is the first picture, not a background with nothing before it
    const place = refs(["place"]);
    const [alone] = of(build({ references: place.references }, place.uploads).graph as Graph, "ComfyUILTX25MSRMultiReferenceGuide");
    expect(loadOf(build({ references: place.references }, place.uploads).graph as Graph, alone!.inputs.pic1)).toBe("r0.png");
    expect(alone!.inputs.background).toBeUndefined();
  });

  // three fixes from the owner's Timeline 10 (2026-10-25)
  const lora = (file: string, weight: number) => ({ file, weight });
  const msrLoaders = (graph: Graph) => [...of(graph, "ComfyUILTX25MSRICLoRALoader"), ...of(graph, "LoraLoaderModelOnly").filter((n) => /msr/i.test(String(n.inputs.lora_name)))];

  it("loads the MSR LoRA once when it is in the LoRA list too, at the list's strength, and says so", () => {
    const r = refs(["person"]);
    const other = lora("ltx-2.5-some-style.safetensors", 0.7);
    const b = build({ references: r.references, loras: [lora(msr, 0.8), other] }, r.uploads);
    const graph = b.graph as Graph;
    // one load, by MSR's own loader (a plain loader drops its slots), at the list's 0.8
    expect(msrLoaders(graph).map((n) => [n.class_type, n.inputs.strength_model])).toEqual([["ComfyUILTX25MSRICLoRALoader", 0.8]]);
    // the other LoRAs of the list are still put on
    expect(of(graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual([other.file]);
    expect(b.loads!.filter((l) => l === `loras/${msr}`)).toHaveLength(1);
    expect(b.warnings).toEqual(["The MSR LoRA of the LoRA list is loaded once, by the references' own loader, at 0.8 (its strength in the list)."]);
    // known by its name under another folder or another name of it too; off in the list, the field's strength is kept
    const renamed = build({ references: r.references, loras: [lora("ltx/LTX-2.5-Licon-MSR-V1.safetensors", 0)], refLoraStrength: 0.9 }, r.uploads);
    expect(msrLoaders(renamed.graph as Graph).map((n) => [n.class_type, n.inputs.strength_model])).toEqual([["ComfyUILTX25MSRICLoRALoader", 0.9]]);
    expect(renamed.warnings).toEqual(["The MSR LoRA of the LoRA list is loaded once, by the references' own loader, at 0.9."]);
    // without pictures, the list's MSR LoRA is the user's own plain LoRA, as before
    const plain = build({ loras: [lora(msr, 0.8)] }, {});
    expect(msrLoaders(plain.graph as Graph).map((n) => n.class_type)).toEqual(["LoraLoaderModelOnly"]);
    expect(plain.warnings).toBeUndefined();
  });

  it("says under Reference images that a picture the clip opens on wins over the reference for the face", () => {
    for (const recipe of [ltx25Video, ltx25LipSync]) {
      expect(recipe.inputs.find((i) => i.id === "references")!.note).toContain("A clip that opens on a picture (a start frame, or carried on from the clip before) takes the face from that frame rather than from the reference.");
    }
  });

  it("cuts a person's picture to the face before MSR's guide, only a person's, and says when it cannot", () => {
    const r = refs(["person", "object", "place"]);
    const b = build({ references: r.references }, r.uploads);
    const graph = b.graph as Graph;
    const crops = of(graph, "AfflatusFaceFrame");
    // one cut of the person's one load, shared by both passes
    expect(crops).toHaveLength(1);
    expect(loadOf(graph, crops[0]!.inputs.image)).toBe("r0.png");
    for (const g of of(graph, "ComfyUILTX25MSRMultiReferenceGuide")) {
      expect(graph[(g.inputs.pic1 as [string, number])[0]]!.class_type).toBe("AfflatusFaceFrame");
      expect(graph[(g.inputs.pic2 as [string, number])[0]]!.class_type).toBe("LoadImage");
      expect(graph[(g.inputs.background as [string, number])[0]]!.class_type).toBe("LoadImage");
    }
    expect(b.warnings).toBeUndefined();
    expect(ltx25Video.inputs.find((i) => i.id === "refFaceCrop")).toMatchObject({ type: "toggle", default: true, showWhen: "references", advanced: true });
    const cuts = (graph: Graph) => [...of(graph, "AfflatusFaceFrame"), ...of(graph, "AfflatusFaceCrop")];
    // off: the pictures whole
    expect(cuts(build({ references: r.references, refFaceCrop: false }, r.uploads).graph as Graph)).toEqual([]);
    // no person: nothing to cut, nothing said
    const things = refs(["object"]);
    const none = build({ references: things.references }, things.uploads);
    expect(cuts(none.graph as Graph)).toEqual([]);
    expect(none.warnings).toBeUndefined();
    // an older node pack, or no insightface: whole, and said
    const old = build({ references: r.references }, r.uploads, { msr }, (t) => t !== "AfflatusFaceCrop" && t !== "AfflatusFaceFrame");
    expect(cuts(old.graph as Graph)).toEqual([]);
    expect(old.warnings).toEqual(["The people's pictures go in whole, not cut to the face: this ComfyUI lacks Afflatus's Face Crop (node pack 0.38, with insightface)."]);
  });

  // card #91: MSR's guide fits a picture of another shape family than its slot whole on a white canvas; Face Crop's square in
  // Timeline 10's 1280 x 704 clip went between white bars, which takes cut from the clip before copied into their frames
  it("cuts a person's picture to the clip's frame shape and size, so that MSR fills its slot with it rather than padding it white", () => {
    const r = refs(["person"]);
    const wide = { shape: { width: 1280, height: 704 }, short: 704 };
    const graph = build({ references: r.references, ...wide }, r.uploads).graph as Graph;
    const latent = of(graph, "EmptyLTXVLatentVideo")[0]!.inputs;
    // the first pass at half the clip's size: the cut is at the clip's full frame, which MSR brings down to each pass's slot
    expect([latent.width, latent.height]).toEqual([640, 352]);
    expect(of(graph, "AfflatusFaceFrame").map((n) => [n.inputs.width, n.inputs.height])).toEqual([[1280, 704]]);
    expect(of(graph, "AfflatusFaceCrop")).toEqual([]);
    // a portrait clip: cut to its shape
    const tall = build({ references: r.references, shape: { width: 704, height: 1280 }, short: 704 }, r.uploads).graph as Graph;
    expect(of(tall, "AfflatusFaceFrame").map((n) => [n.inputs.width, n.inputs.height])).toEqual([[704, 1280]]);
    // a node pack of before 0.39: the square cut, and the bars said in a clip that is not square
    const before = (t: string) => t !== "AfflatusFaceFrame";
    const square = build({ references: r.references, ...wide }, r.uploads, { msr }, before);
    expect(of(square.graph as Graph, "AfflatusFaceCrop")).toHaveLength(1);
    expect(square.warnings).toEqual([
      "The people's pictures are cut to a square around the face, which MSR lays between white bars in this clip's frame (node pack 0.39 cuts them to the frame's shape): a clip that does not carry on from the one before can copy the bars.",
    ]);
    expect(build({ references: r.references, shape: { width: 704, height: 704 }, short: 704 }, r.uploads, { msr }, before).warnings).toBeUndefined();
    // the "?" says it
    expect(ltx25Video.inputs.find((i) => i.id === "refFaceCrop")!.note).toContain("to the clip's frame shape");
  });
});
