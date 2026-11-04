import { defineRecipe, GraphBuilder, TOOLS_FAMILY } from "@afflatus/core";
import { DETECTOR_FILES } from "../shared/adetail";
import { SAM_FILE, samModel } from "../shared/sam";

/**
 * Find a mask on a picture, for the Stage's drawing layer (card #274): not a form of its own (hidden), a short job the
 * page sends through POST /api/assets/:id/find-mask (apps/server findMask.ts), whose masks come back as working pictures
 * (scratch) for the layer to add to what is painted.
 *  - Click (`way: "points"`): SAM 3.1's SAM3_Detect, prompted by the points clicked on the thing (`add`) and off it (`remove`),
 *    in the picture's own pixels; one mask, the union of what it found.
 *  - Find (`way: "detect"`): the Impact Pack's detector for a face, hands or a person (the files Face and Hand refine use),
 *    one mask per thing found (ImpactSEGSToMaskList).
 * Both end in white on black pictures, the mask at the picture's size, as a painted mask is.
 */

export const FIND_MASK = "tools.find-mask";

/** What a Find looks for, and with which of the family's detectors: a person by its outline (a segmentation model), the rest by box. */
const DETECT = {
  face: { slot: "faceDetector", segm: false },
  hands: { slot: "handDetector", segm: false },
  person: { slot: "personDetector", segm: true },
} as const;
type What = keyof typeof DETECT;

export interface FindMask {
  source: string;
  way: "points" | "detect";
  /** The points clicked, as "x,y x,y" in the picture's pixels (pointsText). */
  add: string;
  remove: string;
  what: What;
  threshold: number;
}

/** Points as the recipe takes them: "x,y" pairs, apart by spaces, in whole pixels (a text, as no other input holds a list of points). */
export const pointsText = (points: ReadonlyArray<{ x: number; y: number }>) => points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ");
/** The points of such a text, as SAM3_Detect's coords read them (JSON, pixels); what does not read as a pair is left out. */
const coords = (text: string) =>
  JSON.stringify(text.trim().split(/\s+/).flatMap((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x: Math.round(x!), y: Math.round(y!) }] : [];
  }));

const DETECT_THRESHOLD = 0.5;
const SAM_THRESHOLD = 0.5;

export const findMask = defineRecipe<FindMask>({
  id: FIND_MASK,
  family: TOOLS_FAMILY,
  version: 1,
  // the Stage's tools send it; no form, no Create entry, no Ctrl+K row
  hidden: true,
  title: "Find a mask",
  summary: "Finds a mask on a picture: SAM 3 from points clicked on it, or a face, hands or a person found by a detector. The Stage's click and find tools.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image", note: "the picture the mask is found on" },
    { id: "way", type: "choice", label: "Way", options: ["points", "detect"], default: "points", internal: true },
    { id: "add", type: "prompt", label: "Points on it", style: "sentences", line: true, optional: true, noCast: true, default: "", internal: true },
    { id: "remove", type: "prompt", label: "Points off it", style: "sentences", line: true, optional: true, noCast: true, default: "", internal: true },
    { id: "what", type: "choice", label: "What", options: Object.keys(DETECT), default: "face", internal: true },
    { id: "threshold", type: "number", label: "Threshold", min: 0.05, max: 0.95, step: 0.05, default: DETECT_THRESHOLD, internal: true },
  ],
  // the file the way taken reads: a machine without it does not take the job, a pod is sent it
  needsWith: (input) => [input.way === "detect" ? DETECT[input.what].slot : "sam"],
  // what it makes is a working picture, never an item of the library (queueStore.ts)
  scratch: () => true,
  // the Stage waits for it with the brush in hand, a find per click: no "done" banner nor notification for each
  quiet: true,
  nodes: (input) =>
    input.way === "detect"
      ? ["LoadImage", "UltralyticsDetectorProvider", DETECT[input.what].segm ? "SegmDetectorSEGS" : "BboxDetectorSEGS", "ImpactSEGSToMaskList", "MaskToImage", "PreviewImage"]
      : ["LoadImage", "CheckpointLoaderSimple", "SAM3_Detect", "MaskToImage", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const image = g.out("LoadImage", { image: ctx.uploads.source });
    let mask: [string, number];
    let loads: string[];
    if (input.way === "detect") {
      const kind = DETECT[input.what];
      const file = ctx.slots[kind.slot];
      if (!file) throw new Error(`Finding ${input.what === "hands" ? "hands" : `a ${input.what}`} needs its detector (${DETECTOR_FILES[kind.slot]} in models/ultralytics; Settings › Models has it).`);
      const detector = g.add("UltralyticsDetectorProvider", { model_name: file });
      const crop = { threshold: input.threshold, dilation: 0, crop_factor: 1, drop_size: 10, labels: "all" };
      const segs = kind.segm
        ? g.out("SegmDetectorSEGS", { segm_detector: [detector, 1], image, ...crop })
        : g.out("BboxDetectorSEGS", { bbox_detector: [detector, 0], image, ...crop });
      // one mask per thing found, each at the picture's size: the layer adds the one picked
      mask = g.out("ImpactSEGSToMaskList", { segs });
      loads = [`ultralytics/${file}`];
    } else {
      const file = ctx.slots.sam;
      if (!file) throw new Error(`Click to mask needs SAM 3.1 (${SAM_FILE} in models/checkpoints; Settings › Models has it).`);
      const model = samModel(g, file);
      const off = coords(input.remove);
      mask = g.out("SAM3_Detect", {
        model: [model, 0], image, threshold: SAM_THRESHOLD, refine_iterations: 2, individual_masks: false,
        positive_coords: coords(input.add), ...(off !== "[]" ? { negative_coords: off } : {}),
      });
      loads = [`checkpoints/${file}`];
    }
    const shown = g.out("MaskToImage", { mask });
    const out = g.add("PreviewImage", { images: shown });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads, light: true, warnings: [], passes: [] };
  },
  variants: [
    { name: "click: two points on, one off", input: { source: "p", way: "points", add: "320,240 360,300", remove: "40,40" }, slots: { sam: SAM_FILE }, uploads: { source: "s.png" } },
    { name: "find a face", input: { source: "p", way: "detect", what: "face" }, slots: DETECTOR_FILES, uploads: { source: "s.png" } },
    { name: "find hands", input: { source: "p", way: "detect", what: "hands" }, slots: DETECTOR_FILES, uploads: { source: "s.png" } },
    { name: "find a person (by its outline)", input: { source: "p", way: "detect", what: "person" }, slots: DETECTOR_FILES, uploads: { source: "s.png" } },
  ],
});
