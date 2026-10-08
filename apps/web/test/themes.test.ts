import { describe, expect, it } from "vitest";
import { contrast, LEGIBLE, legible, THEMES, tokensOf } from "../src/theme/themes";

describe("the themes' text", () => {
  // every theme, with every accent it offers: the inks and the accent (links, picked items) read on the panels and on the page
  for (const theme of THEMES) {
    it(`reads on ${theme.name}`, () => {
      for (const accent of Object.keys(theme.accents)) {
        const t = tokensOf(theme, accent);
        for (const ink of ["ink", "ink-2", "ink-3", "accent"] as const) {
          for (const on of ["panel", "ground"] as const) {
            expect(contrast(t[ink], t[on]), `${theme.id} ${accent}: ${ink} on ${on}`).toBeGreaterThanOrEqual(LEGIBLE);
          }
        }
        // what is written on the accent reads too
        expect(contrast(t["accent-ink"], t.accent), `${theme.id} ${accent}: on the accent`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("leaves a colour that reads as it is, and darkens one that does not on a light ground", () => {
    expect(legible("#000000", ["#ffffff"], true)).toBe("#000000");
    const pale = legible("#df8e1d", ["#e6e9ef"], true);
    expect(contrast(pale, "#e6e9ef")).toBeGreaterThanOrEqual(LEGIBLE);
    expect(pale).not.toBe("#df8e1d");
  });
  it("keeps the Afflatus theme's own colours", () => {
    const t = tokensOf(THEMES[0]!, "amber");
    expect(t.accent).toBe("#f5c451");
    expect(t["ink-2"]).toBe("#a3acb9");
  });
});
