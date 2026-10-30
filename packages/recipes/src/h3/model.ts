import { wanted, type BuildContext, type GraphBuilder, type Ref, type StartCondition, type StartRule } from "@afflatus/core";
import { addedLora, applyLoras, livePreview, putAdded } from "../shared/model";
import { loadUnet } from "../shared/unet";
import { UPSCALE } from "../video/upscale";
import type { H3Video } from "./inputs";

/** The sampler drafts saved before the form showed it said "Auto" with: the one that suits the steps (euler for a turbo's few, res_multistep otherwise). */
export const AUTO_SAMPLER = "Auto";

/** What a model other than the usual one is, as far as its file name says: fine-tunes are named for it ("…HybridTurboV3"). */
export const namedFor = { turbo: /turbo|distill|lightning|(^|[^a-z0-9])\d+[ _-]?steps?/i, hybrid: /hybrid/i };

/**
 * The model the clip is made with, and what it is. The usual files are MiniMax's own: one model for
 * first and last frames, another for references, and a turbo LoRA for few steps. A fine-tune can be all
 * of that in one file: a hybrid follows references itself, a turbo (distilled) one needs no LoRA.
 */
export const modelOf = (input: H3Video, slots: Record<string, string>) => {
  // the usual file can itself be a fine-tune, where MiniMax's own is not installed: what a file is is read from its name either way
  const file = input.model ?? slots.unet;
  const name = file?.split(/[\\/]/).pop() ?? "";
  const is = (said: string, named: RegExp) => said === "Yes" || (said !== "No" && named.test(name));
  return { file, turbo: is(input.turboIn, namedFor.turbo), hybrid: is(input.hybrid, namedFor.hybrid) };
};
type H3Model = ReturnType<typeof modelOf>;

/**
 * Turbo's LoRA, when Turbo is on and the clip's model is not a turbo one itself (loadH3Model): the family's file the input
 * needs (Recipe.needsWith). A reference clip on MiniMax's own reference model takes either LoRA (refTurbo, else turbo):
 * referenceNeeds asks for one when the machine has neither.
 */
export const turboNeeds = (input: H3Video, slots: Record<string, string> = {}): string[] => {
  if (!input.fast) return [];
  const picked = modelOf(input, slots);
  if (uses(input).reference && !picked.hybrid) return [];
  return picked.turbo ? [] : ["turbo"];
};

/**
 * Where the form starts Turbo's steps and shifts by the files found: a reference clip (pictures, videos or a voice of
 * the cast) on MiniMax's reference model, a model that is not a hybrid, takes that model's own turbo LoRA when it is
 * there, and MiniMax's is made for 4 steps at 6 / 3. The render runs what the form says (loadH3Model).
 */
/** MiniMax's reference turbo LoRA made for 4 steps, by its name (H3's, Swap's and Motion transfer's starts). */
export const REF_TURBO_4_STEPS: StartCondition = { name: { slot: "refTurbo" }, match: "(^|[^0-9])4[ _-]?steps?([^a-z]|$)" };
/** What it is made for: 4 steps at 6 / 3. */
export const REF_TURBO_4_VALUES = { turboSteps: 4, shiftVideo: 6, shiftAudio: 3 };
export const H3_STARTS: StartRule[] = [{
  when: {
    all: [
      { input: "fast", is: true },
      { any: [{ input: "references", filled: true }, { input: "refVideos", filled: true }, { input: "voice", filled: true }] },
      { any: [{ input: "hybrid", is: "No" }, { all: [{ input: "hybrid", is: "From the name" }, { not: { name: { input: "model", slot: "unet" }, match: namedFor.hybrid.source } }] }] },
      // a distilled reference model takes no LoRA at all
      { not: { name: { slot: "refUnet" }, match: namedFor.turbo.source } },
      REF_TURBO_4_STEPS,
    ],
  },
  values: REF_TURBO_4_VALUES,
}];

/**
 * Which way the clip is made. With reference pictures or a voice, the reference model is used: the
 * pictures say who and what is in the clip without being frames of it, and the voice is the one the
 * person speaks with. Otherwise the pictures are the clip's first and last frame.
 */
/**
 * Veda's predictor a clip with Veda on needs (Recipe.needsWith): the reference model's for a clip it makes (with references
 * or a voice, on a model that is not a hybrid one), else the text-and-frames one. A swap names its own (always the first).
 */
export const vedaNeeds = (input: H3Video, slots: Record<string, string> = {}): string[] => {
  if (!input.veda) return [];
  return uses(input).reference && !modelOf(input, slots).hybrid ? ["veda"] : ["vedaT2va"];
};

/**
 * MiniMax's reference model, for a clip it makes (Recipe.needsWith): one with reference pictures, videos or a voice on a
 * model that is not a hybrid (a recipe whose build adds pictures of its own passes them in `input.references`, as a motion
 * window's frame before), and with Turbo on its own turbo LoRA when the machine has neither LoRA. Optional in the family,
 * it was asked for by no form: a fresh pod was sent the frames model such a clip never loads, and the job failed at its
 * submit once the boot and the fetch were paid. A Finish › Face refine samples nothing and asks for neither.
 */
export const referenceNeeds = (input: H3Video, slots: Record<string, string> = {}): string[] => {
  if (input.faceRefineOnly && input.upscale !== UPSCALE.latent) return [];
  if (!uses(input).reference || modelOf(input, slots).hybrid) return [];
  // a distilled reference model is made for few steps as it is: no LoRA on top of it (loadH3Model)
  const distilled = namedFor.turbo.test(slots.refUnet?.split(/[\\/]/).pop() ?? "");
  return ["refUnet", ...(input.fast && !distilled && !slots.refTurbo && !slots.turbo ? ["refTurbo"] : [])];
};

export const uses = (input: H3Video) => {
  // (a form that does not take H3's reference videos has none in its input: Motion transfer's Veda on threw here)
  const reference = (input.references ?? []).length > 0 || (input.refVideos ?? []).length > 0 || Boolean(input.voice);
  return {
    reference,
    start: Boolean(input.start && !input.previous),
    // a clip to arrive at says more than a picture: with both, the clip is followed. The reference model has no last frame.
    end: Boolean(input.end && !input.next && !reference),
  };
};
export type H3Uses = ReturnType<typeof uses>;

/**
 * The model chain the clip is sampled with: the right file for the way the clip is made, the step cache,
 * the attention and precision patches, the turbo LoRA and the user's LoRAs, the sigma shift, and the
 * live preview. With it, what the chain is (turbo or not, with which LoRA) and how many steps it takes.
 */
export function loadH3Model(g: GraphBuilder, ctx: BuildContext, input: H3Video, picked: H3Model, how: H3Uses, audioVae: Ref, vedaFor?: "reference", turboPick?: string): { model: Ref; turbo: boolean; steps: number; lora: string | undefined; loraWeight: number; distilled: boolean; unet: string | undefined; loader?: Ref; vedaMissing: "reference" | "t2va" | null } {
  const { slots } = ctx;
  // references: a hybrid model follows them itself, any other hands those clips to MiniMax's reference model
  const own = !how.reference || picked.hybrid;
  const unet = own ? picked.file : slots.refUnet;
  // Veda's predictor is made for one model: the reference model's (R2VA) for the clips it makes (a swap's, whatever its
  // file), else the text-and-frames one (T2VA, which its makers say serves FL2VA and the fine-tunes too)
  const vedaKind = vedaFor ?? (own ? "t2va" : "reference");
  const veda = input.veda ? (vedaKind === "reference" ? slots.veda : slots.vedaT2va) : undefined;
  // the reference model has a turbo LoRA of its own when one is installed; without it the usual one is
  // used, as the model author's own H3 workflow does (one turbo LoRA after whichever model the clip needs)
  // (a recipe that knows better names its own: the swap's reference model, run as the clip's own file, takes the reference one)
  const turboFile = turboPick ?? (how.reference && !picked.hybrid ? slots.refTurbo ?? slots.turbo : slots.turbo);
  // a turbo model is made for few steps as it is: the LoRA on top of it would be the same thing twice
  const distilled = own ? picked.turbo : namedFor.turbo.test(unet?.split(/[\\/]/).pop() ?? "");
  // the file and weight of Turbo's row in the LoRA list (card #160): the slot's at 1 left as they start; the same file in
  // the user's list is that row, at the weight typed there, put on once
  const added = input.fast && !distilled ? addedLora(turboFile, input.turboLora, input.turboWeight, input.loras) : { lora: null, put: false, loras: input.loras };
  const lora = added.lora?.file;
  const turbo = distilled || Boolean(lora);
  // the steps and shifts are the form's, as it shows them: it starts them on what the LoRA in use was trained at (Turbo:
  // 12 / 3; a reference clip on MiniMax's 4-step reference LoRA: 4 steps at 6 / 3, see H3_STARTS)
  const loader = loadUnet(g, ctx, unet);
  let model = loader;
  // the step cache is for full renders: with the turbo LoRA's 8 steps there is nothing to skip, and it hurts
  if (input.cache && !turbo && wanted(ctx, { input: "cache", nodes: ["MiniMaxH3Cache"], without: "H3's Cache" })) {
    model = g.out("MiniMaxH3Cache", { model, reuse_threshold: input.cacheThreshold, start_percent: Math.min(input.cacheStart, input.cacheEnd), end_percent: input.cacheEnd, max_steps: input.cacheSteps, device: "auto", verbose: false });
  }
  if (input.quick) model = g.out("ModelAttentionBackend", { model, attention: "comfy kitchen attention" });
  if (ctx.has("ModelPatchTorchSettings")) model = g.out("ModelPatchTorchSettings", { model, enable_fp16_accumulation: true });
  model = putAdded(g, model, added);
  model = applyLoras(g, model, added.loras);
  model = g.out("MiniMaxH3SigmaShift", { model, shift_video: input.shiftVideo, shift_audio: input.shiftAudio });
  // Veda's sparse attention, last on the model before the sampler as its makers ask: after the LoRAs, and after Comfy Kitchen's
  // attention, which it runs on top of for the layers it leaves full. 32 key tiles kept of each query tile, its default and
  // the tested character-swap workflow's (a count, not a share: it holds on small first passes)
  if (veda && wanted(ctx, { input: "veda", nodes: ["VedaSparseAttention"], without: "Veda", instead: "made with the full attention" })) {
    model = g.out("VedaSparseAttention", { model, predictor: veda, generated_sparsity: String(input.vedaGenerated ?? 32), reference_sparsity: String(input.vedaReference ?? 32), full_attention_layers: "", full_attention_steps: "", verbose: false });
  }
  // the live preview, with the sound so far, sent to whoever queued the prompt: what ComfyUI itself shows
  model = livePreview(g, ctx, model, input.livePreview, audioVae);
  // a turbo model with Fast off takes the steps typed (4 to 8 are what it is made for)
  const steps = lora || (distilled && input.fast) ? input.turboSteps : input.steps;
  return { model, turbo, steps, lora: added.put ? lora : undefined, loraWeight: added.lora?.weight ?? 1, distilled, unet, loader, vedaMissing: input.veda && !veda ? vedaKind : null };
}
