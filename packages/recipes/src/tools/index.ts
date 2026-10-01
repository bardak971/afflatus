import { defineFamily, defineRecipe, GraphBuilder } from "@studai/core";

/** Things done to a picture that need no picture model: nothing is drawn, so there is no prompt. */
export const tools = defineFamily({
  id: "tools",
  name: "Picture tools",
  summary: "Small jobs on a picture you have, done without a picture model.",
  promptStyle: "sentences",
  slots: [],
  loraMatch: [],
});

export interface RemoveBackground {
  source: string;
  model: string;
}

/**
 * What is in front is kept, the rest becomes see-through. RemoveBackground answers with the part to
 * keep; JoinImageWithAlpha wants the part to drop, hence the inversion.
 */
export const removeBackground = defineRecipe<RemoveBackground>({
  id: "tools.remove-background",
  family: "tools",
  version: 1,
  title: "Remove the background",
  summary: "Keeps what is in front and makes the rest see-through. The result is a PNG.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    {
      id: "model", type: "choice", label: "Background removal model", note: "from ComfyUI's models/background_removal folder",
      options: { node: "LoadBackgroundRemovalModel", input: "bg_removal_name" }, default: "birefnet.safetensors", prefer: ["birefnet", "rmbg", "u2net"],
    },
  ],
  nodes: () => ["LoadImage", "LoadBackgroundRemovalModel", "RemoveBackground", "InvertMask", "JoinImageWithAlpha", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const finder = g.out("LoadBackgroundRemovalModel", { bg_removal_name: input.model });
    g.phase("detailing");
    const front = g.out("RemoveBackground", { bg_removal_model: finder, image: source });
    const cut = g.out("JoinImageWithAlpha", { image: source, alpha: g.out("InvertMask", { mask: front }) });
    const out = g.add("PreviewImage", { images: cut });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads: [`background_removal/${input.model}`] };
  },
  variants: [{ name: "plain", input: { source: "p", model: "b.safetensors" }, uploads: { source: "s.png" } }],
});
