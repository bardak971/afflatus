import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { h3Video } from "../src/h3/video";
import { h3LipSync } from "../src/h3/lipsync";
import { h3Swap } from "../src/h3/swap";
import { CUE_SOUND } from "../src/h3/cue";
import { H3_FPS } from "../src/h3/family";

type Ref = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "r.safetensors" };
const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
const cueFacts = (seconds: number): MediaFacts => ({ width: 0, height: 0, seconds });

const door = { asset: "s1", start: 0.1, seconds: 0.6, at: 2.4 };
const cheer = { asset: "s2", start: 3, seconds: 1.5, at: 0 };

const buildVideo = (over: Record<string, unknown>, media: Record<string, MediaFacts> = {}, uploads: Record<string, string> = {}) => {
  const input = parseInput(h3Video, { description: "She claps her hands once.", ...over });
  const built = h3Video.build(input, dryContext({ slots, uploads: { "cues.0": "door.wav", "cues.1": "cheer.wav", ...uploads }, media: { "cues.0": cueFacts(0.6), "cues.1": cueFacts(1.5), ...media } }));
  return built.graph as Graph;
};

/**
 * The sound a graph files, worked out from its audio nodes as ComfyUI's own do it (comfy_extras/nodes_audio.py, read
 * 2026-10-25): TrimAudioDuration cuts by rounded samples and refuses an empty stretch, AudioConcat appends, AudioMerge pads
 * or trims its second sound to the first and scales the sum down when it clips. One channel at a low rate is enough here.
 */
const RATE = 1000;
function soundOf(graph: Graph, sounds: { decoded: number[]; files: Record<string, number[]> }): number[] {
  const at = (ref: unknown): number[] => {
    const node = graph[(ref as Ref)[0]]!;
    const i = node.inputs;
    switch (node.class_type) {
      case "VAEDecodeAudio": return sounds.decoded;
      case "LoadAudio": return sounds.files[String(i.audio)]!;
      case "TrimAudioDuration": {
        const wave = at(i.audio);
        const from = Math.max(0, Math.min(Math.round(Number(i.start_index) * RATE), wave.length));
        const to = Math.max(0, Math.min(from + Math.round(Number(i.duration) * RATE), wave.length));
        if (from >= to) throw new Error("TrimAudioDuration: Start time must be less than end time and be within the audio length.");
        return wave.slice(from, to);
      }
      case "AudioConcat": return i.direction === "after" ? [...at(i.audio1), ...at(i.audio2)] : [...at(i.audio2), ...at(i.audio1)];
      case "AudioMerge": {
        const a = at(i.audio1);
        const b = at(i.audio2);
        const sum = a.map((v, k) => v + (b[k] ?? 0));
        const peak = Math.max(...sum.map(Math.abs));
        return peak > 1 ? sum.map((v) => v / peak) : sum;
      }
      default: throw new Error(`no sound from ${node.class_type}`);
    }
  };
  const out = Object.values(graph).find((n) => (n.class_type === "VHS_VideoCombine" || n.class_type === "CreateVideo") && n.inputs.audio)!;
  return at(out.inputs.audio);
}

/** Correlation of two stretches of the same length. */
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let k = 0; k < n; k++) {
    ab += (a[k]! - ma) * (b[k]! - mb);
    aa += (a[k]! - ma) ** 2;
    bb += (b[k]! - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

/** A repeatable noise, quiet enough that two added never clip. */
function noise(seconds: number, seed: number, level = 0.2): number[] {
  let x = seed;
  return Array.from({ length: Math.round(seconds * RATE) }, () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return (x / 2 ** 31 - 0.5) * 2 * level;
  });
}

describe("H3 sound cues", () => {
  it("are on every H3 form, under the keyframe, with whose sound the take keeps after them", () => {
    for (const recipe of [h3Video, h3LipSync, h3Swap]) {
      const ids = recipe.inputs.map((i) => i.id);
      expect(ids, recipe.id).toContain("cues");
      expect(ids.indexOf("cueSound"), recipe.id).toBe(ids.indexOf("cues") + 1);
    }
    const ids = h3Video.inputs.map((i) => i.id);
    expect(ids.indexOf("cues")).toBe(ids.indexOf("midAt") + 1);
    expect(h3Video.inputs.find((i) => i.id === "cueSound")).toMatchObject({ type: "choice", default: "The file's sound", options: [...CUE_SOUND], showWhen: "cues" });
  });

  it("pins each cue's part alone (no picture) at its frame, counted after the frames of the clip before", () => {
    const graph = buildVideo({ previous: { asset: "c1" }, cues: [door, cheer] }, { previous: joined }, { previous: "a.mp4" });
    const guides = of(graph, "MiniMaxH3AddGuide").filter((n) => n.inputs.audio && !n.inputs.image);
    expect(guides.map((n) => n.inputs.frame_idx)).toEqual([22 + Math.round(2.4 * H3_FPS), 22]);
    // each guide hears its own part, loaded from its upload and fitted to the clip
    const heard = guides.map((n) => {
      const trim = graph[(n.inputs.audio as Ref)[0]]!;
      return [graph[(trim.inputs.audio as Ref)[0]]!.inputs.audio, trim.inputs.duration];
    });
    expect(heard).toEqual([["door.wav", 0.6], ["cheer.wav", 1.5]]);
    // the sampled clip follows them
    const guider = of(graph, "BasicGuider")[0]!;
    expect(graph[(guider.inputs.conditioning as Ref)[0]]).toBe(guides[1]);
  });

  it("refuses a cue that lands past the clip's end, in words", () => {
    // 5 s asked is 124 frames on H3's grid: 5.17 s of its own
    expect(buildVideo({ seconds: 5, cues: [{ ...door, at: 5 }] })).toBeTruthy();
    expect(() => buildVideo({ seconds: 5, cues: [{ ...door, at: 5.25 }] })).toThrow(/Sound cue 1 lands at 5.25 s, past the clip's end \(5.17 s\)/);
    // the frames it lands on of the clip after are added past its own end: they are that clip's, not a moment of this one
    expect(() => buildVideo({ seconds: 5, next: { asset: "n1" }, cues: [door, { ...door, at: 5.25 }] }, { next: joined }, { next: "b.mp4" })).toThrow(/Sound cue 2 lands at 5.25 s/);
  });

  it("cuts a cue that runs past the clip's end at the end", () => {
    const graph = buildVideo({ seconds: 5, cues: [{ ...door, seconds: 1.5, at: 4.5 }] }, { "cues.0": cueFacts(1.5) });
    const guide = of(graph, "MiniMaxH3AddGuide").find((n) => n.inputs.audio)!;
    const own = Math.round(5 * H3_FPS) / H3_FPS;
    expect(Number(graph[(guide.inputs.audio as Ref)[0]]!.inputs.duration)).toBeLessThan(own - 4.5 + 0.2);
  });

  it("lays each cue's part into the file's sound at its moment, in place of H3's own there", () => {
    const graph = buildVideo({ seconds: 5, cues: [door, cheer] });
    const frames = of(graph, "MiniMaxH3ImageToVideo")[0]!.inputs.length as number;
    const decoded = noise(frames / H3_FPS, 1);
    const files = { "door.wav": noise(0.6, 2, 0.5), "cheer.wav": noise(1.5, 3, 0.5) };
    const sound = soundOf(graph, { decoded, files });
    // as long as the clip: nothing shifted after a cue
    expect(sound.length).toBe(decoded.length);
    const stretch = (from: number, seconds: number) => sound.slice(Math.round(from * RATE), Math.round((from + seconds) * RATE));
    const landsAt = Math.round(2.4 * H3_FPS) / H3_FPS;
    expect(corr(stretch(landsAt, 0.6), files["door.wav"])).toBeGreaterThan(0.99);
    expect(corr(stretch(0, 1.5), files["cheer.wav"])).toBeGreaterThan(0.99);
    // H3's own sound everywhere else, at its own place
    expect(corr(stretch(1.6, 0.7), decoded.slice(1600, 2300))).toBeGreaterThan(0.99);
    expect(corr(stretch(3.2, 1.5), decoded.slice(3200, 4700))).toBeGreaterThan(0.99);
  });

  it("keeps H3's own sound with H3's own asked for: the cue only guides", () => {
    const graph = buildVideo({ cues: [door], cueSound: "H3's own" });
    expect(of(graph, "MiniMaxH3AddGuide").some((n) => n.inputs.audio)).toBe(true);
    expect(of(graph, "AudioConcat")).toHaveLength(0);
    const frames = of(graph, "MiniMaxH3ImageToVideo")[0]!.inputs.length as number;
    const decoded = noise(frames / H3_FPS, 1);
    expect(soundOf(graph, { decoded, files: {} })).toEqual(decoded);
  });

  it("adds a cue over a lip sync's recording, which plays on under it unchanged", () => {
    const input = parseInput(h3LipSync, { description: "a café terrace", start: "p1", recording: "a1", cues: [door] });
    const graph = h3LipSync.build(input, dryContext({ slots, uploads: { start: "a.png", recording: "rec.wav", "cues.0": "door.wav" }, media: { start: { width: 832, height: 1216 }, recording: { width: 0, height: 0, seconds: 5.9, after: 4 }, "cues.0": cueFacts(0.6) } })).graph as Graph;
    expect(of(graph, "AudioMerge")).toHaveLength(1);
    const frames = of(graph, "MiniMaxH3ImageToVideo")[0]!.inputs.length as number;
    const recording = noise(5.9 + 4, 7);
    const files = { "rec.wav": recording, "door.wav": noise(0.6, 2) };
    const sound = soundOf(graph, { decoded: noise(frames / H3_FPS, 1), files });
    const landsAt = Math.round(Math.round(2.4 * H3_FPS) / H3_FPS * RATE);
    // the recording is the sound before and after the cue, exactly; at the cue, the recording and the cue added
    expect(sound.slice(0, landsAt)).toEqual(recording.slice(0, landsAt));
    expect(sound.slice(landsAt + 600, landsAt + 2000)).toEqual(recording.slice(landsAt + 600, landsAt + 2000));
    const mixed = recording.slice(landsAt, landsAt + 600).map((v, k) => v + files["door.wav"][k]!);
    expect(corr(sound.slice(landsAt, landsAt + 600), mixed)).toBeGreaterThan(0.999);
  });

  it("adds a cue over the recording a Video with audio clip plays under, which plays on under it unchanged", () => {
    const input = parseInput(h3Video, { description: "She listens and claps once.", recording: "a1", cues: [door] });
    const graph = h3Video.build(input, dryContext({ slots, uploads: { recording: "rec.wav", "cues.0": "door.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 }, "cues.0": cueFacts(0.6) } })).graph as Graph;
    expect(of(graph, "AudioMerge")).toHaveLength(1);
    const frames = of(graph, "MiniMaxH3ImageToVideo")[0]!.inputs.length as number;
    const recording = noise(5.9 + 4, 7);
    const files = { "rec.wav": recording, "door.wav": noise(0.6, 2) };
    const sound = soundOf(graph, { decoded: noise(frames / H3_FPS, 1), files });
    const landsAt = Math.round(Math.round(2.4 * H3_FPS) / H3_FPS * RATE);
    expect(sound.slice(0, landsAt)).toEqual(recording.slice(0, landsAt));
    expect(sound.slice(landsAt + 600, landsAt + 2000)).toEqual(recording.slice(landsAt + 600, landsAt + 2000));
    expect(h3Video.nodes(input)).toContain("AudioMerge");
  });

  it("asks ComfyUI for the nodes the cues add, and AudioMerge only where a cue is added over a file", () => {
    expect(h3Video.nodes(parseInput(h3Video, { description: "a", cues: [door] }))).toEqual(expect.arrayContaining(["LoadAudio", "TrimAudioDuration", "MiniMaxH3AddGuide", "AudioConcat"]));
    expect(h3Video.nodes(parseInput(h3Video, { description: "a", cues: [door] }))).not.toContain("AudioMerge");
    expect(h3Video.nodes(parseInput(h3Video, { description: "a", cues: [door], cueSound: "H3's own" }))).not.toContain("AudioConcat");
    expect(h3LipSync.nodes(parseInput(h3LipSync, { description: "a", recording: "a1", cues: [door] }))).toContain("AudioMerge");
  });

  it("keeps a source's windows' cues each its own, as their prompts", () => {
    expect(h3Swap.traits?.windows?.own).toContain("cues");
  });
});
