import { Check, Moon, Sun } from "lucide-react";
import { useExplain, useHoverPlay } from "../store";
import { cx, Segmented, Toggle } from "../ui";
import { themeInUse, useThemeChoice } from "./store";
import { FAMILIES, THEMES, tokensOf, type Theme } from "./themes";

/** A theme as a small picture of itself: its page, a panel on it, two lines of text and its accent. */
function ThemeTile({ theme, accent, on, onPick }: { theme: Theme; accent: string | undefined; on: boolean; onPick(): void }) {
  const t = tokensOf(theme, accent);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      title={theme.name}
      className={cx("flex w-[132px] flex-col gap-1.5 rounded-xl border-2 p-1.5 text-left", on ? "border-accent" : "border-transparent hover:border-line-strong")}
    >
      <span className="flex h-[70px] w-full gap-1.5 overflow-hidden rounded-lg p-1.5" style={{ background: t.ground, border: `1px solid ${t.line}` }}>
        <span className="h-full w-7 rounded" style={{ background: t.panel }} />
        <span className="flex grow flex-col gap-1.5 rounded p-1.5" style={{ background: t.panel }}>
          <span className="h-1.5 w-4/5 rounded-full" style={{ background: t.ink }} />
          <span className="h-1.5 w-3/5 rounded-full" style={{ background: t["ink-2"] }} />
          <span className="mt-auto flex items-center justify-between">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.good }} />
            <span className="h-3 w-9 rounded" style={{ background: t.accent }} />
          </span>
        </span>
      </span>
      <span className={cx("px-0.5 text-xs", on ? "font-semibold text-ink" : "text-ink-2")}>{theme.name}</span>
    </button>
  );
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
            title={name}
            onClick={() => onPick(name)}
            className={cx("flex h-7 w-7 items-center justify-center rounded-full border-2", name === current ? "border-ink-strong" : "border-transparent")}
            style={{ background: theme.accents[name] }}
          >
            {name === current && <Check size={13} strokeWidth={3} style={{ color: tokensOf(theme, name)["accent-ink"] }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * How Afflatus looks in this browser: a theme for the night and one for the day, which of the two is up,
 * and the accent. Kept in the browser, so that another screen can look another way.
 */
export function AppearanceCard() {
  const choice = useThemeChoice();
  const explain = useExplain();
  const hover = useHoverPlay();
  const inUse = themeInUse(choice);
  const night = THEMES.filter((t) => !t.light);
  const day = THEMES.filter((t) => t.light);
  // the accents of the families in play: the night theme's, and the day theme's when it is of another family
  const families = [...new Map([choice.night, choice.day].map((id) => THEMES.find((t) => t.id === id) ?? THEMES[0]!).map((t) => [t.family, t])).values()];
  const pickAccent = (family: string, name: string) => choice.set({ accents: { ...choice.accents, [family]: name } });
  return (
    <section className="flex flex-col gap-3.5 rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-bold">Appearance</h2>
        <div className="w-64">
          <Segmented label="Theme mode" value={choice.mode} onChange={(mode) => choice.set({ mode })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
        </div>
      </div>
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
      <div className="border-t border-line pt-3">
        <Toggle on={explain.on} onChange={explain.set} label="Explain every setting in the forms" note="Off: the explanation of a setting sits behind the ? beside its name. On: it is written under each setting." />
        <Toggle on={hover.video} onChange={(video) => hover.set({ video })} label="Play videos when the mouse rests on a card" note="Off: a video card shows its frame until you open it." />
        <Toggle on={hover.sound} onChange={(sound) => hover.set({ sound })} label="Play sound on hover" note="The sound of a video playing on hover, and of a sound card. Off: videos play muted and sound cards stay silent until opened." />
      </div>
      <span className="text-xs text-ink-2">Kept in this browser. The palettes are Catppuccin's and Rosé Pine's own.</span>
    </section>
  );
}

/** In the rail: from the night theme to the day theme and back. */
export function ThemeFlip() {
  const choice = useThemeChoice();
  const light = themeInUse(choice).light;
  return (
    <button
      type="button"
      aria-label={light ? "Switch to the dark theme" : "Switch to the light theme"}
      title={light ? "Dark theme" : "Light theme"}
      onClick={() => choice.set({ mode: light ? "dark" : "light" })}
      className="flex h-10 w-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink"
    >
      {light ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  );
}
