import { beforeAll, describe, expect, it } from "vitest";
import { gridAtOrBefore, parseInput, sourceWindows, type Recipe } from "@afflatus/core";
import { recipeById, scailMotion } from "@afflatus/recipes";
import { referenceClip } from "../src/cut";
import { windowRunUp, windowsOf } from "../src/timelineSource";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";

/**
 * A window of a source made a cut, and made to carry on again (windowRunUp): the frames its part holds, cut by ffmpeg at
 * the model's speed as a render cuts it (referenceClip), and where it ends, which the window after carries on from.
 */

const GRID = { step: 4, offset: 1 };
const RECIPES = [scailMotion] as Recipe<any>[];

/** The windows of 40 s of a source, those that carry on. */
const carrying = (recipe: Recipe<any>, windowMs: number) =>
  sourceWindows({ fromMs: 1000, toMs: 41_000, windowMs, shape: windowsOf(recipe)! }).filter((w) => !w.opens);
const form = (w: { start: number; seconds: number }) => ({ drivingStart: w.start, drivingSeconds: w.seconds });

describe("a window of a source made a cut", () => {
  it("makes the frames on the model's grid that follow the ones it shows, ending where it ended; carrying on again, it is as it was", () => {
    for (const recipe of RECIPES) {
      const { fps, carried } = windowsOf(recipe)!;
      for (const windowMs of [1000, 2500, 3400, 5000, 12_000, 20_000]) {
        for (const w of carrying(recipe, windowMs)) {
          const shown = Math.round(((w.toMs - w.fromMs) * fps) / 1000);
          const cut = windowRunUp(recipe, form(w), "cut")!;
          const frames = Math.round((cut.drivingSeconds as number) * fps - 0.5);
          // on the grid: the shown frames and the carried ones' remainder (SCAIL-2: 5 carried, 1 more)
          expect((frames - 1) % 4).toBe(0);
          expect(frames - shown).toBe(carried % 4);
          // held to end where the window ends: the window after carries on from there
          expect(((cut.drivingStart as number) + frames / fps) * 1000).toBeCloseTo(w.toMs, -1);
          expect(Math.abs((cut.drivingStart as number) + frames / fps - (w.start + (shown + carried) / fps))).toBeLessThan(1e-3);
          // the form takes it
          expect(() => parseInput(recipe, { picture: "p1", driving: { asset: "v1" }, ...cut })).not.toThrow();
          // carrying on again: exactly as it was
          const again = windowRunUp(recipe, cut, "continue")!;
          expect(again.drivingStart).toBe(w.start);
          expect(again.drivingSeconds).toBe(w.seconds);
        }
      }
    }
  });

  it("on H3's grid, coarser than the 5 frames carried: made a cut, starts past them (not playing them again) and ends where the window ends", () => {
    const swap = recipeById("h3.swap")!;
    const { fps, carried } = windowsOf(swap)!;
    for (const windowMs of [4250, 5000, 5800]) {
      const windows = sourceWindows({ fromMs: 1000, toMs: 41_000, windowMs, shape: windowsOf(swap)! }).filter((w) => !w.opens);
      expect(windows.length).toBeGreaterThan(2);
      for (const w of windows) {
        const inputs = { who: "the man", source: { asset: "v1" }, sourceStart: w.start, sourceSeconds: w.seconds };
        const cut = windowRunUp(swap, inputs, "cut")!;
        const frames = Math.round((cut.sourceSeconds as number) * fps - 0.5);
        expect(((cut.sourceStart as number) - w.start) * fps).toBeGreaterThanOrEqual(carried - 1e-6);
        expect(((cut.sourceStart as number) + frames / fps) * 1000).toBeCloseTo(w.start * 1000 + (Math.round(w.seconds * fps - 0.5) * 1000) / fps, 0);
        expect(() => parseInput(swap, cut)).not.toThrow();
        const again = windowRunUp(swap, cut, "continue")!;
        expect(again.sourceStart).toBe(w.start);
        expect(again.sourceSeconds).toBe(w.seconds);
      }
    }
  });

  it("is refused for a part that would start before the video, and for a recipe not made window by window", () => {
    expect(windowRunUp(scailMotion, { drivingStart: 0.1, drivingSeconds: 85.5 / 16 }, "continue")).toBeNull();
    expect(windowRunUp(undefined, { drivingStart: 3, drivingSeconds: 5 }, "cut")).toBeNull();
  });
});

describe.skipIf(!ffmpegThere)("a window's part as ffmpeg cuts it", { timeout: FFMPEG_TIMEOUT }, () => {
  let source: Uint8Array;
  beforeAll(async () => void (source = await patternClip(24, { fps: 30, sound: false })), FFMPEG_TIMEOUT);

  it("holds exactly the frames on the grid the model makes: carrying on, made a cut, and carrying on again", async () => {
    for (const recipe of RECIPES) {
      const { fps } = windowsOf(recipe)!;
      const windows = sourceWindows({ fromMs: 1000, toMs: 21_000, windowMs: recipe === scailMotion ? 5000 : 3400, shape: windowsOf(recipe)! }).filter((w) => !w.opens).slice(0, 3);
      for (const w of windows) {
        const planned = Math.round((w.seconds * fps) - 0.5);
        const cut = windowRunUp(recipe, form(w), "cut")!;
        const parts = [
          { start: w.start, seconds: w.seconds, frames: planned },
          { start: cut.drivingStart as number, seconds: cut.drivingSeconds as number, frames: Math.round((cut.drivingSeconds as number) * fps - 0.5) },
        ];
        for (const p of parts) {
          const clip = await referenceClip(source, "mp4", { start: p.start, seconds: p.seconds, fps, short: 192 });
          // what the job makes of it (motionFrames: floored to the grid): the frames planned, not one more nor three fewer
          expect(gridAtOrBefore(clip.frames, GRID)).toBe(p.frames);
          expect(clip.frames - p.frames).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
