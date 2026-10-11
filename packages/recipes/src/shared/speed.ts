import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

/**
 * Faster sampling, same pixels (near enough): SageAttention, a quicker attention kernel, through KJNodes'
 * patch; and, for those who want it, torch.compile. Both need something ComfyUI's Python has to have (the
 * sageattention package; Triton for the compile), which a node list cannot tell: they are off until asked,
 * and how much they save is what the render times then show.
 */
export interface SpeedSettings {
  sage: boolean;
  sageKernel: string;
  compile: boolean;
}

export const SAGE_NODE = "PathchSageAttentionKJ";
const COMPILE_NODE = "TorchCompileModel";
export const SAGE_NEEDED = `SageAttention needs KJNodes (its ${SAGE_NODE} node) and the sageattention package in ComfyUI's Python. Install them, or turn "Faster attention" off.`;

export const SPEED_INPUTS: InputSpec[] = [
  {
    id: "sage", type: "toggle", label: "SageAttention", default: false, perModel: true, section: "speed",
    note: "a quicker attention kernel: same picture, less time, often much less on video. Needs the sageattention package in ComfyUI's Python",
  },
  {
    id: "sageKernel", type: "choice", label: "SageAttention kernel", options: { node: SAGE_NODE, input: "sage_attention" }, default: "auto", showWhen: "sage", advanced: true, perModel: true,
    note: "auto picks the one for your card; the fp8 kernels are for cards that do fp8 (RTX 40 and later), sageattn3 for RTX 50",
  },
  {
    id: "compile", type: "toggle", label: "torch.compile", default: false, advanced: true, perModel: true, section: "speed",
    note: "compiles the model for this card: the first render is slower, the next ones faster. Needs Triton in ComfyUI's Python; leave off if renders start failing",
  },
];

/** The nodes these settings bring in. */
export const speedNodes = (input: SpeedSettings) => [...(input.sage ? [SAGE_NODE] : []), ...(input.compile ? [COMPILE_NODE] : [])];

/** The model with the speed-ups asked for. */
export function faster(g: GraphBuilder, model: Ref, input: SpeedSettings, ctx: BuildContext): Ref {
  if (input.sage) {
    if (!ctx.has(SAGE_NODE)) throw new Error(SAGE_NEEDED);
    model = g.out(SAGE_NODE, { model, sage_attention: input.sageKernel });
  }
  if (input.compile) model = g.out(COMPILE_NODE, { model, backend: "inductor" });
  return model;
}
