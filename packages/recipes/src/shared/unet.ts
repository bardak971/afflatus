import type { BuildContext, GraphBuilder, Ref } from "@afflatus/core";

/** A diffusion model quantized to GGUF: another loader (the ComfyUI-GGUF pack's), the same model afterwards. */
export const isGguf = (file: string | undefined) => /\.gguf$/i.test(file ?? "");

export const GGUF_LOADER = "UnetLoaderGGUF";
export const GGUF_NEEDED = "A .gguf model needs the ComfyUI-GGUF node pack (its UnetLoaderGGUF node). Install it in ComfyUI (ComfyUI-Manager has it), or pick a .safetensors file.";

/**
 * The diffusion model loaded: ComfyUI's own loader with the precision asked for, or the GGUF loader for
 * a quantized .gguf file (a 20 GB fp8 Qwen or Flux becomes 6 to 11 GB at Q4 to Q8, which is how a card
 * with little memory runs them). Refused in words when the pack for .gguf is not installed.
 */
export function loadUnet(g: GraphBuilder, ctx: BuildContext, file: string | undefined, dtype = "default"): Ref {
  if (!isGguf(file)) return g.out("UNETLoader", { unet_name: file, weight_dtype: dtype });
  if (!ctx.has(GGUF_LOADER)) throw new Error(GGUF_NEEDED);
  return g.out(GGUF_LOADER, { unet_name: file });
}

/** The loader node a model input needs, for a recipe's node list (the family's own file is not known there: ComfyUI's loader is assumed). */
export const unetNodes = (file: string | undefined): string[] => (isGguf(file) ? [GGUF_LOADER] : ["UNETLoader"]);
