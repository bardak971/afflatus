import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { h3Swap, swapCaption } from "../src/h3/swap";
import { H3_FPS } from "../src/h3/family";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "r.safetensors", swapLora: "swap.safetensors" };
const part = (over: Partial<MediaFacts> = {}): MediaFacts => ({ width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true, ...over });

const build = (over: Record<string, unknown> = {}, source: MediaFacts = part()) => {
  const input = parseInput(h3Swap, { who: "the man in the grey t-shirt.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, ...over });
  const built = h3Swap.build(input, dryContext({ slots, uploads: { source: "src.mp4", "references.0": "r1.png", "references.1": "r2.png" }, media: { source } }));
  return { built, graph: built.graph as Graph };
};

describe("MiniMax H3 · Swap character", () => {
  it("takes the LoRA's short trained caption as its whole prompt, built from who to replace", () => {
    expect(swapCaption("the man in the grey t-shirt", 1)).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
    expect(swapCaption("her", 3)).toBe("Swap her in <Video 1> with the character in <Picture 1>, <Picture 2> and <Picture 3>.");
    const { graph } = build();
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    // the closing full stop the user typed is not doubled
    expect(ref.inputs.prompt).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
  });

  it("gives the source's part as the reference video, at its own shape", () => {
    const { graph } = build();
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    const video = graph[(ref.inputs["ref_videos.ref_video_0"] as [string, number])[0]]!;
    expect(video.class_type).toBe("GetVideoComponents");
    expect(graph[(video.inputs.video as [string, number])[0]]).toMatchObject({ class_type: "LoadVideo", inputs: { file: "src.mp4" } });
    // wide like the source, never the form's tall default
    expect(ref.inputs.width as number).toBeGreaterThan(ref.inputs.height as number);
    // its sound is not handed over as a voice when the file keeps the source's own anyway
    expect(Object.keys(ref.inputs).some((k) => k.startsWith("ref_video_audios."))).toBe(false);
  });

  it("puts the swap LoRA on the model, at its strength", () => {
    const { graph } = build({ swapStrength: 0.8 });
    expect(of(graph, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toContainEqual(["swap.safetensors", 0.8]);
  });

  it("lasts the source's part, floored to H3's frame grid, 141 frames at most", () => {
    expect(build().built.frames).toBe(141);
    // 100 frames handed over: 90 (17·5 + 5), never longer than the source
    expect(build({}, part({ frames: 100 })).built.frames).toBe(90);
    expect(build({}, part({ frames: 300 })).built.frames).toBe(141);
  });

  it("files the source's own sound, cut to the clip; or the sound H3 makes when asked", () => {
    const kept = build();
    const saved = kept.graph[kept.built.outputs.find((o) => o.role === "result")!.node]!;
    const sound = kept.graph[(saved.inputs.audio as [string, number])[0]]!;
    expect(sound).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0 } });
    expect(sound.inputs.duration as number).toBeCloseTo(141 / H3_FPS, 5);
    const own = build({ keepSound: false });
    const savedOwn = own.graph[own.built.outputs.find((o) => o.role === "result")!.node]!;
    expect(own.graph[(savedOwn.inputs.audio as [string, number])[0]]!.class_type).toBe("VAEDecodeAudio");
  });

  it("refuses without the swap LoRA, and says where it is had", () => {
    const input = parseInput(h3Swap, { who: "x", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }] });
    expect(() => h3Swap.build(input, dryContext({ slots: { ...slots, swapLora: "" }, uploads: { source: "src.mp4", "references.0": "r1.png" }, media: { source: part() } }))).toThrow(/Character-Swap LoRA/);
  });
});
