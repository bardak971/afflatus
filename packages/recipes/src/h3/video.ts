import { defineRecipe, GraphBuilder, REFERENCE_ROLES, type ClipValue, type LoraValue, type MediaFacts, type Ref, type ReferenceValue, type SizeValue, type Variant } from "@studai/core";
import { H3_FPS, h3Canvas, h3Frames } from "./family";
import { h3Prompt, h3ReferencePrompt, type H3Mode } from "./prompt";

export interface H3Video {
  description: string;
  soundscape: string;
  music: string;
  start?: string;
  end?: string;
  mid?: string;
  midAt: number;
  previous?: ClipValue;
  next?: ClipValue;
  references: ReferenceValue[];
  voice?: string;
  subject: string;
  sharpRefs: boolean;
  seconds: number;
  shape: SizeValue;
  short: number;
  fast: boolean;
  steps: number;
  smooth: boolean;
  quick: boolean;
  cache: boolean;
  loras: LoraValue[];
  seed: number;
}

/**
 * How much of a neighbouring clip is handed over at a join: 22 frames (almost a second) carry the motion
 * and the voices over, not just the pose. A clip too short for that gives 5. The model takes guide clips
 * of 17k + 5 frames only.
 */
export const H3_JOIN_FRAMES = [22, 5];
/** How many reference pictures the reference model is given at most (it takes 9; the opening picture is one of them). */
export const H3_REFERENCES = 6;

const guideFrames = (m: MediaFacts | undefined) => {
  const n = m?.frames ?? 0;
  if (!H3_JOIN_FRAMES.includes(n)) throw new Error(`a join takes ${H3_JOIN_FRAMES.join(" or ")} frames of the other clip, not ${n}`);
  return n;
};

/**
 * Which way the clip is made. With reference pictures or a voice, the reference model is used: the
 * pictures say who and what is in the clip without being frames of it, and the voice is the one the
 * person speaks with. Otherwise the pictures are the clip's first and last frame.
 */
const uses = (input: H3Video) => {
  const reference = input.references.length > 0 || Boolean(input.voice);
  return {
    reference,
    start: Boolean(input.start && !input.previous),
    // a clip to arrive at says more than a picture: with both, the clip is followed. The reference model has no last frame.
    end: Boolean(input.end && !input.next && !reference),
  };
};

export const h3Video = defineRecipe<H3Video>({
  id: "h3.video",
  family: "h3",
  version: 2,
  title: "Video with sound",
  summary: "From words, from a first and a last picture, with people and places from reference pictures, or continuing another clip.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
    fps: H3_FPS, frameGrid: { step: 17, offset: 5 },
  },
  inputs: [
    {
      id: "description", type: "prompt", label: "What happens", style: "sentences",
      placeholder: "She walks to the railing and looks out at the sea. The camera follows her slowly. (S1) says <d>[English] What a view.</d> softly.",
    },
    { id: "soundscape", type: "prompt", label: "Sounds", style: "sentences", optional: true, placeholder: "waves, a light wind, seagulls far away" },
    { id: "music", type: "prompt", label: "Music", style: "sentences", optional: true, placeholder: "none" },
    { id: "start", type: "image", role: "start", label: "Opening picture", optional: true },
    { id: "end", type: "image", role: "end", label: "Ending picture", optional: true },
    { id: "mid", type: "image", role: "mid", at: "midAt", label: "A picture it passes through", optional: true, advanced: true },
    { id: "midAt", type: "number", label: "It passes through it at", min: 0.5, max: 14.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid", advanced: true },
    {
      id: "previous", type: "clip", role: "previous", label: "Continues from", optional: true, frames: H3_JOIN_FRAMES, fps: H3_FPS,
      note: "the motion and the voices of that clip continue into this one",
    },
    {
      id: "next", type: "clip", role: "next", label: "Flows into", optional: true, frames: H3_JOIN_FRAMES, fps: H3_FPS, advanced: true,
      note: "this clip ends exactly where that one begins",
    },
    {
      id: "references", type: "references", label: "Who and what is in it", max: H3_REFERENCES, roles: [...REFERENCE_ROLES],
      note: "pictures of a person, a place, clothes, an object or a look: they are followed, they are not frames of the clip",
    },
    { id: "voice", type: "audio", role: "voice", label: "Voice", optional: true, note: "a few seconds of someone speaking: the person in the clip speaks with that voice" },
    {
      id: "subject", type: "prompt", label: "How the person looks", style: "sentences", optional: true, showWhen: "references", holds: "subject",
      placeholder: "brown hair, green eyes, freckles", note: "in a few words, to help the pictures",
    },
    { id: "seconds", type: "number", label: "Length", min: 2, max: 15, step: 0.5, default: 5, unit: " s" },
    {
      id: "shape", type: "size", label: "Shape", default: "tall", grid: 32, min: 256, max: 1344,
      note: "an opening picture or a clip it joins decides the shape instead",
      shapes: [
        { id: "tall", label: "Tall", width: 576, height: 1024 },
        { id: "square", label: "Square", width: 768, height: 768 },
        { id: "wide", label: "Wide", width: 1024, height: 576 },
      ],
    },
    { id: "short", type: "number", label: "Size of the short side", note: "larger is sharper and slower", min: 384, max: 768, step: 96, default: 576, unit: " px", advanced: true },
    { id: "fast", type: "toggle", label: "Fast", note: "8 steps, with the turbo LoRA", default: true, advanced: true },
    { id: "steps", type: "number", label: "Steps", min: 4, max: 50, step: 1, default: 15, showWhen: { input: "fast", in: [false] }, advanced: true },
    { id: "smooth", type: "toggle", label: "Smooth motion", note: "48 pictures a second instead of 24", default: true, advanced: true },
    { id: "sharpRefs", type: "toggle", label: "Reference pictures at full size", note: "holds a face better, several times slower", default: false, advanced: true },
    { id: "quick", type: "toggle", label: "Quick attention", note: "Nvidia and AMD cards. Turn it off if renders fail on another machine.", default: true, advanced: true },
    { id: "cache", type: "toggle", label: "Skip steps that barely change", note: "faster, can soften details; only without Fast", default: false, showWhen: { input: "fast", in: [false] }, advanced: true },
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "seed", type: "seed", label: "Seed" },
  ],

  nodes(input) {
    const how = uses(input);
    const guided = Boolean(input.previous || input.next || input.mid) || (how.start && input.references.length > 0);
    return [
      "UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3SigmaShift", how.reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", "RandomNoise", "KSamplerSelect",
      "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "VHS_VideoCombine",
      ...(input.quick ? ["ModelAttentionBackend"] : []),
      ...(input.fast || input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
      ...(how.start || how.end || input.mid || input.references.length ? ["LoadImage"] : []),
      ...(input.voice ? ["LoadAudio"] : []),
      ...(input.previous || input.next ? ["LoadVideo", "GetVideoComponents"] : []),
      ...(guided ? ["MiniMaxH3AddGuide"] : []),
    ];
  },
  optionalNodes: ["MiniMaxH3Cache", "ModelPatchTorchSettings", "FrameInterpolationModelLoader", "FrameInterpolate"],

  build(input, ctx) {
    const { slots, uploads, media } = ctx;
    const how = uses(input);
    if (how.reference && !slots.refUnet) {
      throw new Error("Reference pictures and voices need MiniMax H3's reference model: put minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder.");
    }
    const head = input.previous ? guideFrames(media.previous) : 0;
    const tail = input.next ? guideFrames(media.next) : 0;
    // the frames shared with a neighbour are that neighbour's: the clip is made that much longer, so its own part keeps the length asked for
    const seconds = input.seconds + (head + tail) / H3_FPS;
    const frames = h3Frames(seconds);

    // the frame: a timeline's canvas, else the clip it joins, else the picture it opens or ends on, else the shape picked
    const like = input.previous ? media.previous : input.next ? media.next : how.start ? media.start : how.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? h3Canvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height))
      : like && (input.previous || input.next)
        ? h3Canvas(like.width, like.height, Math.min(like.width, like.height))
        : like
          ? h3Canvas(like.width, like.height, input.short)
          : h3Canvas(input.shape.width, input.shape.height, input.short);

    const g = new GraphBuilder();
    const audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
    const vae = g.out("VAELoader", { vae_name: slots.videoVae });
    const unet = how.reference ? slots.refUnet : slots.unet;
    // the reference model has a turbo LoRA of its own when one is installed; without it the usual one is
    // used, as the DaSiWa H3 workflow does (one turbo LoRA after whichever model the clip needs)
    const turboFile = how.reference ? slots.refTurbo ?? slots.turbo : slots.turbo;
    const turbo = input.fast && Boolean(turboFile);
    let model = g.out("UNETLoader", { unet_name: unet, weight_dtype: "default" });
    // the step cache is for full renders: with the turbo LoRA's 8 steps there is nothing to skip, and it hurts
    if (input.cache && !turbo && ctx.has("MiniMaxH3Cache")) {
      model = g.out("MiniMaxH3Cache", { model, reuse_threshold: 0.05, start_percent: 0.15, end_percent: 0.9, max_steps: 2, device: "auto", verbose: false });
    }
    if (input.quick) model = g.out("ModelAttentionBackend", { model, attention: "comfy kitchen attention" });
    if (ctx.has("ModelPatchTorchSettings")) model = g.out("ModelPatchTorchSettings", { model, enable_fp16_accumulation: true });
    if (turbo) model = g.out("LoraLoaderModelOnly", { model, lora_name: turboFile, strength_model: 1 });
    for (const l of input.loras) {
      if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    }
    model = g.out("MiniMaxH3SigmaShift", { model, shift_video: turbo ? 7 : 11, shift_audio: turbo ? 4.5 : 4 });

    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "minimax", device: "default" });
    let start: string;
    let positive: Ref;
    if (how.reference) {
      // a voice with a picture to open on and nothing else: that picture is who speaks, not a frame
      const voiceOnly = input.references.length === 0;
      const pictures = voiceOnly ? (how.start ? [{ file: uploads.start, role: "person" }] : []) : input.references.map((r, i) => ({ file: uploads[`references.${i}`], role: r.role }));
      // with references, the clip can still open on its picture: it is given as one more picture and pinned at the first frame
      const opening = !voiceOnly && how.start;
      const files = [...pictures.map((p) => p.file), ...(opening ? [uploads.start] : [])];
      const prompt = h3ReferencePrompt(input, { roles: pictures.map((p) => p.role), voice: Boolean(input.voice), continues: Boolean(input.previous), opening, voiceOnly });
      start = g.add("MiniMaxH3ReferenceToVideo", {
        clip, vae, audio_vae: audioVae, prompt, width, height, length: frames, ref_image_size: input.sharpRefs ? "max" : "match",
        // inputs of a group that grows are named "<group>.<prefix><n>", counting from 0
        ...Object.fromEntries(files.map((file, i) => [`ref_images.ref_image_${i}`, g.out("LoadImage", { image: file })])),
        ...(input.voice ? { "ref_audios.ref_audio_0": g.out("LoadAudio", { audio: uploads.voice }) } : {}),
      });
      positive = [start, 0];
      // one frame only: a longer still freezes the opening and the model then jumps to another scene
      if (opening) positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent: [start, 1], image: g.out("LoadImage", { image: uploads.start }), frame_idx: 0 });
    } else {
      const mode: H3Mode = how.start ? (how.end ? "both" : "start") : how.end ? "land" : "free";
      start = g.add("MiniMaxH3ImageToVideo", {
        clip, vae, prompt: h3Prompt(mode, seconds, input), width, height, length: frames,
        ...(how.start ? { first_frame: g.out("LoadImage", { image: uploads.start }) } : {}),
        ...(how.end ? { last_frame: g.out("LoadImage", { image: uploads.end }) } : {}),
      });
      positive = [start, 0];
    }
    const latent: Ref = [start, 1];
    // a join: the neighbour's frames and their sound are pinned in place, at the very start or the very end
    const pin = (file: string | undefined, facts: MediaFacts | undefined, at: number) => {
      const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
      positive = g.out("MiniMaxH3AddGuide", {
        positive, vae, audio_vae: audioVae, latent, image: [parts, 0], frame_idx: at,
        ...(facts?.hasSound === false ? {} : { audio: [parts, 1] }),
      });
    };
    if (input.previous) pin(uploads.previous, media.previous, 0);
    if (input.next) pin(uploads.next, media.next, -tail);
    // a picture the clip passes through: one frame pinned at its moment, counted after the frames shared with the clip before
    if (input.mid) {
      const at = Math.max(1, Math.min(frames - tail - 2, head + Math.round(Math.min(input.midAt, input.seconds - 0.25) * H3_FPS)));
      positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent, image: g.out("LoadImage", { image: uploads.mid }), frame_idx: at });
    }

    const steps = turbo ? 8 : input.steps;
    g.phase("sampling");
    const sampled = g.add("SamplerCustomAdvanced", {
      noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
      guider: g.out("BasicGuider", { model, conditioning: positive }),
      sampler: g.out("KSamplerSelect", { sampler_name: turbo ? "euler" : "res_multistep" }),
      sigmas: g.out("BasicScheduler", { model, scheduler: "simple", steps, denoise: 1 }),
      latent_image: latent,
    });

    g.phase("decoding");
    let images = g.out("VAEDecode", { samples: [sampled, 0], vae });
    const audio = g.out("VAEDecodeAudio", { samples: [sampled, 0], vae: audioVae });
    const smooth = input.smooth && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
    if (smooth) {
      g.phase("interpolating");
      images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
    }
    g.phase("encoding");
    // into ComfyUI's temp folder, which it clears itself: nothing piles up in output/
    const out = g.add("VHS_VideoCombine", {
      images, audio, frame_rate: smooth ? H3_FPS * 2 : H3_FPS, loop_count: 0, filename_prefix: "studai/video", format: "video/h264-mp4",
      pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: 19, save_metadata: false, trim_to_audio: false,
    });

    const ms = (n: number) => Math.round((n / H3_FPS) * 1000);
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "video", role: "result" }],
      totalSteps: steps,
      passes: [{ node: sampled, steps }],
      loads: [`diffusion_models/${unet}`, `text_encoders/${slots.clip}`, ...(turbo ? [`loras/${turboFile}`] : [])],
      ...(head || tail ? { overlap: { headMs: ms(head), tailMs: ms(tail) } } : {}),
    };
  },

  advice(input, card) {
    const out = [];
    const small = card.vramGb <= 13;
    const tiny = card.vramGb <= 9;
    const gb = Math.round(card.vramGb);
    if (input.short >= 768 && input.seconds > 6 && small) out.push({ input: "short", level: "heavy" as const, text: `probably too big for a ${gb} GB card at this length` });
    else if (input.short > (tiny ? 480 : 576) && small) out.push({ input: "short", level: "slow" as const, text: `slow on your ${gb} GB card` });
    if (input.seconds > 8 && small) out.push({ input: "seconds", level: "slow" as const, text: `long clips slow down a lot on a ${gb} GB card: two clips that flow on are faster` });
    if (input.sharpRefs && input.references.length) out.push({ input: "sharpRefs", level: "slow" as const, text: "several times slower" });
    return out;
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
        name: "passes through a picture half way",
        input: { description: "a", start: "p1", mid: "p2", midAt: 2.5 },
        slots: all, uploads: { start: "a.png", mid: "m.png" }, media: { start: picture },
      },
      {
        name: "a voice only, with the picture of who speaks",
        input: { description: "a", start: "p1", voice: "v1" },
        slots: all, uploads: { start: "a.png", voice: "v.wav" }, media: { start: picture },
      },
    ];
  })(),
});
