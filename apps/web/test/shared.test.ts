import { describe, expect, it } from "vitest";
import { est, leftWords, size } from "../src/format";
import { slug as presetSlug } from "../src/presetFile";
import { unloadBlock } from "../src/queueRules";
import { seedvrBatch } from "../src/snap";
import { clipsOf, timelineOf } from "../src/timelineOf";

describe("a timeline made of items, the one way", () => {
  const picture = { id: "p", kind: "image" };
  const video = { id: "v", kind: "video" };

  it("puts them at the end in order; a picture first is clip 1's first frame only when asked", () => {
    expect(clipsOf({ assets: [picture, video, picture] })).toEqual([{ asset: "p" }, { asset: "v" }, { asset: "p" }]);
    expect(clipsOf({ assets: [picture, picture], firstAsClip: true })).toEqual([{ asset: "p", as: "clip" }, { asset: "p" }]);
    expect(clipsOf({ assets: [video, picture], firstAsClip: true })).toEqual([{ asset: "v" }, { asset: "p" }]);
  });

  it("makes a timeline only when none is given, and adds one after the other", async () => {
    const calls: string[] = [];
    const io = {
      create: async () => (calls.push("create"), { id: "t-new", name: "Timeline 3" }),
      add: async (t: string, body: { asset: string }) => void calls.push(`${t}+${body.asset}`),
      music: async (t: string, asset: string) => void calls.push(`${t}♪${asset}`),
    };
    expect(await timelineOf({ assets: [video, picture] }, io)).toEqual({ id: "t-new", name: "Timeline 3" });
    expect(await timelineOf({ assets: [picture], into: { id: "t1", name: "Trip" } }, io)).toEqual({ id: "t1", name: "Trip" });
    expect(calls).toEqual(["create", "t-new+v", "t-new+p", "t1+p"]);
  });

  it("makes a sound the timeline's music, the video track taking none", async () => {
    const sound = { id: "s", kind: "audio" };
    expect(clipsOf({ assets: [video, sound, picture] })).toEqual([{ asset: "v" }, { music: "s" }, { asset: "p" }]);
    const calls: string[] = [];
    const io = {
      create: async () => ({ id: "t-new", name: "Timeline 3" }),
      add: async (t: string, body: { asset: string }) => void calls.push(`${t}+${body.asset}`),
      music: async (t: string, asset: string) => void calls.push(`${t}♪${asset}`),
    };
    await timelineOf({ assets: [sound, video], into: { id: "t1", name: "Trip" } }, io);
    expect(calls).toEqual(["t1♪s", "t1+v"]);
  });

  it("stops at the first refusal, unless each is said on its own and the rest still go", async () => {
    const calls: string[] = [];
    const io = {
      create: async () => ({ id: "t-new", name: "Timeline 3" }),
      add: async (t: string, body: { asset: string }) => {
        if (body.asset === "v") throw new Error("refused");
        calls.push(`${t}+${body.asset}`);
      },
      music: async () => {},
    };
    await expect(timelineOf({ assets: [video, picture], into: { id: "t1", name: "Trip" } }, io)).rejects.toThrow("refused");
    expect(calls).toEqual([]);
    const refused: string[] = [];
    expect(await timelineOf({ assets: [video, picture], into: { id: "t1", name: "Trip" }, refused: (a, err) => refused.push(`${a.id}: ${err.message}`) }, io)).toEqual({ id: "t1", name: "Trip" });
    expect(calls).toEqual(["t1+p"]);
    expect(refused).toEqual(["v: refused"]);
  });
});

describe("Unload, one rule wherever it is asked", () => {
  it("is off while ComfyUI is offline or any job runs", () => {
    expect(unloadBlock({ online: true, running: null })).toBeNull();
    expect(unloadBlock({ online: false, running: null })).toBe("ComfyUI is offline");
    expect(unloadBlock({ online: true, running: { kind: "load" } })).toBe("not while a job runs");
    expect(unloadBlock({ online: true, running: { kind: "render" } })).toBe("not while a job runs");
    expect(unloadBlock(undefined)).toBe("ComfyUI is offline");
  });
});

describe("SeedVR2's batch size", () => {
  it("is 0 (auto) or on the 4n + 1 grid up to 49, which steps of 4 from 0 never reached", () => {
    expect(seedvrBatch(0)).toBe(0);
    expect(seedvrBatch(-3)).toBe(0);
    expect(seedvrBatch(1)).toBe(1);
    expect(seedvrBatch(4)).toBe(5);
    expect(seedvrBatch(8)).toBe(9);
    expect(seedvrBatch(48)).toBe(49);
    expect(seedvrBatch(49)).toBe(49);
    expect(seedvrBatch(80)).toBe(49);
  });
});

describe("the shared words", () => {
  it("names a preset's file with its accents folded", () => {
    expect(presetSlug("Crème brûlée")).toBe("creme-brulee");
    expect(presetSlug("夜の街")).toBe("preset");
  });
  it("says a guessed time, the time before the bin and a size alike everywhere", () => {
    expect(est(5_000)).toBe("~5 s");
    expect(est(null)).toBe("");
    expect(leftWords(40 * 60_000)).toBe("40 min");
    expect(leftWords(3.5 * 3_600_000, true)).toBe("4 h");
    expect(size(1)).toBe("1 KB");
    expect(size(0)).toBe("0 KB");
    expect(size(12.34 * 2 ** 20)).toBe("12 MB");
  });
});
