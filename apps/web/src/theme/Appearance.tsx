import { Check, Moon, Palette, Settings2, Sun } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { cx, Segmented } from "../ui";
import { themeInUse, useThemeChoice } from "./store";
import { contrast, FAMILIES, THEMES, tokensOf, VISIBLE, type Theme } from "./themes";

/** A theme as a small picture of itself: its page, a panel on it, two lines of text and its accent. */
function ThemeTile({ theme, accent, on, onPick }: { theme: Theme; accent: string | undefined; on: boolean; onPick(): void }) {
  const t = tokensOf(theme, accent);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      data-tip={theme.name}
      className={cx("flex w-[132px] flex-col gap-1.5 rounded-2xl border-2 p-1.5 text-left", on ? "border-accent" : "border-transparent hover:border-line-strong")}
    >
      <span className="flex h-[70px] w-full gap-1.5 overflow-hidden rounded-lg p-1.5" style={{ background: t.ground, border: `1px solid ${t.line}` }}>
        <span className="h-full w-7 rounded-xs" style={{ background: t.panel }} />
        <span className="flex grow flex-col gap-1.5 rounded-xs p-1.5" style={{ background: t.panel }}>
          <span className="h-1.5 w-4/5 rounded-full" style={{ background: t.ink }} />
          <span className="h-1.5 w-3/5 rounded-full" style={{ background: t["ink-2"] }} />
          <span className="mt-auto flex items-center justify-between">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.good }} />
            <span className="h-3 w-9 rounded-xs" style={{ background: t.accent }} />
          </span>
        </span>
      </span>
      <span className={cx("px-0.5 text-xs", on ? "font-semibold text-ink" : "text-ink-2")}>{theme.name}</span>
    </button>
  );
}

/**
 * The tick on an accent's dot. The dot is the palette's own colour, not the accent as the page uses it (taken
 * darker to read as text on a light theme), so what is written on the accent can be lost on it: white on Dawn's
 * gold read at 2.2:1. Then the one of the theme's ink and its usual ink on the accent that reads best.
 */
function tickOn(theme: Theme, name: string): string {
  const dot = theme.accents[name]!;
  const written = tokensOf(theme, name)["accent-ink"];
  if (contrast(dot, written) >= VISIBLE) return written;
  return [theme.base.ink, theme.onAccent].reduce((best, c) => (contrast(dot, c) > contrast(dot, best) ? c : best));
}

/** The accents of one family of themes, as dots to pick from. */
function Accents({ theme, picked, onPick }: { theme: Theme; picked: string | undefined; onPick(name: string): void }) {
  const names = Object.keys(theme.accents);
  const current = picked && names.includes(picked) ? picked : names[0];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold">Accent · {FAMILIES[theme.family]} <span className="font-normal text-ink-2">{current}</span></span>
      <div className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={`Accent: ${name}`}
            aria-pressed={name === current}
            data-tip={name}
            onClick={() => onPick(name)}
            className={cx("flex h-7 w-7 items-center justify-center rounded-full border-2", name === current ? "border-ink-strong" : "border-transparent")}
            style={{ background: theme.accents[name] }}
          >
            {name === current && <Check size={13} strokeWidth={3} style={{ color: tickOn(theme, name) }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The theme tiles (dark, light) and the accents of the families in play: Settings › Interface draws them in its own card. */
export function ThemePickers() {
  const choice = useThemeChoice();
  const inUse = themeInUse(choice);
  const night = THEMES.filter((t) => !t.light);
  const day = THEMES.filter((t) => t.light);
  // the accents of the families in play: the night theme's, and the day theme's when it is of another family
  const families = [...new Map([choice.night, choice.day].map((id) => THEMES.find((t) => t.id === id) ?? THEMES[0]!).map((t) => [t.family, t])).values()];
  const pickAccent = (family: string, name: string) => choice.set({ accents: { ...choice.accents, [family]: name } });
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">Dark theme</span>
        <div className="flex flex-wrap gap-1">
          {night.map((t) => <ThemeTile key={t.id} theme={t} accent={choice.accents[t.family]} on={choice.night === t.id} onPick={() => choice.set({ night: t.id, mode: choice.mode === "light" ? "dark" : choice.mode })} />)}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">Light theme <span className="font-normal text-ink-2">images and videos stay on a dark stage</span></span>
        <div className="flex flex-wrap gap-1">
          {day.map((t) => <ThemeTile key={t.id} theme={t} accent={choice.accents[t.family]} on={choice.day === t.id} onPick={() => choice.set({ day: t.id, mode: choice.mode === "dark" ? "light" : choice.mode })} />)}
        </div>
      </div>
      {families.map((t) => <Accents key={t.family} theme={t.family === inUse.family ? inUse : t} picked={choice.accents[t.family]} onPick={(name) => pickAccent(t.family, name)} />)}
    </>
  );
}

/** The theme's mode: dark, light or the system's. */
export function ThemeMode() {
  const choice = useThemeChoice();
  return <Segmented label="Theme mode" value={choice.mode} onChange={(mode) => choice.set({ mode })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />;
}

/**
 * In the rail: from the night theme to the day theme and back. Its right-click menu picks another theme of the mode in
 * use and the accent of the theme in use, without going to Settings, and leads there for the rest.
 */
export function ThemeFlip() {
  const choice = useThemeChoice();
  const inUse = themeInUse(choice);
  const light = inUse.light;
  const menu = useMenu<true>();
  const [, go] = useLocation();
  const accents = Object.keys(inUse.accents);
  const accentNow = choice.accents[inUse.family] && accents.includes(choice.accents[inUse.family]!) ? choice.accents[inUse.family] : accents[0];
  const items: MenuItem[] = [
    ...THEMES.filter((t) => t.light === light).map((t): MenuItem => ({
      label: t.name,
      checked: t.id === inUse.id,
      run: () => choice.set(light ? { day: t.id } : { night: t.id }),
    })),
    "—",
    {
      label: "Accent", icon: <Palette size={14} />, note: accentNow,
      items: accents.map((name): MenuItem => ({
        label: name,
        icon: <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full" style={{ background: inUse.accents[name] }}>{name === accentNow && <Check size={10} strokeWidth={3} style={{ color: tickOn(inUse, name) }} />}</span>,
        run: () => choice.set({ accents: { ...choice.accents, [inUse.family]: name } }),
      })),
    },
    "—",
    { label: "Appearance settings", icon: <Settings2 size={14} />, run: () => go("/settings/interface") },
  ];
  return (
    <>
    <button
      type="button"
      aria-label={light ? "Switch to the dark theme" : "Switch to the light theme"}
      aria-haspopup="menu"
      data-tip={light ? "Dark theme · right-click: themes and accent" : "Light theme · right-click: themes and accent"}
      onClick={() => choice.set({ mode: light ? "dark" : "light" })}
      onContextMenu={(e) => menu.open(e, true)}
      // small and quiet at the foot of the rail, a pill like the screens above it
      className="my-1 flex h-[26px] w-12 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
    >
      {light ? <Moon size={17} /> : <Sun size={17} />}
    </button>
    {menu.menu && <ContextMenu at={menu.menu.at} label="Themes" head={{ title: inUse.name, sub: light ? "light themes" : "dark themes" }} items={items} onClose={menu.close} />}
    </>
  );
}
