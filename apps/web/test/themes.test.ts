import { describe, expect, it } from "vitest";
import { contrast, FAMILIES, hueGap, LEGIBLE, legible, themeById, THEMES, tokensOf, WARN_GAP } from "../src/theme/themes";

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
        // what is written on the accent reads too, and a notice's text on its wash
        expect(contrast(t["accent-ink"], t.accent), `${theme.id} ${accent}: on the accent`).toBeGreaterThanOrEqual(3);
        expect(contrast(t["warn-ink"], t["warn-wash"]), `${theme.id} ${accent}: warn-ink on its wash`).toBeGreaterThanOrEqual(LEGIBLE);
      }
    });
  }

  it("leaves a colour that reads as it is, and darkens one that does not on a light ground", () => {
    expect(legible("#000000", ["#ffffff"], true)).toBe("#000000");
    const pale = legible("#df8e1d", ["#e6e9ef"], true);
    expect(contrast(pale, "#e6e9ef")).toBeGreaterThanOrEqual(LEGIBLE);
    expect(pale).not.toBe("#df8e1d");
  });
  it("starts on Studio Dark with the coral of the app's mark", () => {
    expect(THEMES[0]!.id).toBe("studio");
    expect(tokensOf(THEMES[0]!, undefined).accent).toBe("#ff9a73");
    expect(themeById("afflatus").id).toBe("studio");
  });
  it("keeps green status text readable on every theme", () => {
    for (const theme of THEMES) {
      const t = tokensOf(theme, undefined);
      for (const on of ["panel", "raised", "ground"] as const) expect(contrast(t.good, t[on]), `${theme.id}: good on ${on}`).toBeGreaterThanOrEqual(LEGIBLE);
    }
  });
});

describe("the warning beside a warm accent", () => {
  const warnOf = (id: string, accent: string) => tokensOf(themeById(id), accent).warn;
  it("measures hues round the wheel", () => {
    expect(hueGap("#ff0000", "#ff0000")).toBe(0);
    expect(hueGap("#ff0000", "#00ffff")).toBe(180);
    // red (0) and a red with a touch of blue (about 350) are close, across 0
    expect(hueGap("#ff0000", "#ff002b")).toBeLessThan(15);
  });
  it("keeps the theme's own warning beside an accent of another hue", () => {
    expect(warnOf("mocha", "mauve")).toBe("#fab387");
    expect(warnOf("rose-pine", "iris")).toBe("#eb6f92");
  });
  it("turns to the family's red beside a peach, yellow or rosewater accent", () => {
    for (const accent of ["peach", "yellow", "rosewater"]) {
      expect(warnOf("mocha", accent), accent).toBe("#f38ba8");
      expect(warnOf("latte", accent), accent).toBe("#d20f39");
    }
    // beside Studio's coral, its red
    expect(warnOf("studio", "coral")).toBe("#f06a72");
    // beside love, or rose, Rosé Pine's warning is its gold
    expect(warnOf("rose-pine", "love")).toBe("#f6c177");
    expect(warnOf("rose-pine-dawn", "rose")).toBe("#ea9d34");
  });
  it("carries the switch to the warning's wash and ink", () => {
    const own = tokensOf(themeById("mocha"), "mauve");
    const peach = tokensOf(themeById("mocha"), "peach");
    expect(peach["warn-wash"]).not.toBe(own["warn-wash"]);
    expect(peach["warn-ink"]).not.toBe(own["warn-ink"]);
  });
  it("never leaves a warning nearer the accent than another of the family could be", () => {
    for (const theme of THEMES) {
      for (const [name, colour] of Object.entries(theme.accents)) {
        const warn = tokensOf(theme, name).warn;
        if (hueGap(colour, warn) >= WARN_GAP) continue;
        for (const alert of theme.alerts) expect(hueGap(colour, warn), `${theme.id} ${name}`).toBeGreaterThanOrEqual(hueGap(colour, alert));
      }
    }
  });
});

describe("the theme list", () => {
  it("has a dark and a light theme in every family, the new ones among them", () => {
    for (const family of Object.keys(FAMILIES)) {
      expect(THEMES.some((t) => t.family === family && !t.light), `${family} dark`).toBe(true);
      expect(THEMES.some((t) => t.family === family && t.light), `${family} light`).toBe(true);
    }
    const dark = THEMES.filter((t) => !t.light).map((t) => t.id);
    const light = THEMES.filter((t) => t.light).map((t) => t.id);
    expect(dark).toEqual(expect.arrayContaining(["studio", "tokyo-night", "kanagawa-wave"]));
    expect(light).toEqual(expect.arrayContaining(["studio-light", "tokyo-night-day", "kanagawa-lotus"]));
  });
  it("shows pictures on a dark stage in every theme", () => {
    for (const theme of THEMES) {
      const t = tokensOf(theme, undefined);
      // near black: far nearer black than white, and well darker than the page
      expect(contrast(t.stage, "#000000"), theme.id).toBeLessThan(1.5);
      if (theme.light) expect(themeById(theme.stage!).light, theme.id).toBe(false);
    }
  });
  it("lifts a light theme's cards off its page", () => {
    for (const theme of THEMES.filter((t) => t.light)) expect(contrast(theme.base.panel, "#ffffff"), theme.id).toBeLessThan(contrast(theme.base.ground, "#ffffff"));
  });
});
