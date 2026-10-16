import { describe, expect, it } from "vitest";
import { bootColour, chartColours, contrast, FAMILIES, hueGap, LEGIBLE, legible, mix, themeById, THEMES, TINT, tokensOf, VISIBLE, WARN_GAP, warnFor } from "../src/theme/themes";

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
  it("keeps the warning readable as text on every light theme, with every accent", () => {
    // the dark themes keep their palettes' own warning; on the light ones it is written on panels, fields and the page
    for (const theme of THEMES.filter((t) => t.light)) {
      for (const accent of Object.keys(theme.accents)) {
        const t = tokensOf(theme, accent);
        for (const on of ["panel", "raised", "ground", "warn-wash"] as const) {
          expect(contrast(t.warn, t[on]), `${theme.id} ${accent}: warn on ${on}`).toBeGreaterThanOrEqual(LEGIBLE);
        }
      }
    }
  });
  it("keeps a light theme's green and picture blue readable on a chip of their own tint, and its notice ink on the page", () => {
    for (const theme of THEMES.filter((t) => t.light)) {
      for (const accent of Object.keys(theme.accents)) {
        const t = tokensOf(theme, accent);
        for (const on of [t.panel, t.raised, t.ground]) {
          for (const ink of ["good", "picture"] as const) {
            expect(contrast(t[ink], on), `${theme.id} ${accent}: ${ink}`).toBeGreaterThanOrEqual(LEGIBLE);
            expect(contrast(t[ink], mix(on, t[ink], TINT)), `${theme.id} ${accent}: ${ink} on its tint`).toBeGreaterThanOrEqual(LEGIBLE);
          }
          expect(contrast(t["warn-ink"], on), `${theme.id} ${accent}: warn-ink`).toBeGreaterThanOrEqual(LEGIBLE);
        }
      }
    }
  });
  it("leaves every dark theme's status colours as its palette has them", () => {
    for (const theme of THEMES.filter((t) => !t.light)) {
      const t = tokensOf(theme, undefined);
      expect(t.picture, theme.id).toBe(theme.base.picture);
      expect(t.warn, theme.id).toBe(warnFor(theme, Object.values(theme.accents)[0]!));
    }
  });
  it("keeps green status text readable on every theme", () => {
    for (const theme of THEMES) {
      const t = tokensOf(theme, undefined);
      for (const on of ["panel", "raised", "ground"] as const) expect(contrast(t.good, t[on]), `${theme.id}: good on ${on}`).toBeGreaterThanOrEqual(LEGIBLE);
    }
  });
});

describe("the charts' colours", () => {
  it("draws every series where it can be seen on a light theme, and leaves a dark theme's accents as they are", () => {
    for (const theme of THEMES) {
      for (const accent of Object.keys(theme.accents)) {
        const colours = chartColours(theme, accent);
        if (!theme.light) {
          expect(colours[0], `${theme.id} ${accent}`).toBe(theme.accents[accent]);
          continue;
        }
        for (const c of colours) {
          for (const on of [theme.base.panel, theme.base.raised, theme.base.ground]) expect(contrast(c, on), `${theme.id} ${accent}: ${c}`).toBeGreaterThanOrEqual(VISIBLE);
        }
      }
    }
  });
  it("starts with the accent in use", () => {
    expect(chartColours(themeById("mocha"), "teal")[0]).toBe("#94e2d5");
    expect(hueGap(chartColours(themeById("latte"), "yellow")[0]!, "#df8e1d")).toBeLessThan(3);
  });
});

describe("Queue › Costs' boot colour", () => {
  it("stands apart in hue from the accent, the picture blue and the warning, and is seen on a light theme", () => {
    for (const theme of THEMES) {
      for (const accent of Object.keys(theme.accents)) {
        const t = tokensOf(theme, accent);
        const raw = theme.accents[accent]!;
        const warn = warnFor(theme, raw);
        expect(t.boot, `${theme.id} ${accent}`).toBe(bootColour(theme, raw, warn));
        // never one of the three it is drawn beside
        for (const beside of [raw, theme.base.picture, warn]) expect(hueGap(t.boot, beside), `${theme.id} ${accent}`).toBeGreaterThanOrEqual(20);
        if (theme.light) for (const on of [t.panel, t.ground]) expect(contrast(t.boot, on), `${theme.id} ${accent}`).toBeGreaterThanOrEqual(VISIBLE);
      }
    }
  });
});

describe("the warning beside a warm accent", () => {
  // which of the family's colours the warning is in (a light theme then takes it darker, to read as text)
  const warnOf = (id: string, accent: string) => warnFor(themeById(id), themeById(id).accents[accent]!);
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
        const warn = warnFor(theme, colour);
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
