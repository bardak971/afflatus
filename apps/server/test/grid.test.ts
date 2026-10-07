import { describe, expect, it } from "vitest";
import { lengthOnGrid, plays, type AssetRow, type TakeRow } from "../src/timelineModel";

/** The joins anchor on the model's own frame grid, not on an interpolated file's length (one frame short of it). */
describe("a take's length on the model's frame grid", () => {
  const asset = (over: Partial<AssetRow>) => ({ duration_ms: 5146, latent_frames: 124, ...over }) as AssetRow;
  it("an H3 render interpolated ×2 (247 frames at 48 a second) is 124 frames at 24: 5167 ms, not the file's 5146", () => {
    expect(lengthOnGrid(asset({}))).toBe(5167);
    const take = { head_ms: 0, trim_start_ms: 0, tail_ms: 0, trim_end_ms: 0 } as TakeRow;
    expect(plays({ take, asset: asset({}) }).end).toBe(5167);
  });
  it("without a latent, or a file that is not that render (trimmed, another length), the file's", () => {
    expect(lengthOnGrid(asset({ latent_frames: null }))).toBe(5146);
    expect(lengthOnGrid(asset({ duration_ms: 3000 }))).toBe(3000);
  });
});
