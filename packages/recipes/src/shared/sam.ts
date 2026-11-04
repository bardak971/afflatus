import type { GraphBuilder } from "@afflatus/core";

/**
 * SAM 3.1, as every recipe that finds a person or a thing with it takes it: one file in models/checkpoints, loaded by core's
 * CheckpointLoaderSimple (its MODEL out is what SAM3_VideoTrack and SAM3_Detect read). Kept here, apart from any family, so
 * that a swap's tracking, a motion transfer's and the Stage's click to mask (tools/findMask.ts) name and fetch the same file.
 */
export const SAM_FILE = "sam3.1_multiplex_fp16.safetensors";
export const SAM_GET = { file: SAM_FILE, url: "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors" };

/** A family's SAM 3 slot: its id, label, hint and where it applies are the family's; the file, its folder and its fetch are SAM's. */
export const samSlot = <S extends { id: string; label: string; hint: string }>(own: S) => ({ ...own, folder: "checkpoints", detect: ["sam3"], byName: true as const, get: SAM_GET });

/** SAM's model loaded into a graph: the node whose output 0 the SAM 3 nodes take as `model`. */
export const samModel = (g: GraphBuilder, file: string): string => g.add("CheckpointLoaderSimple", { ckpt_name: file });
