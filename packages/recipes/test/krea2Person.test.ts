import { describe, expect, it } from "vitest";
import { dryContext, isBeyondPack, isShown, parseInput, type BuildContext, type InputSpec } from "@afflatus/core";
import { krea2Picture } from "../src/krea2/recipes";
import { krea2 } from "../src/krea2/family";
import { SMALL_FACE_PX } from "../src/klein/facePass";

/**
 * Krea 2's person reference (card #219): the graph the pod test measured (card #217), Identity Edit V2 on Turbo with the
 * comfyui-krea2edit 2.0 patch, the person beside the canvas; and Face refine, Klein redrawing the largest face from the
 * person's picture when it is a small one.
 */

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;

const base = { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" };
const withPerson = { ...base, identityEdit: "krea2_identity_edit_v2_r128.safetensors" };
const faceFiles = { kleinUnet: "flux-2-klein-base-4b.safetensors", kleinClip: "qwen_3_4b.safetensors", kleinVae: "flux2-vae.safetensors", faceDetector: "bbox/face_yolov8m.pt" };
const person = [{ asset: "p", role: "person" }];
const uploads = { "person.0": "nicolas.png" };

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  const built = krea2Picture.build(parseInput(krea2Picture, { prompt: "Photo of the man from the photo hiking.", ...values }), dryContext({ seed: 7, slots: { ...withPerson, ...faceFiles }, uploads, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("Krea 2 · person reference", () => {
  it("is the form's first reference input, a person's picture: a cast person's first picture goes there", () => {
    const first = krea2Picture.inputs.find((i) => i.type === "references");
    expect(first).toMatchObject({ id: "person", max: 1, roles: ["person"] });
  });

  it("is the pod test's graph: Identity Edit V2 on Turbo, the patch with the person beside, the prompt read with the picture at 1024", () => {
    const { built, graph } = build({ person });
    const [sampler] = of(graph, "KSampler");
    expect(sampler!.inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 });
    const patch = node(graph, sampler!.inputs.model);
    expect(patch.class_type).toBe("Krea2EditModelPatch");
    expect(patch.inputs).toMatchObject({ ref_boost: 2, ref_boost_a: 1, fit_mode: "fit", ref_position: "beside (right of target)", ref_position_a: "aligned (trained)" });
    // the person's picture in pixels, the canvas's own latent to encode it before sampling
    expect(node(graph, patch.inputs.source_image).inputs.image).toBe("nicolas.png");
    expect(patch.inputs.target_latent).toEqual(sampler!.inputs.latent_image);
    const lora = node(graph, patch.inputs.model);
    expect(lora).toMatchObject({ class_type: "LoraLoaderModelOnly", inputs: { lora_name: "krea2_identity_edit_v2_r128.safetensors", strength_model: 1 } });
    expect(node(graph, lora.inputs.model).class_type).toBe("UNETLoader");
    const read = node(graph, sampler!.inputs.positive);
    expect(read).toMatchObject({ class_type: "Krea2EditGroundedEncode", inputs: { prompt: "Photo of the man from the photo hiking.", grounding_px: 1024, system_prompt: "" } });
    expect(node(graph, read.inputs.image).inputs.image).toBe("nicolas.png");
    expect(of(graph, "TextEncodeQwenImageEditPlus")).toHaveLength(0);
    expect(built.loads).toContain("loras/krea2_identity_edit_v2_r128.safetensors");
  });

  it("puts its LoRA on as its row of the LoRA list says: another file, another weight", () => {
    const { graph } = build({ person, identityLora: "my_identity_v2.safetensors", identityStrength: 0.8, refBoost: 3 });
    expect(of(graph, "LoraLoaderModelOnly").map((n) => n.inputs)).toEqual([expect.objectContaining({ lora_name: "my_identity_v2.safetensors", strength_model: 0.8 })]);
    expect(of(graph, "Krea2EditModelPatch")[0]!.inputs.ref_boost).toBe(3);
  });

  it("is refused with style reference images, which it was not made to work with", () => {
    expect(() => build({ person, references: [{ asset: "s", role: "style" }] }, { slots: { ...withPerson, styleRef: "krea2_style_reference.safetensors" }, uploads: { ...uploads, "references.0": "s.png" } })).toThrow(/person reference or style reference images, not both/);
  });

  it("says what is missing: its LoRA, or a comfyui-krea2edit older than 2.0 (an update, not an install)", () => {
    expect(() => build({ person }, { slots: base })).toThrow(/Identity Edit V2 LoRA/);
    let thrown: unknown;
    try {
      build({ person }, { inputs: (n) => (n === "Krea2EditModelPatch" ? ["model", "source_latent", "ref_boost", "vae", "source_image", "target_latent"] : null) });
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toMatch(/older than 2\.0/);
    // the commit to check out, never its repository's head (the 2026-11-02 review, M6)
    expect(String(thrown)).toMatch(/checkout [0-9a-f]{40}/);
    expect(String(thrown)).not.toMatch(/nightly|latest/);
    expect(isBeyondPack(thrown)).toBe(true);
    // 2.0's inputs: built
    expect(() => build({ person }, { inputs: (n) => (n === "Krea2EditModelPatch" ? ["model", "source_latent", "ref_position", "ref_position_a"] : null) })).not.toThrow();
  });

  it("asks for the pack's two nodes, the LoRA's slot, and Face refine's files where they are to be sent", () => {
    const input = parseInput(krea2Picture, { prompt: "a", person });
    expect(krea2Picture.nodes(input)).toEqual(expect.arrayContaining(["Krea2EditModelPatch", "Krea2EditGroundedEncode", "LoraLoaderModelOnly"]));
    expect(krea2Picture.needsWith!(input)).toEqual(["identityEdit", "kleinUnet", "kleinClip", "kleinVae", "faceDetector"]);
    // a machine of the user's own makes it without the pass rather than wait for Klein
    expect(krea2Picture.needsWith!(input, { faceDetector: "bbox/face_yolov8m.pt" }, { own: true })).toEqual(["identityEdit", "faceDetector"]);
    expect(krea2Picture.needsWith!({ ...input, identityLora: "mine.safetensors", faceRefine: false })).toEqual([]);
    expect(krea2Picture.needsWith!(parseInput(krea2Picture, { prompt: "a" }))).toEqual([]);
  });

  it("redraws hires fix tiles from the prompt alone, the whole picture's second pass with the person", () => {
    const tiled = build({ person, faceRefine: false, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" }).graph;
    const samplers = of(tiled, "KSampler");
    expect(samplers).toHaveLength(2);
    expect(node(tiled, samplers[0]!.inputs.model).class_type).toBe("Krea2EditModelPatch");
    for (const s of samplers.slice(1)) {
      expect(node(tiled, s.inputs.model).class_type).not.toBe("Krea2EditModelPatch");
      expect(node(tiled, s.inputs.positive).class_type).toBe("CLIPTextEncode");
    }
    const whole = build({ person, faceRefine: false, hires: true, hiresUpscaler: "u.pth" }).graph;
    for (const s of of(whole, "KSampler")) expect(node(whole, s.inputs.model).class_type).toBe("Krea2EditModelPatch");
  });

  it("is offered with its LoRA, Klein's files and the face detector in Settings › Models, for txt2img alone", () => {
    for (const id of ["identityEdit", "kleinUnet", "kleinClip", "kleinVae", "faceDetector"]) {
      expect(krea2.slots.find((s) => s.id === id), id).toMatchObject({ optional: true, onlyFor: ["krea2.text-to-picture"] });
    }
    const slot = krea2.slots.find((s) => s.id === "identityEdit")!;
    expect(slot.get).toEqual({ file: "krea2_identity_edit_v2_r128.safetensors", url: "https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v2_r128.safetensors" });
    const finds = (s: (typeof krea2.slots)[number], file: string) => s.detect.some((d) => new RegExp(d, "i").test(file));
    expect(finds(slot, "krea2_identity_edit_v2_r128.safetensors")).toBe(true);
    // V1.2 is set up otherwise, the General Edit is another task
    expect(finds(slot, "krea2_identity_edit_v1_2_r128.safetensors")).toBe(false);
    expect(finds(slot, "krea2_general_edit_v2_r128.safetensors")).toBe(false);
    // the 4B's encoder is the one offered: a 9B Klein is not taken for Face refine
    const klein = krea2.slots.find((s) => s.id === "kleinUnet")!;
    expect(finds(klein, "flux-2-klein-base-4b.safetensors")).toBe(true);
    expect(finds(klein, "flux-2-klein-base-9b.safetensors")).toBe(false);
  });
});

describe("Krea 2 · Face refine", () => {
  const shown = (values: Record<string, unknown>) => isShown(krea2Picture.inputs.find((i) => i.id === "faceRefine") as InputSpec, values, krea2Picture.inputs);

  it("is on by default, shown with a person reference only, and does nothing without one", () => {
    expect(krea2Picture.inputs.find((i) => i.id === "faceRefine")).toMatchObject({ type: "toggle", default: true, showWhen: "person" });
    expect(shown({ person })).toBe(true);
    expect(shown({ person: [] })).toBe(false);
    const { graph } = build({});
    expect(of(graph, "DetailerForEach")).toHaveLength(0);
    expect(of(graph, "Krea2EditModelPatch")).toHaveLength(0);
  });

  it("redraws the largest face with Klein from the person's picture at 0.35, when it is under 150 px tall", () => {
    const { built, graph } = build({ person });
    const [detailer] = of(graph, "DetailerForEach");
    expect(detailer).toBeDefined();
    expect(detailer!.inputs).toMatchObject({ steps: 20, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 0.35, guide_size: 1024, guide_size_for: false, noise_mask: true });
    // after the picture is decoded, before it is shown
    expect(node(graph, detailer!.inputs.image).class_type).toBe("VAEDecode");
    expect(node(graph, of(graph, "PreviewImage")[0]!.inputs.images)).toBe(detailer);
    // the largest face only, then a small one only: Impact reads the crop, the face's height times the crop factor
    const small = node(graph, detailer!.inputs.segs);
    expect(small).toMatchObject({ class_type: "ImpactSEGSRangeFilter", inputs: { target: "height", mode: true, min_value: 0, max_value: SMALL_FACE_PX * 2.5 } });
    expect(node(graph, small.inputs.segs)).toMatchObject({ class_type: "ImpactSEGSOrderedFilter", inputs: { target: "area(=w*h)", order: true, take_count: 1 } });
    expect(node(graph, node(graph, small.inputs.segs).inputs.segs).inputs).toMatchObject({ crop_factor: 2.5 });
    // Klein's own model, reading the person's picture beside the words of the face
    expect(node(graph, detailer!.inputs.model)).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-base-4b.safetensors" } });
    const positive = node(graph, detailer!.inputs.positive);
    expect(positive.class_type).toBe("ReferenceLatent");
    expect(node(graph, node(graph, node(graph, positive.inputs.latent).inputs.pixels).inputs.image).inputs.image).toBe("nicolas.png");
    // a face too large, or none, and the pass samples nothing: its steps are not shown until it does, and its job says so
    expect(built.passes!.at(-1)).toEqual({ node: expect.any(String), steps: 20, unsampled: expect.stringContaining(`Face refine left the face as drawn: it redraws a face under ${SMALL_FACE_PX} px tall`) });
    expect(built.loads).toEqual(expect.arrayContaining(["diffusion_models/flux-2-klein-base-4b.safetensors", "ultralytics/bbox/face_yolov8m.pt"]));
  });

  it("reads the face's size at the size the picture was drawn: larger after a hires fix", () => {
    const { graph } = build({ person, hires: true, hiresScale: 1.5, hiresUpscaler: "u.pth" });
    expect(of(graph, "ImpactSEGSRangeFilter")[0]!.inputs.max_value).toBe(Math.round(SMALL_FACE_PX * 1.5 * 2.5));
  });

  it("runs a distilled Klein at its 4 steps and CFG 1", () => {
    const { graph } = build({ person }, { slots: { ...withPerson, ...faceFiles, kleinUnet: "flux-2-klein-4b.safetensors" } });
    expect(of(graph, "DetailerForEach")[0]!.inputs).toMatchObject({ steps: 4, cfg: 1 });
  });

  it("is left out, and the job says why, without Klein or the detector here; and without the Impact Pack", () => {
    const noKlein = build({ person }, { slots: { ...withPerson, faceDetector: "bbox/face_yolov8m.pt" } });
    expect(of(noKlein.graph, "DetailerForEach")).toHaveLength(0);
    expect(noKlein.built.warnings).toEqual([expect.stringMatching(/^Not face-refined: FLUX\.2 Klein 4B/)]);
    const noDetector = build({ person }, { slots: { ...withPerson, ...faceFiles, faceDetector: "" } });
    expect(noDetector.built.warnings).toEqual([expect.stringMatching(/no face detector/)]);
    const noImpact = build({ person }, { has: (n) => n !== "DetailerForEach" });
    expect(of(noImpact.graph, "DetailerForEach")).toHaveLength(0);
    expect(of(noImpact.graph, "UNETLoader")).toHaveLength(1);
    // turned off: no pass, nothing said
    const off = build({ person, faceRefine: false });
    expect(of(off.graph, "DetailerForEach")).toHaveLength(0);
    expect(off.built.warnings).toBeUndefined();
  });
});
