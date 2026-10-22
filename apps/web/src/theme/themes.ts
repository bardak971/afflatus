import { catppuccin, kanagawa, rosePine, tokyoNight } from "./palettes";

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
  "attention", "attention-wash", "attention-ink",
  "picture", "shade", "knob", "stage", "boot",
] as const;

type Warning = Pick<Tokens, "warn" | "warn-wash" | "warn-ink">;
/** The role between done and failed: something that needs a look. Its own amber, so that the warning's red means failed or broken only. */
type Attention = "attention" | "attention-wash" | "attention-ink";

export interface Theme {
  id: string;
  name: string;
  /** The themes that share accents: "Studio", "Catppuccin", "Rosé Pine"... */
  family: "studio" | "catppuccin" | "rosepine" | "tokyonight" | "kanagawa";
  light: boolean;
  /** The accents it offers, by name, most at home first. */
  accents: Record<string, string>;
  /** Of a light theme: the dark theme whose tokens go on everything marked `data-stage`. */
  stage?: string;
  /** Everything but the accent. Its `stage` is what pictures and videos are shown on: near black in every theme. */
  base: Omit<Tokens, "accent" | "accent-ink" | "accent-wash" | "knob" | "boot" | Attention>;
  /** The family's reds and oranges a warning can be in, its own first: another is taken when the accent is too like it. */
  alerts: string[];
  /**
   * The family's ambers and golds, its own first: what needs a look (a stale join, a clip before that changed) is in one
   * of them, the one that stands furthest from the warning and the accent in use (attentionFor).
   */
  ambers: string[];
  /** The warning's tokens in one of `alerts`. */
  warning(colour: string): Warning;
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

/** A colour's hue, 0 to 360 degrees. */
function hue(c: string): number {
  const [r, g, b] = hex(c).map((v) => v / 255) as [number, number, number];
  const hi = Math.max(r, g, b);
  const d = hi - Math.min(r, g, b);
  if (!d) return 0;
  const h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
/** How far apart two colours' hues are, 0 to 180 degrees. */
export function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return d > 180 ? 360 - d : d;
}

/** A warning in a colour: on a light theme a pale tint behind it and a darker ink, on a dark one a deeper wash and a paler ink. */
function warning(warn: string, panel: string, text: string, light: boolean): Warning {
  return { warn, "warn-wash": mix(panel, warn, light ? 0.09 : 0.16), "warn-ink": light ? mix(warn, "#000000", 0.28) : mix(warn, text, 0.3) };
}
/** What a dark theme shows pictures on: its page taken most of the way to black, a neutral that sways no colour. */
const darkStage = (ground: string) => mix(ground, "#000000", 0.45);
/** The cards of a light theme: lighter than the page they stand on, toward white, as paper on a desk. */
const paper = (c: string, t: number) => mix(c, "#ffffff", t);

// ---------------------------------------------------------------- Studio (neutral greys: nothing on the page tints a picture)

// the app's own default: neutral greys, the coral of its mark first
const studio: Theme = {
  id: "studio", name: "Studio Dark", family: "studio", light: false,
  accents: { coral: "#ff9a73", amber: "#d9b56b", rose: "#e08aa5", lilac: "#b9a2e0", sky: "#7fb0e8", mint: "#6fc9b0" },
  base: {
    ground: "#141414", panel: "#1b1b1b", raised: "#232323", hover: "#2a2a2a", line: "#2b2b2b", "line-strong": "#3a3a3a",
    // the quietest ink at 4.86:1 on a raised field: at #7c7c7c (taken to #848484 to read on the panel) it was 4.2:1 there,
    // short of AA for the 11 and 12 px text it is used for (review 4, P18)
    ink: "#e8e8e8", "ink-2": "#a9a9a9", "ink-3": "#8f8f8f", "ink-strong": "#ffffff",
    good: "#6fc9b0", ...warning("#f0875e", "#1b1b1b", "#e8e8e8", false), "warn-on": "#2a0e00",
    picture: "#7fb0e8", shade: "#000000", stage: darkStage("#141414"),
  },
  alerts: ["#f0875e", "#f06a72"],
  ambers: ["#e8b44c", "#d9b56b"],
  warning: (c) => warning(c, "#1b1b1b", "#e8e8e8", false),
  onAccent: "#151515",
  wash: 0.1,
};
const studioLight: Theme = {
  id: "studio-light", name: "Studio Light", family: "studio", light: true, stage: studio.id,
  accents: { coral: "#c4683f", amber: "#a8792a", rose: "#b5507a", lilac: "#7a5fb5", sky: "#2f72b3", mint: "#23836c" },
  base: {
    ground: "#e4e4e4", panel: "#f7f7f7", raised: "#ffffff", hover: "#ececec", line: "#d8d8d8", "line-strong": "#c2c2c2",
    ink: "#1d1d1d", "ink-2": "#4f4f4f", "ink-3": "#6a6a6a", "ink-strong": "#000000",
    good: "#23836c", ...warning("#c4532a", "#f7f7f7", "#1d1d1d", true), "warn-on": "#ffffff",
    picture: "#2f72b3", shade: "#8a8a8a", stage: studio.base.panel,
  },
  alerts: ["#c4532a", "#c8373f"],
  ambers: ["#a8792a"],
  warning: (c) => warning(c, "#f7f7f7", "#1d1d1d", true),
  onAccent: "#ffffff",
  wash: 0.1,
};

// ---------------------------------------------------------------- Catppuccin

type Flavor = (typeof catppuccin)[keyof typeof catppuccin];
const ACCENTS = ["yellow", "peach", "maroon", "red", "pink", "mauve", "lavender", "blue", "sapphire", "sky", "teal", "green", "flamingo", "rosewater"] as const;

/**
 * A flavour as a theme. Dark: the page is on "mantle" and what stands on it (the side panels, the cards)
 * on "base", one step lighter; fields are a step further. Light (Latte, given the dark theme its pictures
 * are shown on): the page on "mantle", the cards near white above it and the fields on "base".
 */
function ofCatppuccin(id: string, name: string, c: Flavor, stage?: Theme): Theme {
  const light = Boolean(stage);
  const panel = light ? paper(c.base, 0.75) : c.base;
  const text = light ? mix(c.text, "#000000", 0.2) : c.text;
  return {
    id, name, family: "catppuccin", light, stage: stage?.id,
    accents: Object.fromEntries(ACCENTS.map((a) => [a, c[a]])),
    base: stage
      ? {
          ground: c.mantle, panel, raised: c.base, hover: mix(c.base, c.surface0, 0.6),
          line: mix(c.surface0, c.base, 0.25), "line-strong": c.surface1,
          ink: text, "ink-2": c.subtext1, "ink-3": c.subtext0, "ink-strong": mix(c.text, "#000000", 0.45),
          good: c.green, ...warning(c.peach, panel, text, true), "warn-on": c.base,
          picture: c.blue, shade: c.overlay2, stage: stage.base.panel,
        }
      : {
          ground: c.mantle, panel, raised: mix(c.base, c.surface0, 0.55), hover: c.surface0,
          line: mix(c.surface0, c.surface1, 0.35), "line-strong": c.surface1,
          ink: text, "ink-2": c.subtext0, "ink-3": c.overlay1, "ink-strong": mix(c.text, "#ffffff", 0.6),
          good: c.green, ...warning(c.peach, panel, text, false), "warn-on": c.crust,
          picture: c.blue, shade: "#000000", stage: darkStage(c.mantle),
        },
    alerts: [c.peach, c.red, c.maroon],
    ambers: [c.yellow, c.peach],
    warning: (w) => warning(w, panel, text, light),
    onAccent: light ? "#ffffff" : c.crust,
    wash: light ? 0.1 : 0.12,
  };
}

// ---------------------------------------------------------------- Rosé Pine

type Variant = (typeof rosePine)[keyof typeof rosePine];
function ofRosePine(id: string, name: string, c: Variant, stage?: Theme): Theme {
  const light = Boolean(stage);
  const panel = light ? paper(c.surface, 0.4) : c.surface;
  const text = light ? mix(c.text, "#000000", 0.15) : c.text;
  // Dawn's love, darkened as every light warning is, came out a muted maroon that read as ordinary text
  // beside the dark names of a failed row: its ink is taken toward a plain red first (5.4:1 on its wash)
  const warningOf = (w: string): Warning => {
    const t = warning(w, panel, text, light);
    return light && w === c.love ? { ...t, "warn-ink": mix(mix(w, "#d7263d", 0.45), "#000000", 0.15) } : t;
  };
  return {
    id, name, family: "rosepine", light, stage: stage?.id,
    accents: { gold: c.gold, rose: c.rose, love: c.love, iris: c.iris, foam: c.foam, pine: c.pine },
    base: stage
      ? {
          // the lines as strong as the other light themes' (1.35:1 and 1.65:1 on a card): at a tenth and a quarter of
          // muted they all but vanished on Dawn's cream, the edges of fields and buttons with them
          ground: c.overlay, panel, raised: c.base, hover: mix(c.base, c.muted, 0.15),
          line: mix(c.overlay, c.muted, 0.18), "line-strong": mix(c.overlay, c.muted, 0.42),
          ink: text, "ink-2": mix(c.subtle, "#000000", 0.22), "ink-3": mix(c.subtle, "#000000", 0.1), "ink-strong": mix(c.text, "#000000", 0.4),
          good: c.pine, ...warningOf(c.love), "warn-on": c.surface,
          picture: c.iris, shade: c.muted, stage: stage.base.panel,
        }
      : {
          ground: c.base, panel, raised: c.overlay, hover: mix(c.overlay, c.muted, 0.28),
          line: mix(c.overlay, c.muted, 0.22), "line-strong": mix(c.overlay, c.muted, 0.5),
          ink: text, "ink-2": c.subtle, "ink-3": mix(c.muted, c.subtle, 0.5), "ink-strong": "#ffffff",
          good: c.foam, ...warning(c.love, panel, text, false), "warn-on": c.base,
          picture: c.iris, shade: "#000000", stage: darkStage(c.base),
        },
    // love is the warning; beside a rose accent, gold is the one that stands apart
    alerts: [c.love, c.gold, c.rose],
    // gold is all the palette has of an amber. Beside a gold accent, or a love one (whose warning is then in gold), the
    // rose (a peach-pink here) is the one left apart; beside a rose accent the warning is in gold, so only love is
    ambers: [c.gold, c.rose, c.love],
    warning: warningOf,
    onAccent: light ? "#ffffff" : c.base,
    wash: light ? 0.1 : 0.12,
  };
}

// ---------------------------------------------------------------- Tokyo Night

const tn = tokyoNight.night;
const tokyoNightTheme: Theme = {
  id: "tokyo-night", name: "Tokyo Night", family: "tokyonight", light: false,
  accents: { blue: tn.blue, cyan: tn.cyan, magenta: tn.magenta, purple: tn.purple, green: tn.green, teal: tn.teal, orange: tn.orange, yellow: tn.yellow, red: tn.red },
  base: {
    ground: tn.bg_dark, panel: tn.bg, raised: mix(tn.bg, tn.bg_highlight, 0.6), hover: mix(tn.bg_highlight, tn.fg_gutter, 0.35),
    line: tn.bg_highlight, "line-strong": tn.fg_gutter,
    ink: tn.fg, "ink-2": tn.fg_dark, "ink-3": tn.dark5, "ink-strong": "#ffffff",
    good: tn.green, ...warning(tn.orange, tn.bg, tn.fg, false), "warn-on": tn.bg_dark,
    picture: tn.cyan, shade: "#000000", stage: darkStage(tn.bg_dark),
  },
  alerts: [tn.orange, tn.red],
  ambers: [tn.yellow, tn.orange],
  warning: (w) => warning(w, tn.bg, tn.fg, false),
  onAccent: tn.bg_dark,
  wash: 0.12,
};
const td = tokyoNight.day;
// the day palette writes its text in blue (fg): the page's inks are its quieter blue-grey, taken darker
const tdPanel = paper(td.bg, 0.35);
const tdInk = mix(td.fg_dark, "#000000", 0.45);
const tokyoDayTheme: Theme = {
  id: "tokyo-night-day", name: "Tokyo Night Day", family: "tokyonight", light: true, stage: tokyoNightTheme.id,
  accents: { blue: td.blue, cyan: td.cyan, magenta: td.magenta, purple: td.purple, green: td.green, teal: td.teal, orange: td.orange, yellow: td.yellow, red: td.red },
  base: {
    ground: td.bg_dark, panel: tdPanel, raised: paper(td.bg, 0.65), hover: mix(td.bg, td.bg_highlight, 0.5),
    line: td.bg_highlight, "line-strong": td.fg_gutter,
    ink: tdInk, "ink-2": mix(td.fg_dark, "#000000", 0.25), "ink-3": mix(td.comment, "#000000", 0.28), "ink-strong": mix(td.fg_dark, "#000000", 0.7),
    good: td.green, ...warning(td.orange, tdPanel, tdInk, true), "warn-on": "#ffffff",
    picture: td.cyan, shade: td.comment, stage: tokyoNightTheme.base.panel,
  },
  alerts: [td.orange, td.red],
  ambers: [td.yellow, td.orange],
  warning: (w) => warning(w, tdPanel, tdInk, true),
  onAccent: "#ffffff",
  wash: 0.1,
};

// ---------------------------------------------------------------- Kanagawa

const kw = kanagawa.wave;
const kanagawaWave: Theme = {
  id: "kanagawa-wave", name: "Kanagawa Wave", family: "kanagawa", light: false,
  accents: { yellow: kw.carpYellow, orange: kw.surimiOrange, red: kw.waveRed, pink: kw.sakuraPink, violet: kw.oniViolet, blue: kw.crystalBlue, aqua: kw.waveAqua2, green: kw.springGreen },
  base: {
    ground: kw.sumiInk0, panel: kw.sumiInk3, raised: kw.sumiInk4, hover: kw.sumiInk5,
    line: mix(kw.sumiInk4, kw.sumiInk5, 0.35), "line-strong": mix(kw.sumiInk5, kw.sumiInk6, 0.35),
    ink: kw.fujiWhite, "ink-2": kw.oldWhite, "ink-3": kw.fujiGray, "ink-strong": mix(kw.fujiWhite, "#ffffff", 0.6),
    good: kw.springGreen, ...warning(kw.waveRed, kw.sumiInk3, kw.fujiWhite, false), "warn-on": kw.sumiInk0,
    picture: kw.crystalBlue, shade: "#000000", stage: darkStage(kw.sumiInk0),
  },
  alerts: [kw.waveRed, kw.surimiOrange],
  ambers: [kw.carpYellow, kw.surimiOrange],
  warning: (w) => warning(w, kw.sumiInk3, kw.fujiWhite, false),
  onAccent: kw.sumiInk0,
  wash: 0.12,
};
const kl = kanagawa.lotus;
const klPanel = paper(kl.lotusWhite3, 0.4);
const kanagawaLotus: Theme = {
  id: "kanagawa-lotus", name: "Kanagawa Lotus", family: "kanagawa", light: true, stage: kanagawaWave.id,
  accents: { yellow: kl.lotusYellow, orange: kl.lotusOrange, red: kl.lotusRed, pink: kl.lotusPink, violet: kl.lotusViolet4, blue: kl.lotusBlue4, aqua: kl.lotusAqua, green: kl.lotusGreen },
  base: {
    ground: kl.lotusWhite2, panel: klPanel, raised: paper(kl.lotusWhite3, 0.65), hover: mix(kl.lotusWhite3, kl.lotusWhite0, 0.5),
    line: mix(kl.lotusWhite2, kl.lotusWhite0, 0.5), "line-strong": mix(kl.lotusWhite0, kl.lotusGray3, 0.3),
    ink: kl.lotusInk2, "ink-2": kl.lotusInk1, "ink-3": kl.lotusGray3, "ink-strong": mix(kl.lotusInk2, "#000000", 0.4),
    good: kl.lotusGreen, ...warning(kl.lotusRed, klPanel, kl.lotusInk2, true), "warn-on": "#ffffff",
    picture: kl.lotusBlue4, shade: kl.lotusGray3, stage: kanagawaWave.base.panel,
  },
  alerts: [kl.lotusRed, kl.lotusOrange],
  ambers: [kl.lotusYellow, kl.lotusOrange],
  warning: (w) => warning(w, klPanel, kl.lotusInk2, true),
  onAccent: "#ffffff",
  wash: 0.1,
};

const mocha = ofCatppuccin("mocha", "Catppuccin Mocha", catppuccin.mocha);
const rosePineMain = ofRosePine("rose-pine", "Rosé Pine", rosePine.main);
export const THEMES: Theme[] = [
  studio,
  mocha,
  ofCatppuccin("macchiato", "Catppuccin Macchiato", catppuccin.macchiato),
  ofCatppuccin("frappe", "Catppuccin Frappé", catppuccin.frappe),
  rosePineMain,
  ofRosePine("rose-pine-moon", "Rosé Pine Moon", rosePine.moon),
  tokyoNightTheme,
  kanagawaWave,
  studioLight,
  ofCatppuccin("latte", "Catppuccin Latte", catppuccin.latte, mocha),
  ofRosePine("rose-pine-dawn", "Rosé Pine Dawn", rosePine.dawn, rosePineMain),
  tokyoDayTheme,
  kanagawaLotus,
];
export const FAMILIES: Record<Theme["family"], string> = { studio: "Studio", catppuccin: "Catppuccin", rosepine: "Rosé Pine", tokyonight: "Tokyo Night", kanagawa: "Kanagawa" };
export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? studio;

/** How bright a colour is to the eye, 0 to 1. */
function luminance(c: string): number {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** How far apart two colours read (WCAG): 1 for the same, 21 for black on white. */
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** What text needs against what it sits on (WCAG AA, body text). */
export const LEGIBLE = 4.5;
/** The most of a status colour laid behind its own text in a chip or a lane (bg-good/15, bg-picture/20). */
export const TINT = 0.2;

/**
 * A colour of text taken just far enough toward black (a light theme) or white (a dark one) to read on
 * each of `on`: a colour that already reads is left as it is. The palettes' quiet greys and their pale
 * accents fall short on the light themes' panels.
 */
export function legible(colour: string, on: string[], light: boolean, need = LEGIBLE): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = t ? mix(colour, light ? "#000000" : "#ffffff", t) : colour;
    if (on.every((b) => contrast(c, b) >= need)) return c;
  }
  return light ? "#000000" : "#ffffff";
}

/**
 * The same, for a colour that is also written on a tint of itself (a chip: "Saved" in green on a pale green, a
 * sound's name on its blue lane): it reads on each of `on` and on `share` of it laid over each of them. The tint
 * grows darker with the colour, so each step is tried against its own.
 */
function legibleOnTint(colour: string, on: string[], light: boolean, share: number): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = t ? mix(colour, light ? "#000000" : "#ffffff", t) : colour;
    if (on.every((b) => contrast(c, b) >= LEGIBLE && contrast(c, mix(b, c, share)) >= LEGIBLE)) return c;
  }
  return light ? "#000000" : "#ffffff";
}

/** What a line, a bar or an icon that carries meaning needs against what it is drawn on (WCAG AA, graphics). */
export const VISIBLE = 3;

/**
 * The colours a chart draws its series in: the theme's accents, the one in use first. On a light theme each is
 * taken just dark enough to be seen on the cards and the page (Latte's yellow and sky, Dawn's gold and rose
 * were a faint 2:1 line on cream); a dark theme's accents are drawn as they are.
 */
export function chartColours(theme: Theme, accent: string | undefined): string[] {
  const all = Object.entries(theme.accents);
  const first = all.find(([name]) => name === accent) ?? all[0];
  const raw = [...new Set([first?.[1], ...all.map(([, c]) => c)].filter((c): c is string => Boolean(c)))];
  if (!theme.light) return raw;
  const on = [theme.base.panel, theme.base.raised, theme.base.ground];
  return [...new Set(raw.map((c) => legible(c, on, true, VISIBLE)))];
}

/** Below this many degrees of hue apart, an accent and the warning read as one colour. */
export const WARN_GAP = 35;
/**
 * The warning beside an accent: the theme's own, unless the accent is so near it in hue (a peach or gold
 * accent beside an orange warning) that a warning would look picked; then the family's red or orange
 * that stands furthest from the accent.
 */
export function warnFor(theme: Theme, accent: string): string {
  const own = theme.alerts[0]!;
  if (hueGap(accent, own) >= WARN_GAP) return own;
  return theme.alerts.reduce((best, c) => (hueGap(accent, c) > hueGap(accent, best) ? c : best), own);
}

/**
 * Below this many degrees of hue apart, the attention amber reads as the accent or the warning. Smaller than WARN_GAP: an
 * amber and an orange are told apart by their lightness too, and most palettes have no amber further from their orange.
 */
export const ATTENTION_GAP = 15;
/**
 * What needs a look beside an accent and a warning: the family's own amber, unless it is too near one of the two in hue
 * (a yellow accent; Rosé Pine's warning in gold beside a love accent), then the amber of the family that stands furthest
 * from both.
 */
export function attentionFor(theme: Theme, accent: string, warn: string): string {
  const own = theme.ambers[0]!;
  const apart = (c: string) => Math.min(hueGap(c, accent), hueGap(c, warn));
  if (apart(own) >= ATTENTION_GAP) return own;
  return theme.ambers.reduce((best, c) => (apart(c) > apart(best) ? c : best), own);
}

/**
 * The attention tokens in an amber: on a dark theme a deeper wash and a paler ink, on a light one a pale tint and a
 * darker ink, as a warning's; each taken just far enough to read as text on its wash and on the panels and the page.
 */
function attentionTokens(theme: Theme, base: Theme["base"], amber: string): Pick<Tokens, Attention> {
  const on = [base.panel, base.raised, base.ground];
  const colour = legible(amber, on, theme.light);
  const wash = mix(base.panel, colour, theme.light ? 0.09 : 0.16);
  const ink = theme.light ? mix(colour, "#000000", 0.28) : mix(colour, base.ink, 0.3);
  return { attention: colour, "attention-wash": wash, "attention-ink": legible(ink, [wash, ...on], theme.light) };
}

/**
 * What Queue › Costs draws a pod's boot in (its parts in shades of it): of the theme's accents, the one whose hue stands
 * furthest from the three it is drawn beside (the accent in use for rendering, the picture blue for fetching, the warning
 * for failed renders), so that a boot never reads as one of them whatever the accent. On a light theme it is taken just
 * dark enough to be seen on the cards and the page, as a chart's series are.
 */
export function bootColour(theme: Theme, accent: string, warn: string): string {
  const beside = [accent, theme.base.picture, warn];
  const far = (c: string) => Math.min(...beside.map((b) => hueGap(c, b)));
  const best = Object.values(theme.accents).reduce((a, c) => (far(c) > far(a) ? c : a));
  return theme.light ? legible(best, [theme.base.panel, theme.base.raised, theme.base.ground], true, VISIBLE) : best;
}

/** A theme's tokens with an accent of its family (its first one when the name is not one of its own). */
export function tokensOf(theme: Theme, accent: string | undefined): Tokens {
  const name = accent && accent in theme.accents ? accent : Object.keys(theme.accents)[0]!;
  // text in the accent, and the two quieter inks, read on the panels and on the page
  const grounds = [theme.base.panel, theme.base.ground];
  const colour = legible(theme.accents[name]!, grounds, theme.light);
  const wash = mix(theme.base.panel, colour, theme.wash);
  // what is written on the accent: the theme's usual ink for it, unless the other one reads clearly better
  // (a dark accent in a dark theme, a pale one in a light theme)
  const other = theme.light ? theme.base.ink : theme.base["ink-strong"];
  const written = contrast(colour, other) > contrast(colour, theme.onAccent) * 1.25 ? other : theme.onAccent;
  const warn = warnFor(theme, theme.accents[name]!);
  const base = warn === theme.base.warn ? theme.base : { ...theme.base, ...theme.warning(warn) };
  return {
    ...base,
    "ink-2": legible(base["ink-2"], grounds, theme.light),
    "ink-3": legible(base["ink-3"], grounds, theme.light),
    // "OK", "Ready", "Connected": green text that reads on the light themes' panels too
    // on a light theme it is also written on a tint of itself (a "Saved" chip, a sound's lane), up to a fifth of it
    good: theme.light ? legibleOnTint(base.good, [base.panel, base.raised, base.ground], true, TINT) : legible(base.good, [base.panel, base.raised, base.ground], false),
    // what marks a picture or a sound (its lane, its chip) is written too: the light palettes' blues and iris read at
    // 3:1 to 4:1 on their pages, less on their own tint. A dark theme's is left as its palette has it
    picture: theme.light ? legibleOnTint(base.picture, [base.panel, base.raised, base.ground], true, TINT) : base.picture,
    // a notice's text reads on its wash; on a light theme also on the page and a faint tint of the warning over it
    // (a failed day's line, a box marked bg-warn/5), where Dawn's gold ink fell to 3.9:1
    "warn-ink": legible(base["warn-ink"], theme.light ? [base["warn-wash"], base.panel, base.raised, base.ground, mix(base.ground, base.warn, 0.1)] : [base["warn-wash"], base.panel], theme.light),
    // the warning itself is written too ("Failed", a missing file, a red icon), not only filled: the light palettes'
    // oranges and pinks (Latte's peach, Dawn's love and gold) read at 2:1 to 3:1 on their panels, so they are taken
    // darker until they read on everything a warning sits on. The dark themes keep their palettes' own: they read
    // as text there, and only fall short as small print on their deeper washes, where warn-ink is used
    warn: theme.light ? legible(base.warn, [base.panel, base.raised, base.ground, base["warn-wash"]], true) : base.warn,
    accent: colour,
    "accent-ink": written,
    "accent-wash": wash,
    // the knob of a switch that is on: whatever is written on the accent
    knob: written,
    boot: bootColour(theme, theme.accents[name]!, warn),
    ...attentionTokens(theme, base, attentionFor(theme, theme.accents[name]!, warn)),
  };
}
