import { defineRecipe, GraphBuilder, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS } from "./family";
import { UPSCALE, UPSCALE_OPTIONAL, upscaleNodes } from "../video/upscale";
import { unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { conditionFor } from "./condition";
import { finish, H3_SAVE_LATENT } from "./finish";
import { h3Inputs, type H3Video } from "./inputs";
import { frameFor, H3_CONTINUATION_NODES, H3_HEAD_GUIDE, H3_LANDING, H3_SEAM, H3_TRIM, resolveJoin } from "./join";
import { H3_LATENT_ENLARGE_NODES, H3_LATENT_UPSCALE_NODES, latentUpscalePass, latentUpscaleSize } from "./latent-upscale";
import { AUTO_SAMPLER, loadH3Model, modelOf, uses } from "./model";

// the recipe's parts live beside it; every name this file used to export is still had from here
export type { H3Video } from "./inputs";
export { H3_CONTINUATION_NODES, H3_HEAD_GUIDE, H3_JOIN_FRAMES, H3_LANDING, H3_LANDINGS, H3_SEAM, H3_TAIL_GUIDE } from "./join";
export { H3_REFERENCES, H3_REFERENCE_VIDEOS } from "./condition";
export { H3_LATENT_ENLARGE_NODES, H3_LATENT_UPSCALE_NODES } from "./latent-upscale";
export { H3_SAVE_LATENT } from "./finish";

export const h3Video = defineRecipe<H3Video>({
  id: "h3.video",
  family: "h3",
  version: 2,
  title: "Video with audio",
  summary: "t2v, or i2v from a first and last frame, with reference images, or extending a previous clip. Audio included.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
    fps: H3_FPS, frameGrid: { step: 17, offset: 5 },
  },
  inputs: h3Inputs,

  nodes(input) {
    const how = uses(input);
    const routeNodes = upscaleNodes(input);
    const guided = Boolean(input.previous || input.next || input.mid) || (how.start && (input.references.length > 0 || input.refVideos.length > 0));
    const picked = modelOf(input, {});
    // a turbo model that makes the clip itself takes no turbo LoRA
    const turboLora = input.fast && !(picked.turbo && (!how.reference || picked.hybrid));
    return [
      ...routeNodes,
      ...unetNodes(input.model), "CLIPLoader", "VAELoader", "MiniMaxH3SigmaShift", how.reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", "RandomNoise", "KSamplerSelect",
      // the latent route runs on the third-party H3 nodes (so a ComfyUI without them is refused up front, not quietly left at the
      // original size), decodes the enlarged latent in tiles, and the model's own frames plainly for the raw side file
      "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", ...(input.upscale === UPSCALE.latent ? [...H3_LATENT_UPSCALE_NODES, "VAEDecodeTiled", "VAEDecode"] : ["VAEDecode"]), "VAEDecodeAudio",
      ...(input.quick ? ["ModelAttentionBackend"] : []),
      ...(turboLora || input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
      ...(how.start || how.end || input.mid || input.references.length ? ["LoadImage"] : []),
      ...(input.voice ? ["LoadAudio"] : []),
      ...(input.previous || input.next || input.refVideos.length ? ["LoadVideo", "GetVideoComponents"] : []),
      ...(guided ? ["MiniMaxH3AddGuide"] : []),
    ];
  },
  optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, ...H3_CONTINUATION_NODES, H3_SEAM, H3_HEAD_GUIDE, H3_LANDING, H3_TRIM, ...H3_SAVE_LATENT,
    "MiniMaxH3Cache", "ModelPatchTorchSettings", "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ",
    // one of the two enlargers is used, by whether the latent upscaler's file is there: neither can be required by nodes()
    ...H3_LATENT_ENLARGE_NODES,
  ],

  build(input, ctx) {
    const { slots, media } = ctx;
    const how = uses(input);
    const picked = modelOf(input, slots);
    if (how.reference && !picked.hybrid && !slots.refUnet) {
      throw new Error("Reference pictures and voices need MiniMax H3's reference model (put minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder) or a hybrid model picked under Model.");
    }
    const join = resolveJoin(input, ctx);
    const { width, height } = frameFor(input, ctx, how, join.latentJoin);

    const g = new GraphBuilder();
    const audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
    const vae = g.out("VAELoader", { vae_name: slots.videoVae });
    const { model, turbo, steps, lora, unet } = loadH3Model(g, ctx, input, picked, how, audioVae);
    const { positive, latent, previous, plain } = conditionFor(g, ctx, input, how, join, { width, height, vae, audioVae });

    // a finish by the latent re-sample starts from the draft's own sampled latent (uploaded as "self.latent"): rendered again, even
    // with its seed, H3 does not make the same frames (measured 2026-10-08: 20 to 30 dB from the draft, the motion drifting)
    const own = input.upscale === UPSCALE.latent ? ctx.uploads["self.latent"] : undefined;
    g.phase(own ? "loading" : "sampling");
    const sampled = own
      ? g.add("AfflatusLoadH3Latent", { latent: own })
      : g.add("SamplerCustomAdvanced", {
          noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
          guider: g.out("BasicGuider", { model, conditioning: positive }),
          sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
          sigmas: g.out("BasicScheduler", { model, scheduler: input.scheduler, steps, denoise: 1 }),
          latent_image: latent,
        });
    // continued in the latent: decoded as one piece with the clip before (its own last tokens, then the new ones), so that
    // the join is the whole chain's decoded at once and plays as a plain cut. The latent saved for the clips after stays the sampled window
    const resample = input.upscale === UPSCALE.latent;
    const seamed: Ref | null = previous && ctx.has(H3_SEAM) ? g.out(H3_SEAM, { previous_av_latent: previous, sampled_window: [sampled, 0], overlap_frames: join.head }) : null;
    let finished: Ref = seamed ?? [sampled, 0];
    let seam = Boolean(seamed) && !resample;
    let fine: Ref | null = null;
    if (resample) {
      // the latent re-sample (a finish): from the window with the clip before's own tokens in its overlap, so that the re-sample
      // starts there from what the clip before's did. Its result is kept (fine) for the clip after's finish, and the join is
      // decoded as one piece with the clip before's re-sampled latent when that one was finished the same way, at this size
      // guided by the prompt alone: a picture pinned at a frame was made for the sampled frame, and re-sampled larger it left the
      // clip's first frames hazy and soft (2026-10-08)
      fine = latentUpscalePass(g, ctx, input, { model, positive: plain, latent: finished, turbo, width, height });
      finished = fine;
      const big = latentUpscaleSize(input, width, height);
      const before = media.previous?.fine;
      const prevFine = seamed && before && before.width === big.width && before.height === big.height ? ctx.uploads["previous.fine"] : undefined;
      if (prevFine) {
        const loaded = g.out("AfflatusLoadH3Latent", { latent: prevFine });
        const cut = media.previous?.latentCut;
        finished = g.out(H3_SEAM, { previous_av_latent: cut ? g.out(H3_TRIM, { samples: loaded, frames: cut }) : loaded, sampled_window: fine, overlap_frames: join.head });
        seam = true;
      }
    }
    const made = finish(g, ctx, input, { finished, sampled, fine, vae, audioVae, width, height });

    const { head, tail, latentJoin } = join;
    const ms = (n: number) => Math.round((n / H3_FPS) * 1000);
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: made.outputs,
      totalSteps: own ? input.upscaleSteps : steps,
      passes: own ? [] : [{ node: sampled, steps }],
      loads: [`diffusion_models/${unet}`, `text_encoders/${slots.clip}`, ...(lora ? [`loras/${lora}`] : []), ...made.loads],
      ...(head || tail ? { overlap: { headMs: ms(head), tailMs: ms(tail), ...(latentJoin ? { latent: true } : {}), ...(seam ? { seam: true } : {}) } } : {}),
    };
  },


  variants: ((): Variant<H3Video>[] => {
    const slots = { unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors" };
    const all = { ...slots, turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors" };
    const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "words only, plain", input: { description: "a", fast: false, smooth: false, quick: false }, slots },
      { name: "fast, smooth, quick", input: { description: "a", cache: true }, slots: all },
      { name: "full steps with the step cache", input: { description: "a", fast: false, cache: true }, slots: all },
      {
        name: "opens on a picture and ends on another, a LoRA",
        input: { description: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }], fast: false },
        slots, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      {
        name: "carries on from a clip",
        input: { description: "a", previous: { asset: "c1" }, start: "ignored" },
        slots: all, uploads: { previous: "a.mp4", start: "a.png" }, media: { previous: joined },
      },
      // (the latent routes are not variants: nodes() declares the pixel route, which is always possible; the
      // recipe tests build them and check them against the catalog)
      {
        name: "between two clips, the next one silent and short",
        input: { description: "a", previous: { asset: "c1", at: 3000 }, next: { asset: "c2" }, end: "ignored" },
        slots: all, uploads: { previous: "a.mp4", next: "b.mp4", end: "b.png" },
        media: { previous: joined, next: { ...joined, frames: 5, hasSound: false } }, canvas: { width: 1024, height: 576 },
      },
      {
        name: "a person and a place from reference pictures, a voice, opening on a picture",
        input: {
          description: "a", subject: "brown hair", start: "p1", end: "ignored", voice: "v1", sharpRefs: true,
          references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "person" }, { asset: "r3", role: "place" }],
        },
        slots: all, uploads: { start: "a.png", end: "b.png", voice: "v.wav", "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png" },
        media: { start: picture },
      },
      {
        name: "references, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "clothing" }], fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: joined },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, with a reference picture",
        input: { description: "a", model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }] },
        slots: { ...slots, turbo: all.turbo }, uploads: { "references.0": "r1.png" },
      },
      {
        name: "a video of the person with its sound, and a picture of the place",
        input: { description: "a", refVideos: [{ asset: "v1", role: "person" }, { asset: "v2", role: "person" }], references: [{ asset: "r1", role: "place" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "references.0": "r1.png" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: false } },
      },
      {
        name: "passes through a picture half way",
        input: { description: "a", start: "p1", mid: "p2", midAt: 2.5 },
        slots: all, uploads: { start: "a.png", mid: "m.png" }, media: { start: picture },
      },
      { name: "latent upscale, plain resize", input: { description: "a", upscale: UPSCALE.latent }, slots: all },
      { name: "latent upscale, H3's upscaler", input: { description: "a", upscale: UPSCALE.latent, upscaleBy: 1.5, fast: false }, slots: { ...all, latentUpscaler: "minimax_h3_latent_upscaler_3d_fp16.safetensors" } },
      { name: "pixel upscale with a model", input: { description: "a", upscale: UPSCALE.model, upscaleModel: "4x-UltraSharp.pth" }, slots: all },
      { name: "pixel upscale with RTX VSR", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all },
      { name: "pixel upscale with the other RTX node, NVIDIA's absent", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all, has: (n: string) => n !== "RTXVideoSuperResolution" },
      { name: "SeedVR2 upscale", input: { description: "a", upscale: UPSCALE.seedvr, upscaleBy: 2, upscaleColour: "wavelet" }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" } },
      {
        name: "a voice only, with the picture of who speaks",
        input: { description: "a", start: "p1", voice: "v1" },
        slots: all, uploads: { start: "a.png", voice: "v.wav" }, media: { start: picture },
      },
    ];
  })(),
});
