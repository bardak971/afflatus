import { describe, expect, it } from "vitest";
import { dryContext, isShown, laysSound, madeAroundRecording, parseInput, recordingSpecOf, type MediaFacts } from "@afflatus/core";
import { h3Video } from "../src/h3/video";
import { h3LipSync } from "../src/h3/lipsync";
import { H3_FPS } from "../src/h3/family";

/**
 * H3 · Video with audio under a recording it plays over (card #72): the clip lasts as long as its part, as a Lip sync clip
 * does, and its files carry the recording's part in place of H3's own sound; nothing guides the mouth with it.
 */
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "r.safetensors" };
const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };

const build = (over: Record<string, unknown>, media: Record<string, MediaFacts> = {}, uploads: Record<string, string> = {}) => {
  const input = parseInput(h3Video, { description: "She listens, her mouth closed, swaying gently to the music.", seconds: 10, ...over });
  const built = h3Video.build(input, dryContext({ slots, uploads: { recording: "rec.wav", ...uploads }, media }));
  return { built, graph: built.graph as Graph };
};
const soundOf = (b: ReturnType<typeof build>) => {
  const saved = b.graph[b.built.outputs.find((o) => o.role === "result")!.node]!;
  return b.graph[(saved.inputs.audio as [string, number])[0]]!;
};

describe("MiniMax H3 · Video with audio under a recording", () => {
  it("takes the recording under Lip sync's ids and window, never drawn on its form", () => {
    const mine = recordingSpecOf(h3Video.inputs)!;
    const lip = recordingSpecOf(h3LipSync.inputs)!;
    expect(mine.id).toBe(lip.id);
    expect({ ...mine.window, fits: { ...mine.window.fits, less: undefined } }).toEqual({ ...lip.window, fits: { ...lip.window.fits, less: undefined } });
    // its part is not shortened by a moment before the words: that is Lip sync's
    expect(mine.window.fits?.less).toBeUndefined();
    for (const id of ["recording", "recordingStart", "recordingSeconds", "evenLoudness", "recordingGoesOn", "recordingLeadIn"]) {
      const spec = h3Video.inputs.find((i) => i.id === id)!;
      expect(isShown(spec, { recording: "a1" }, h3Video.inputs), id).toBe(false);
    }
    expect(madeAroundRecording(h3Video.inputs)).toBe(false);
    expect(madeAroundRecording(h3LipSync.inputs)).toBe(true);
  });

  it("says its take's sound is laid only when it was sent a recording", () => {
    expect(laysSound(h3Video.inputs, { recording: "a1" })).toBe(true);
    expect(laysSound(h3Video.inputs, {})).toBe(false);
    expect(laysSound(h3Video.inputs)).toBe(false);
    // Lip sync's always is
    expect(laysSound(h3LipSync.inputs, {})).toBe(true);
  });

  it("without a recording is the clip it was: its own length (10 s on the grid) and its own sound", () => {
    const b = build({});
    expect(b.built.frames).toBe(243);
    expect(soundOf(b).class_type).toBe("VAEDecodeAudio");
    expect(of(b.graph, "LoadAudio")).toHaveLength(0);
    expect(h3Video.nodes(parseInput(h3Video, { description: "a" }))).not.toContain("TrimAudioDuration");
  });

  it("under a recording lasts as long as its part, whatever its Duration says", () => {
    // 5.9 s of the recording and a quarter second after it: 6.15 s, rounded up to 17k + 5 frames (158), as Lip sync makes it
    expect(build({ recording: "a1" }, { recording: { width: 0, height: 0, seconds: 5.9 } }).built.frames).toBe(158);
    const lip = h3LipSync.build(parseInput(h3LipSync, { description: "a", recording: "a1" }), dryContext({ slots, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9 } } }));
    expect(lip.frames).toBe(158);
  });

  it("files the recording's part as its sound to the clip's end, and guides nothing with it", () => {
    const b = build({ recording: "a1" }, { recording: { width: 0, height: 0, seconds: 5, after: 4 } });
    const sound = soundOf(b);
    expect(sound.class_type).toBe("TrimAudioDuration");
    expect(sound.inputs.start_index).toBe(0);
    expect(sound.inputs.duration as number).toBeCloseTo(b.built.frames! / H3_FPS, 5);
    expect(b.graph[(sound.inputs.audio as [string, number])[0]]).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "rec.wav" } });
    // no guide: the mouth does what What happens says
    expect(of(b.graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    // H3's own sound is still decoded, for the latent kept for the clips after
    expect(of(b.graph, "VAEDecodeAudio")).toHaveLength(1);
    expect(h3Video.nodes(parseInput(h3Video, { description: "a", recording: "a1" }))).toEqual(expect.arrayContaining(["LoadAudio", "TrimAudioDuration"]));
  });

  it("carrying on from a clip: H3's sound for the frames it shares with it, then the recording; all of it when that clip sang up to the part", () => {
    const head = build({ recording: "a1", previous: { asset: "c1" } }, { previous: joined, recording: { width: 0, height: 0, seconds: 4.2, after: 4 } }, { previous: "a.mp4" });
    const sound = soundOf(head);
    expect(sound.class_type).toBe("AudioConcat");
    const lead = head.graph[(sound.inputs.audio1 as [string, number])[0]]!;
    expect(lead.inputs.duration as number).toBeCloseTo(22 / H3_FPS, 5);
    const sung = build({ recording: "a1", previous: { asset: "c1" }, recordingLeadIn: true }, { previous: joined, recording: { width: 0, height: 0, seconds: 7.3, after: 4, before: 2 } }, { previous: "a.mp4" });
    const whole = soundOf(sung);
    expect(whole.class_type).toBe("TrimAudioDuration");
    expect(whole.inputs.start_index as number).toBeCloseTo(2 - 22 / H3_FPS, 5);
    expect(whole.inputs.duration as number).toBeCloseTo(sung.built.frames! / H3_FPS, 5);
    expect(of(sung.graph, "AudioConcat")).toHaveLength(0);
  });
});
