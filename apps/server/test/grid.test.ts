import { describe, expect, it } from "vitest";
import { hiddenRunUp } from "@afflatus/core";
import { spilled } from "../src/renderDigests";
import { joinFade, landingOnGrid, leadOf, lengthOnGrid, plays, sameMaking, seamless, type AssetRow, type TakeRow } from "../src/timelineModel";

/** The joins anchor on the model's own frame grid, not on an interpolated file's length (one frame short of it). */
describe("a take's length on the model's frame grid", () => {
  const asset = (over: Partial<AssetRow>) => ({ duration_ms: 5146, latent_frames: 124, ...over }) as AssetRow;
  it("an H3 render interpolated ×2 (247 frames at 48 a second) is 124 frames at 24: 5167 ms, not the file's 5146", () => {
    expect(lengthOnGrid(asset({}))).toBe(5167);
    const take = { head_ms: 0, trim_start_ms: 0, tail_ms: 0, trim_end_ms: 0 } as TakeRow;
    expect(plays({ take, asset: asset({}) }).end).toBe(5167);
  });
  it("an LTX 2.3 render on its own rate: 129 frames at 25 a second, 5160 ms; interpolated ×2 (257 at 50), still 5160", () => {
    const clock = '{"family":"ltx","fps":25,"step":8,"offset":1,"width":704,"height":1280}';
    expect(lengthOnGrid(asset({ duration_ms: 5160, latent_frames: 129, latent_clock: clock }))).toBe(5160);
    expect(lengthOnGrid(asset({ duration_ms: 5140, latent_frames: 129, latent_clock: clock }))).toBe(5160);
    // read on H3's rate it would have been 5375, far from the file: the file's length then
    expect(lengthOnGrid(asset({ duration_ms: 5160, latent_frames: 129 }))).toBe(5160);
  });
  it("without a latent, or a file that is not that render (trimmed, another length), the file's", () => {
    expect(lengthOnGrid(asset({ latent_frames: null }))).toBe(5146);
    expect(lengthOnGrid(asset({ duration_ms: 3000 }))).toBe(3000);
  });
});

/** The colour match runs between clips of the same making only: one enlarged in its render has a colour of its own. */
describe("two takes of the same making", () => {
  const sized = (width: number, height: number) => ({ width, height }) as AssetRow;
  it("the same size, or near it: matched", () => {
    expect(sameMaking(sized(576, 1024), sized(576, 1024))).toBe(true);
    expect(sameMaking(sized(576, 1024), sized(608, 1024))).toBe(true);
  });
  it("one enlarged ×2 in its render beside one that is not, or a size unknown: not matched", () => {
    expect(sameMaking(sized(1152, 2048), sized(576, 1024))).toBe(false);
    expect(sameMaking(sized(0, 0), sized(576, 1024))).toBe(false);
  });
});

/** A clip put before a take lands on it where one of its latent's 17-frame chunks begins (the tokens keep their time there). */
describe("where a clip lands on the take after it", () => {
  const take = (head: number, trim = 0) => ({ head_ms: head, trim_start_ms: trim, tail_ms: 0, trim_end_ms: 0 }) as TakeRow;
  const asset = { duration_ms: 5167, latent_frames: 124, latent_key: "l" } as AssetRow;
  it("from its first frame: there", () => expect(landingOnGrid({ take: take(0), asset }, 22)).toBe(0));
  it("a continuation playing from frame 22 (its overlap): frame 34, half a second further in", () => expect(landingOnGrid({ take: take(917), asset }, 22)).toBe(1417));
  it("already on a chunk: there", () => expect(landingOnGrid({ take: take(917, 500), asset }, 22)).toBe(1417));
  it("without a latent, an LTX one (landed on from its frames), or too near its end: where it plays", () => {
    expect(landingOnGrid({ take: take(917), asset: { ...asset, latent_key: null } as AssetRow }, 22)).toBe(917);
    expect(landingOnGrid({ take: take(1000), asset: { ...asset, latent_clock: '{"family":"ltx","fps":25,"step":8,"offset":1,"width":704,"height":1280}' } as AssetRow }, 25)).toBe(1000);
    expect(landingOnGrid({ take: take(917, 4000), asset }, 22)).toBe(4917);
  });
});

/** A take decoded as one piece with the clip before: a plain cut, the in-between frame of a ×2 render shown. */
describe("a seamless join", () => {
  const take = (join_kind: TakeRow["join_kind"]) => ({ head_ms: 917, trim_start_ms: 0, tail_ms: 0, trim_end_ms: 0, join_kind }) as TakeRow;
  const at = (fps: number) => ({ duration_ms: 5146, latent_frames: 124, fps }) as AssetRow;
  it("starts one of its frames early when interpolated ×2, and fades nothing", () => {
    const t = { take: take("seamless"), asset: at(48), seamed: true };
    expect(seamless(t)).toBe(true);
    // after another take than the one it was decoded with (or that one trimmed): not seamless, faded as any join
    expect(seamless({ take: take("seamless"), asset: at(48) })).toBe(false);
    expect(leadOf(t)).toBe(21);
    expect(joinFade(t, true)).toBeNull();
  });
  it("at the model's own 24 a second, no lead; landed on, or any other join, the fades as before", () => {
    expect(leadOf({ take: take("seamless"), asset: at(24), seamed: true })).toBe(0);
    expect(seamless({ take: take("seamless"), asset: at(48), landed: 167, seamed: true })).toBe(false);
    expect(leadOf({ take: take("latent"), asset: at(48) })).toBe(0);
    expect(joinFade({ take: take("pixels"), asset: at(48) }, true)).toEqual({ ms: 170, mode: "hold" });
  });
});

/** A run that ran out of video memory: the memory full AND at least twice what was expected (full memory alone is ComfyUI's habit). */
describe("ran out of video memory", () => {
  const run = (over: Partial<{ status: "done" | "failed" | "cancelled"; vram_peak: number | null; expected_ms: number | null; total_ms: number }>) => ({ status: "done" as const, vram_peak: 97, expected_ms: 360_000, total_ms: 1_080_000, ...over });
  it("memory full and three times the expected time: spilled; a stop counts, a failure does not", () => {
    expect(spilled(run({}))).toBe(true);
    expect(spilled(run({ status: "cancelled" }))).toBe(true);
    expect(spilled(run({ status: "failed" }))).toBe(false);
  });
  it("full memory at the usual pace, a slow run with memory to spare, or nothing expected: not spilled", () => {
    expect(spilled(run({ total_ms: 380_000 }))).toBe(false);
    expect(spilled(run({ vram_peak: 80 }))).toBe(false);
    expect(spilled(run({ expected_ms: null }))).toBe(false);
  });
});

describe("a finish's hidden run-up", () => {
  it("skips the shared frames short of what can ever show: the seamless frame early, the export's half frame, a margin", () => {
    // an H3 continuation: 917 ms shared, seen from 896 ms (one 48 fps frame early), the export from half a frame before that
    expect(hiddenRunUp(917)).toBe(792);
    expect(hiddenRunUp(917)).toBeLessThan(896 - 500 / 48);
    // nothing to skip on a first clip, or a run-up shorter than the margin
    expect(hiddenRunUp(0)).toBe(0);
    expect(hiddenRunUp(100)).toBe(0);
  });

  it("keeps an interpolated finish on its draft's grid when the frame count is carried over", () => {
    const asset = (o: Partial<AssetRow>) => ({ duration_ms: 5146, latent_frames: null, ...o }) as AssetRow;
    // the draft: 2N − 1 frames at 48 a second, its length on the model's grid one frame longer
    expect(lengthOnGrid(asset({ latent_frames: 124 }))).toBe(5167);
    // its finish without the frame count played one frame short: the seamless join after it skipped that frame
    expect(lengthOnGrid(asset({}))).toBe(5146);
  });
});
