import type { Family } from "@afflatus/core";
import { h3 } from "./family";

/**
 * Face refine's files for a family that is not H3's (SCAIL-2 at 24 fps, LTX 2.5): the pass is H3's, run on that model's own
 * frames, so its files are H3's own, found the same way and offered only while one of `onlyFor` is shown; H3's text encoder
 * and VAEs under ids of their own, beside the family's.
 */
export function faceRefineSlots(onlyFor: string[]): Family["slots"] {
  const of = (id: string, as?: { id: string; label: string }): Family["slots"][number] => ({ ...h3.slots.find((s) => s.id === id)!, ...(as ?? {}), optional: true, onlyFor });
  return [
    of("faceRefineUnet"),
    of("faceDetector"),
    of("faceSeg"),
    of("faceSam"),
    of("clip", { id: "faceClip", label: "MiniMax H3 text encoder (Face refine)" }),
    of("videoVae", { id: "faceVideoVae", label: "MiniMax H3 VAE, image (Face refine)" }),
    of("audioVae", { id: "faceAudioVae", label: "MiniMax H3 VAE, audio (Face refine)" }),
  ];
}
