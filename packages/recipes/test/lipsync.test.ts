import { describe, expect, it } from "vitest";
import { dryContext, parseInput, partFit, type InputSpec, type MediaFacts } from "@afflatus/core";
import { h3LipSync } from "../src/h3/lipsync";
import { H3_FPS } from "../src/h3/family";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "r.safetensors" };
const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };

const build = (over: Record<string, unknown>, media: Record<string, MediaFacts> = {}, uploads: Record<string, string> = {}) => {
  const input = parseInput(h3LipSync, { description: "a café terrace", references: [{ asset: "r1", role: "person" }], recording: "a1", ...over });
  const built = h3LipSync.build(input, dryContext({ slots, uploads: { "references.0": "r1.png", recording: "rec.wav", ...uploads }, media }));
  return { built, graph: built.graph as Graph };
};
const recordingOf = (seconds: number) => ({ recording: { width: 0, height: 0, seconds } });

describe("MiniMax H3 · Lip sync", () => {
  it("has a recording in place of the duration, and the scene in place of the dialogue", () => {
    const ids = h3LipSync.inputs.map((i) => i.id);
    expect(ids).not.toContain("seconds");
    expect(ids.indexOf("recording")).toBe(ids.indexOf("description") + 1);
    expect(h3LipSync.inputs.find((i) => i.id === "recording")).toMatchObject({ type: "audio", window: { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness" } });
    expect(h3LipSync.inputs.find((i) => i.id === "description")?.label).toBe("What happens");
  });

  it("takes no voice sample: the recording is the voice, and the cast's sample is not added", () => {
    const ids = h3LipSync.inputs.map((i) => i.id);
    expect(ids).not.toContain("voice");
    expect(ids).not.toContain("voiceSeconds");
    expect(h3LipSync.inputs.some((i) => i.type === "audio" && i.role === "voice")).toBe(false);
  });

  it("says how much of the recording one clip holds: 14.8 s, less the moment before the words and the clip before's frames", () => {
    const spec = h3LipSync.inputs.find((i) => i.id === "recording") as Extract<InputSpec, { type: "audio" }>;
    const fit = (values: Record<string, unknown>) => partFit(spec.window!.fits!, h3LipSync.inputs, values);
    expect(fit({}).most).toBe(14.8);
    expect(fit({ speechAt: 1 }).most).toBe(13.8);
    // continuing a clip: its 22 frames (0.92 s) are this clip's too
    expect(fit({ previous: { asset: "c1" }, context: "22", speechAt: 1 }).most).toBe(12.9);
    expect(fit({ previous: { asset: "c1" }, context: "5" }).most).toBe(14.6);
    // what a part makes: the part, the quarter second after it, 4 s at least
    expect(fit({}).clip(13.2)).toBeCloseTo(13.45, 5);
    expect(fit({}).clip(1.8)).toBe(4);
  });

  it("lasts as long as the recording's part, on H3's frame grid", () => {
    // 5.9 s of words and a quarter second after them: 6.15 s, rounded up to 17k + 5 frames (158)
    expect(build({}, recordingOf(5.9)).built.frames).toBe(158);
    // without the part's length (a dry build), the length asked for
    expect(build({ recordingSeconds: 8 }).built.frames).toBe(209);
    // a short recording still makes a clip H3 was trained on (4 s at least)
    expect(build({}, recordingOf(1.5)).built.frames).toBeGreaterThanOrEqual(4 * H3_FPS);
  });

  it("lays the recording on the sound where the clip's own part begins, after the clip before's frames and the lead-in", () => {
    const { graph } = build({ previous: { asset: "c1" }, speechAt: 0.5 }, { previous: joined, ...recordingOf(4.2) }, { previous: "a.mp4" });
    // (the clip before's frames are pinned with their own sound too, at frame 0, when there is no saved latent to continue)
    const fromRecording = (n: Node) => {
      const cut = graph[(n.inputs.audio as [string, number])[0]];
      return cut?.class_type === "TrimAudioDuration" && graph[(cut.inputs.audio as [string, number])[0]]?.class_type === "LoadAudio";
    };
    const audioGuides = of(graph, "MiniMaxH3AddGuide").filter((n) => n.inputs.audio && fromRecording(n));
    expect(audioGuides).toHaveLength(1);
    expect(audioGuides[0]!.inputs.frame_idx).toBe(22 + 12);
    const cut = graph[(audioGuides[0]!.inputs.audio as [string, number])[0]]!;
    expect(graph[(cut.inputs.audio as [string, number])[0]]).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "rec.wav" } });
    // the sampled clip follows it
    const guider = of(graph, "BasicGuider")[0]!;
    expect((guider.inputs.conditioning as [string, number])[0]).toBe(Object.entries(graph).find(([, n]) => n === audioGuides[0])![0]);
  });

  it("asks the person to speak, after the scene", () => {
    const { graph } = build({}, recordingOf(5));
    const prompt = String(of(graph, "MiniMaxH3ReferenceToVideo")[0]!.inputs.prompt);
    expect(prompt).toContain("a café terrace The person speaks throughout");
  });

  it("files the recording itself as the sound to the clip's end: the model's lead-in before it, never its sound after", () => {
    const { built, graph } = build({ previous: { asset: "c1" }, speechAt: 0.5 }, { previous: joined, recording: { width: 0, height: 0, seconds: 4.2, after: 4 } }, { previous: "a.mp4" });
    const result = built.outputs.find((o) => o.role === "result")!;
    const saved = graph[result.node]!;
    const sound = graph[(saved.inputs.audio as [string, number])[0]]!;
    // lead-in + the recording, the pause handed over after its part included
    expect(sound.class_type).toBe("AudioConcat");
    const before = (22 + 12) / H3_FPS;
    const lead = graph[(sound.inputs.audio1 as [string, number])[0]]!;
    expect(lead).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0 } });
    expect(lead.inputs.duration as number).toBeCloseTo(before, 5);
    const recording = graph[(sound.inputs.audio2 as [string, number])[0]]!;
    expect(recording).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0 } });
    expect(graph[(recording.inputs.audio as [string, number])[0]]).toMatchObject({ class_type: "LoadAudio" });
    // to the clip's last frame
    expect(before + (recording.inputs.duration as number)).toBeCloseTo(built.frames! / H3_FPS, 5);
    // the one recording loaded once, for the guide and the sound
    expect(of(graph, "LoadAudio")).toHaveLength(1);
  });

  it("files the recording alone when the clip starts on its words", () => {
    const { built, graph } = build({}, { recording: { width: 0, height: 0, seconds: 5, after: 4 } });
    const saved = graph[built.outputs.find((o) => o.role === "result")!.node]!;
    const sound = graph[(saved.inputs.audio as [string, number])[0]]!;
    expect(sound.class_type).toBe("TrimAudioDuration");
    expect(sound.inputs.duration as number).toBeCloseTo(built.frames! / H3_FPS, 5);
    expect(of(graph, "AudioConcat")).toHaveLength(0);
  });

  it("keeps the model's own sound in the latent kept for the clips after", () => {
    const { built, graph } = build({}, recordingOf(5));
    const kept = built.outputs.find((o) => o.role === "latent");
    expect(kept).toBeDefined();
    expect(of(graph, "VAEDecodeAudio")).toHaveLength(1);
  });
});
