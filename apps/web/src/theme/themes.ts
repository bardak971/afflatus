import { catppuccin, rosePine } from "./palettes";

/**
 * The themes. Every colour of the app is one of a few named tokens (styles.css): a theme is a value for
 * each of them. The accent is a choice of its own inside a family of themes, so that the same accent
 * follows from the day theme to the night theme.
 */
export type Tokens = Record<(typeof TOKENS)[number], string>;
export const TOKENS = [
  "ground", "panel", "raised", "hover", "line", "line-strong",
  "ink", "ink-2", "ink-3", "ink-strong",
  "accent", "accent-ink", "accent-wash",
  "good", "warn", "warn-wash", "warn-ink", "warn-on",
  "picture", "shade", "knob",
] as const;

export interface Theme {
  id: string;
  name: string;
  /** The themes that share accents: "Catppuccin", "Rosé Pine", "studai". */
  family: "studai" | "catppuccin" | "rosepine";
  light: boolean;
  /** The accents it offers, by name, most at home first. */
  accents: Record<string, string>;
  /** Of a light theme: the dark theme its pictures are shown on. */
  stage?: string;
  /** Everything but the accent. */
  base: Omit<Tokens, "accent" | "accent-ink" | "accent-wash" | "knob">;
  /** What is written on a fill of the accent. */
  onAccent: string;
  /** How much of the accent goes into the wash behind something that is picked. */
  wash: number;
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** `t` of the way from one colour to another. */
export function mix(from: string, to: string, t: number): string {
  const a = hex(from);
  const b = hex(to);
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- studai (the look the app was drawn in)

const studai: Theme = {
  id: "studai", name: "studai", family: "studai", light: false,
  accents: { amber: "#f5c451", coral: "#ff9a73", rose: "#f38ba8", lilac: "#c4a7e7", sky: "#86aeff", mint: "#5ad6bd" },
  base: {
    ground: "#0f1114", panel: "#16191e", raised: "#1d2127", hover: "#262b33", line: "#2a3038", "line-strong": "#3a424e",
    ink: "#e9ecf1", "ink-2": "#a3acb9", "ink-3": "#7d8794", "ink-strong": "#ffffff",
    good: "#5ad6bd", warn: "#ff8a5c", "warn-wash": "#2a1a12", "warn-ink": "#ffb79c", "warn-on": "#2a0e00",
    picture: "#86aeff", shade: "#000000",
  },
  onAccent: "#1b1503",
  wash: 0.07,
};

// ---------------------------------------------------------------- Catppuccin

type Flavor = (typeof catppuccin)[keyof typeof catppuccin];
const ACCENTS = ["yellow", "peach", "maroon", "red", "pink", "mauve", "lavender", "blue", "sapphire", "sky", "teal", "green", "flamingo", "rosewater"] as const;

/**
 * A flavour as a theme. The page is on "mantle" and what stands on it (the side panels, the cards) on
 * "base", one step lighter in the dark flavours and in Latte alike; fields are a step further.
 */
function ofCatppuccin(id: string, name: string, c: Flavor, light: boolean, stage?: string): Theme {
  return {
    id, name, family: "catppuccin", light, stage,
    accents: Object.fromEntries(ACCENTS.map((a) => [a, c[a]])),
    base: {
      ground: light ? c.crust : c.mantle, panel: light ? c.mantle : c.base, raised: light ? c.base : mix(c.base, c.surface0, 0.55), hover: light ? c.surface0 : c.surface0,
      line: light ? c.surface0 : mix(c.surface0, c.surface1, 0.35), "line-strong": light ? c.surface1 : c.surface1,
      ink: c.text, "ink-2": c.subtext0, "ink-3": light ? c.overlay1 : c.overlay1, "ink-strong": light ? mix(c.text, "#000000", 0.25) : mix(c.text, "#ffffff", 0.6),
      good: c.green, warn: c.peach, "warn-wash": mix(light ? c.mantle : c.base, c.peach, 0.16), "warn-ink": mix(c.peach, c.text, light ? 0.45 : 0.3), "warn-on": light ? c.base : c.crust,
      picture: c.blue, shade: light ? c.overlay2 : "#000000",
    },
    onAccent: light ? c.base : c.crust,
    wash: light ? 0.16 : 0.12,
  };
}

// ---------------------------------------------------------------- Rosé Pine

type Variant = (typeof rosePine)[keyof typeof rosePine];
function ofRosePine(id: string, name: string, c: Variant, light: boolean, stage?: string): Theme {
  return {
    id, name, family: "rosepine", light, stage,
    accents: { gold: c.gold, rose: c.rose, love: c.love, iris: c.iris, foam: c.foam, pine: c.pine },
    base: {
      ground: light ? c.overlay : c.base, panel: light ? c.base : c.surface, raised: light ? c.surface : c.overlay, hover: mix(c.overlay, c.muted, light ? 0.18 : 0.28),
      line: mix(c.overlay, c.muted, light ? 0.22 : 0.22), "line-strong": mix(c.overlay, c.muted, light ? 0.45 : 0.5),
      ink: c.text, "ink-2": c.subtle, "ink-3": mix(c.muted, c.subtle, 0.5), "ink-strong": light ? mix(c.text, "#000000", 0.25) : "#ffffff",
      good: light ? c.pine : c.foam, warn: c.love, "warn-wash": mix(light ? c.base : c.surface, c.love, 0.16), "warn-ink": mix(c.love, c.text, light ? 0.4 : 0.3), "warn-on": light ? c.surface : c.base,
      picture: c.iris, shade: light ? c.muted : "#000000",
    },
    onAccent: light ? c.surface : c.base,
    wash: light ? 0.18 : 0.12,
  };
}

export const THEMES: Theme[] = [
  studai,
  ofCatppuccin("mocha", "Catppuccin Mocha", catppuccin.mocha, false),
  ofCatppuccin("macchiato", "Catppuccin Macchiato", catppuccin.macchiato, false),
  ofCatppuccin("frappe", "Catppuccin Frappé", catppuccin.frappe, false),
  ofRosePine("rose-pine", "Rosé Pine", rosePine.main, false),
  ofRosePine("rose-pine-moon", "Rosé Pine Moon", rosePine.moon, false),
  ofCatppuccin("latte", "Catppuccin Latte", catppuccin.latte, true, "mocha"),
  ofRosePine("rose-pine-dawn", "Rosé Pine Dawn", rosePine.dawn, true, "rose-pine"),
];
export const FAMILIES: Record<Theme["family"], string> = { studai: "studai", catppuccin: "Catppuccin", rosepine: "Rosé Pine" };
export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? studai;

/** How bright a colour is to the eye, 0 to 1. */
function luminance(c: string): number {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** A theme's tokens with an accent of its family (its first one when the name is not one of its own). */
export function tokensOf(theme: Theme, accent: string | undefined): Tokens {
  const name = accent && accent in theme.accents ? accent : Object.keys(theme.accents)[0]!;
  const colour = theme.accents[name]!;
  // the look the app was drawn in is kept to the last value
  const wash = theme.id === "studai" && name === "amber" ? "#211d10" : mix(theme.base.panel, colour, theme.wash);
  // what is written on the accent: the theme's usual ink for it, unless the other one reads clearly better
  // (a dark accent in a dark theme, a pale one in a light theme)
  const other = theme.light ? theme.base.ink : theme.base["ink-strong"];
  const written = contrast(colour, other) > contrast(colour, theme.onAccent) * 1.25 ? other : theme.onAccent;
  // the knob of a switch that is on: white as the app was drawn, else whatever is written on the accent
  return { ...theme.base, accent: colour, "accent-ink": written, "accent-wash": wash, knob: theme.id === "studai" && name === "amber" ? "#ffffff" : written };
}
