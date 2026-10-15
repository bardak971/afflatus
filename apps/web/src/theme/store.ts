import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProgressStyle } from "../progress/style";
import { themeById, tokensOf, TOKENS, type Theme, type Tokens } from "./themes";

/**
 * Which theme this browser shows. A theme for the day and one for the night; which of the two is up is
 * said by hand (light, dark) or left to the system. Kept in the browser, not on the server: a laptop
 * and another screen need not look the same.
 */
export interface ThemeChoice {
  mode: "light" | "dark" | "system";
  day: string;
  night: string;
  /** The accent picked in each family of themes. */
  accents: Record<string, string>;
  /** How progress bars move (Settings › Interface › Progress); unset: Glide. Kept here because it is a look of this browser too. */
  progress?: ProgressStyle;
}
export const useThemeChoice = create<ThemeChoice & { set(patch: Partial<ThemeChoice>): void }>()(
  persist((set) => ({ mode: "dark", day: "latte", night: "studio", accents: {}, set: (patch) => set(patch) }), { name: "afflatus.theme" }),
);

const systemDark = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true);
/** The theme that is up: the night one or the day one. */
export const themeInUse = (c: ThemeChoice, dark = systemDark()): Theme => themeById(c.mode === "light" || (c.mode === "system" && !dark) ? c.day : c.night);

const rules = (selector: string, tokens: Tokens, extra = "") => `${selector}{${TOKENS.map((t) => `--color-${t}:${tokens[t]};`).join("")}${extra}}`;

/** The soft shadow under a card in a light theme, paper lifted off the page; a dark theme has none. */
const CARD_SHADOW = "0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.05)";
/**
 * A loading placeholder in a light theme: a veil of the ink, which shows on the page and on a card alike. The
 * `raised` it is in a dark theme is near white on the light themes' near white cards (1.05:1), so it vanished.
 */
const LIGHT_SKELETON = "color-mix(in srgb, var(--color-ink) 9%, transparent)";

/**
 * Put a theme on the page: its tokens on the root, and on everything marked `data-stage` (where a
 * picture or a video is shown) the tokens of the dark theme a light one shows its pictures on, so that
 * a picture is always judged against the dark. The `stage` token itself, the near black behind the
 * pictures, is the theme's own in both.
 */
export function applyTheme(c: ThemeChoice): void {
  const theme = themeInUse(c);
  const tokens = tokensOf(theme, c.accents[theme.family]);
  const stage = theme.stage ? themeById(theme.stage) : theme;
  // the same accent on the stage when its theme has one by that name
  const onStage = { ...tokensOf(stage, c.accents[stage.family]), stage: tokens.stage };
  let style = document.getElementById("afflatus-theme");
  if (!style) {
    style = document.createElement("style");
    style.id = "afflatus-theme";
    document.head.appendChild(style);
  }
  style.textContent = [
    rules(":root", tokens, `--stage-pad:${theme.stage ? "12px" : "0px"};--shadow-card:${theme.light ? CARD_SHADOW : "none"};--skeleton:${theme.light ? LIGHT_SKELETON : "var(--color-raised)"};--control-edge:var(--color-${theme.light ? "ink-3" : "line-strong"});color-scheme:${theme.light ? "light" : "dark"};`),
    rules("[data-stage]", onStage, `--shadow-card:none;--skeleton:var(--color-raised);--control-edge:var(--color-line-strong);color:${onStage.ink};color-scheme:dark;`),
  ].join("\n");
  document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme.light ? "light" : "dark");
  // for the next load: the page's colour before any script has run, so that it does not flash
  try {
    localStorage.setItem("afflatus.theme.paint", JSON.stringify({ ground: tokens.ground, ink: tokens.ink, light: theme.light }));
  } catch {
    // a browser that keeps nothing: the theme still shows, a moment later on load
  }
}

/** Keeps the page on the theme that was chosen, and follows the system when it is left to it. Mounted once. */
export function useTheme(): void {
  const choice = useThemeChoice();
  const dark = useSyncExternalStore(
    (changed) => {
      const media = matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    systemDark,
  );
  useEffect(() => {
    applyTheme(choice);
  }, [choice, dark]);
}
