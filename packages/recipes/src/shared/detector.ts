import type { ChoiceInput } from "@afflatus/core";
import { FACE_DETECTOR_PREFER } from "../sdxl/common";

/**
 * Bingsu's adetailer files at the commit their hashes were read from (2026-11-03), not at `main`: Ultralytics loads a .pt
 * as a pickle (code), and a branch moves at its owner's word (or a stolen account's). The hashes are checked before a file
 * is named, on this computer and on a pod.
 */
export const ADETAILER = "https://huggingface.co/Bingsu/adetailer/resolve/53cc19de382014514d9d4038601d261a7faa9b7b";

/** The face detector, a slot of its own for the families that find faces with it (H3's Face refine too). */
export const FACE_DETECTOR_SLOT = {
  id: "faceDetector", label: "Face detector (Face refine)", folder: "ultralytics", detect: ["face_yolov8m", "face_yolo"], optional: true,
  hint: "Optional, 52 MB: the YOLOv8 face detector Face refine finds faces with, in ComfyUI's models/ultralytics/bbox folder (needs the Impact Subpack).",
  get: { file: "bbox/face_yolov8m.pt", url: `${ADETAILER}/face_yolov8m.pt`, sha256: "717923c19b3f4bbf5250b728f1fa6b2cb72a33aed1d236ea9caf0e21ad943e5f" },
};

/**
 * The detectors the face detailer can use, as downloads in Settings → Models: Bingsu's adetailer YOLOv8 models (the ones
 * A1111's ADetailer fetches), saved under models/ultralytics/bbox, where Impact's UltralyticsDetectorProvider lists them as
 * "bbox/…". No eyes detector is offered: none on Hugging Face is in wide enough use to trust.
 */
export const DETECTOR_SLOTS = [
  FACE_DETECTOR_SLOT,
  {
    id: "handDetector", label: "Hand detector (Hand refine)", folder: "ultralytics", detect: ["hand_yolo"], optional: true,
    hint: "Optional, 23 MB: a YOLOv8 hand detector, in ComfyUI's models/ultralytics/bbox folder. Hand refine finds hands with it (Face refine with this detection model).",
    get: { file: "bbox/hand_yolov8s.pt", url: `${ADETAILER}/hand_yolov8s.pt`, sha256: "70b540063fbc385736d8258970744a4afbc4cbf7932134bae3b24cdadeadec06" },
  },
];

/** What a detection model is known as a hand detector by: its file name. */
export const HAND_DETECTOR = "hand";

/**
 * Where the face detailer starts when it is given hands: a lighter denoise (0.4 redraws fingers into new ones), a
 * tighter crop (three hand sizes take in the arm and the body) and words about hands, as the owner's test found.
 */
export const HAND_VALUES = { strength: 0.35, faceCrop: 2, prompt: "natural hands, five fingers, detailed skin" };

/** The face detailer's detection model: a face detector by default (FACE_DETECTOR_PREFER), any other the user has in models/ultralytics. */
export const DETECTOR_INPUT: ChoiceInput = {
  id: "detector", type: "choice", label: "Detection model", options: { node: "UltralyticsDetectorProvider", input: "model_name" }, default: "bbox/face_yolov8m.pt", prefer: FACE_DETECTOR_PREFER, advanced: true,
  note: "from ComfyUI's models/ultralytics folder. Picking a hand detector (hand_yolov8s, a download in Settings → Models) fixes hands instead of faces, and starts the denoise, the crop factor and the prompt on hand values; any other bbox or segm detector there (eyes, person) works the same way",
  whenChosen: [{ match: HAND_DETECTOR, values: HAND_VALUES }],
};
