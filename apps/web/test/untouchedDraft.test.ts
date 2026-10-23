import { describe, expect, it } from "vitest";
import { untouchedMovesTo } from "../src/screens/studio/CreatePanel";

// a new install's first draft opens on the first family's recipe (SDXL); switched off in Settings › Models, it stayed in
// Create's model list, held there by that untouched draft (the owner, 2026-10-23)
describe("a draft nothing was done in, on a family switched off", () => {
  const sdxl = { id: "sdxl.text-to-picture", family: "sdxl" };
  const krea = { id: "krea2.text-to-picture", family: "krea2" };
  const on = (off: string[]) => (family: string) => !off.includes(family);
  it("moves to the first recipe of a family that is on", () => {
    expect(untouchedMovesTo({ empty: true }, sdxl, krea, on(["sdxl"]))).toBe(krea.id);
  });
  it("stays when something was done in it, when its family is on, or when there is nowhere else", () => {
    expect(untouchedMovesTo({ empty: false }, sdxl, krea, on(["sdxl"]))).toBeNull();
    expect(untouchedMovesTo({ empty: true }, sdxl, krea, on([]))).toBeNull();
    expect(untouchedMovesTo({ empty: true }, sdxl, sdxl, on(["sdxl"]))).toBeNull();
    expect(untouchedMovesTo({ empty: true }, sdxl, krea, on(["sdxl", "krea2"]))).toBeNull();
    expect(untouchedMovesTo(undefined, sdxl, krea, on(["sdxl"]))).toBeNull();
  });
});
