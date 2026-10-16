import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import { FACE_INPUTS, type FaceSettings } from "../sdxl/common";
import { A_FACE, photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";
import { DETECTOR_INPUT } from "../shared/detector";

export interface FlowFixFace extends FlowBase, FaceSettings { source: string; prompt: string; detector: string; strength: number }

/** The face detailer: the Impact Pack's FaceDetailer with this model, every face found, redrawn larger, and put back with a soft edge. */
export function flowFixFace(spec: FlowSpec, kit: FlowKit): Recipe<FlowFixFace> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, tuned } = kit;
  const files = spec.files;
  return defineRecipe<FlowFixFace>({
    id: `${spec.family}.fix-face`,
    family: spec.family,
    version: 1,
    title: "Face detailer",
    summary: "Like ADetailer: detects every face and inpaints it with more detail. Needs the Impact Pack nodes in ComfyUI.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image", note: "the picture it works on" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the face and who it is: eye colour, hair, expression", style: "sentences", optional: true, default: "" },
      { id: "strength", type: "number", label: "Denoising strength", note: "0.3 cleans the face, 0.6 can make another one", min: 0.1, max: 0.8, step: 0.05, default: 0.4 },
      DETECTOR_INPUT,
      ...FACE_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...loadNodes(input).filter((n) => !["KSampler", "VAEDecode"].includes(n)), "LoadImage", "UltralyticsDetectorProvider", "FaceDetailer"],
    ...(SOMETIMES.length ? { optionalNodes: SOMETIMES } : {}),
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const c = cond(g, k, input, input.prompt.trim() || A_FACE);
      const detector = g.out("UltralyticsDetectorProvider", { model_name: input.detector });
      g.phase("detailing");
      const fixed = g.add("FaceDetailer", {
        image: source, model: shifted(g, k.model, input, { width: 1024, height: 1024 }), clip: k.clip, vae: k.vae, positive: c.positive, negative: c.negative, bbox_detector: detector,
        guide_size: input.faceSize, guide_size_for: false, max_size: Math.max(input.faceMax, input.faceSize), seed: ctx.seed, steps: k.steps, cfg: k.cfg,
        sampler_name: input.sampler, scheduler: input.scheduler, denoise: input.strength, feather: input.faceFeather, noise_mask: true, force_inpaint: true,
        bbox_threshold: input.faceThreshold, bbox_dilation: input.faceGrow, bbox_crop_factor: input.faceCrop, sam_detection_hint: "center-1", sam_dilation: 0,
        sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: "False",
        drop_size: 10, wildcard: "", cycle: 1,
      });
      const out = g.add("PreviewImage", { images: [fixed, 0] });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: k.steps, passes: [{ node: fixed, steps: k.steps }], loads: k.loads };
    },
    variants: [
      { name: "plain", input: { source: "p", detector: "bbox/face.pt" } as Partial<FlowFixFace>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "with words, a fine-tune and a LoRA", input: { source: "p", prompt: "green eyes", detector: "bbox/face.pt", ...tuned } as Partial<FlowFixFace>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      // Turbo's branch: the LoRA put on, its steps at CFG 1 (the operations' other variants have no turbo file)
      ...(kit.turboFiles ? [{ name: "Turbo with its LoRA", input: { source: "p", detector: "bbox/face.pt", fast: true, turboSteps: 6 } as Partial<FlowFixFace>, slots: kit.turboFiles, uploads: { source: "s.png" }, media: { source: photo } }] : []),
    ],
  });
}
