import { describe, expect, it } from "vitest";
import { parseInput, sourceWindows, windowBounds, windowShapeOf, type InputSpec, type Recipe } from "@afflatus/core";
import { recipes } from "../src/index";

/**
 * The recipes that make a long source window by window, with the form inputs a window's part goes in: one for each run-up
 * its form takes (H3's 5, 22 and 39 frames), the source cut for it.
 */
const windowed = recipes.flatMap((r: Recipe<any>) => {
  const w = r.traits?.windows;
  const driving = r.inputs.find((i: InputSpec) => i.type === "clip" && i.role === "source" && i.window);
  if (!w || !driving || driving.type !== "clip" || !driving.window) return [];
  const forms: Record<string, unknown>[] = w.runUp ? w.runUp.counts.map((n) => ({ [w.runUp!.input]: String(n) })) : [{}];
  return forms.map((form) => ({ recipe: r, form, shape: windowShapeOf(r, form)!, driving: driving.id, ...driving.window! }));
});
/** What else each form needs to parse: a picture, the person to replace, the cast's photo. */
const BASE: Record<string, Record<string, unknown>> = {
  "scail.motion": { picture: "p1" },
  "scail.motion24": { picture: "p1" },
  "h3.swap": { who: "the man", references: [{ asset: "r1", role: "person" }] },
  "h3.motion": { picture: "p1" },
};

describe("every window a timeline makes of a source", () => {
  it("is one its recipe's form takes: first, carrying on, after a scene cut, the last, at every window length", () => {
    expect([...new Set(windowed.map((w) => w.recipe.id))].sort()).toEqual(Object.keys(BASE).sort());
    for (const { recipe, form, shape, driving, start, seconds } of windowed) {
      let made = 0;
      for (const fromMs of [0, 1500, 3000]) {
        for (const toMs of [7000, 11_000, 15_500, 20_000, 26_000, 30_000, 61_500]) {
          for (let windowMs = 1000; windowMs <= 8000; windowMs += 250) {
            for (const cutsMs of [[], [7300, 15_100, 40_000], [4100, 9000]]) {
              for (const w of sourceWindows({ fromMs, toMs, windowMs, shape, cutsMs })) {
                made++;
                const input = { ...BASE[recipe.id], ...form, [driving]: { asset: "v1" }, [start]: w.start, [seconds]: w.seconds };
                expect(() => parseInput(recipe, input), `${recipe.id} ${fromMs}–${toMs} in ${windowMs} ms: ${JSON.stringify(w)}`).not.toThrow();
              }
            }
          }
        }
      }
      expect(made).toBeGreaterThan(1000);
    }
  });

  it("covers the stretch to within the fewest frames a job takes: windows too short for the recipe do not drop the rest", () => {
    for (const { shape } of windowed) {
      const { leastMs } = windowBounds(shape);
      for (let windowMs = 1000; windowMs <= 8000; windowMs += 250) {
        const w = sourceWindows({ fromMs: 0, toMs: 30_000, windowMs, shape });
        // what is left after the last window is shorter than a window that carries on could be
        expect(30_000 - w.at(-1)!.toMs).toBeLessThan(leastMs + (shape.carried * 1000) / shape.fps);
      }
    }
  });
});

describe("a source dropped on a timeline with nothing to say its model", () => {
  it("is made with the first recipe named a source's default (the swap): the timeline names no recipe of its own", () => {
    expect(recipes.find((r: Recipe<any>) => r.traits?.windows?.sourceDefault)?.id).toBe("h3.swap");
  });
});
