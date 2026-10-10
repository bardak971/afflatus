import type { Settings } from "../api";
import { INDEX, settingHref, TABS, type Tab } from "../screens/settings/settingsIndex";
import { allowNotifications, useBanners, useExplain, useHoverPlay, useNotify } from "../store";
import { useThemeChoice } from "../theme/store";
import { THEMES } from "../theme/themes";
import { ask } from "../Confirm";
import { save as saveRanks } from "./rank";
import { useBar } from "./store";

/** The names of the dark or the light themes, words a theme choice is found by ("tokyo", "kanagawa"). */
const themeNames = (light: boolean) => THEMES.filter((t) => Boolean(t.light) === light).map((t) => t.name.toLowerCase()).join(" ");

/**
 * The settings the bar's `/` finds: the switches and choices it flips in place (each read and written the
 * way its own page does it), then every other setting, which opens its page. Server settings are saved
 * whole where the server wants them whole (`bar`).
 */

export interface SettingCtx {
  server: Settings | undefined;
  save(patch: Partial<Settings>): Promise<void>;
}

export interface SettingEntry {
  id: string;
  label: string;
  page: Tab;
  /** Words it is also found by. */
  words?: string;
  /** What it does, for the preview. */
  about?: string;
  /** Where it is kept. */
  scope?: "this browser" | "Afflatus";
  /** A switch or a choice flipped in place; a page opened at its row; an action run (asked first where the page asks). */
  kind: "switch" | "choice" | "page" | "action";
  get?(ctx: SettingCtx): boolean | string | undefined;
  set?(ctx: SettingCtx, value: boolean | string): void | Promise<void>;
  options?(ctx: SettingCtx): Array<{ value: string; label: string }>;
  /** An action's run, and what Enter does in a word. */
  run?(): unknown;
  verb?: string;
}

/**
 * A notification switch, as Settings › Interface turns it: on asks the browser for the right first, and a refusal is said
 * (the page shows "Blocked by the browser"; the bar has no row for it, so a banner says it).
 */
async function notifySwitch(what: "eachRender" | "whenEmpty", on: boolean) {
  if (on && !(await allowNotifications())) {
    useBanners.getState().push({ id: "bar:notify", tone: "bad", title: "Notifications are blocked by the browser", text: "Allow them for this page next to the address, then switch it on again.", href: settingHref(`notify.${what === "eachRender" ? "each" : "empty"}`), go: "Open Settings › Interface" });
    return;
  }
  useNotify.getState().set({ [what]: on });
}

export const pageLabel = (tab: Tab) => TABS.find((t) => t.id === tab)?.label ?? "Settings";

const server = (key: "tagCheck" | "civitaiLookups" | "downloadModels" | "updateChecks", label: string, page: Tab, about: string, words?: string): SettingEntry => ({
  id: `server.${key}`, label, page, about, words, scope: "Afflatus", kind: "switch",
  get: (c) => c.server?.[key],
  set: (c, v) => c.save({ [key]: Boolean(v) }),
});
const barPart = (key: "snippets" | "history" | "cast", label: string, about: string, words: string): SettingEntry => ({
  id: `bar.${key}`, label, page: "bar", about, words, scope: "Afflatus", kind: "switch",
  get: (c) => c.server?.bar?.[key],
  // the server takes `bar` whole: a part of it alone would reset the others
  set: (c, v) => (c.server?.bar ? c.save({ bar: { ...c.server.bar, [key]: Boolean(v) } }) : undefined),
});

export const SETTINGS: SettingEntry[] = [
  { id: "hover.video", label: "Play videos on hover", page: "interface", words: "mouse card preview", scope: "this browser", kind: "switch", about: "Videos in the library play, muted, while the mouse rests on them. Off: a video card shows its frame until you open it.", get: () => useHoverPlay.getState().video, set: (_c, v) => useHoverPlay.getState().set({ video: Boolean(v) }) },
  { id: "hover.sound", label: "Play sound on hover", page: "interface", words: "audio mouse card", scope: "this browser", kind: "switch", about: "The sound of a video playing on hover, and of a sound card. Off: they stay silent until opened.", get: () => useHoverPlay.getState().sound, set: (_c, v) => useHoverPlay.getState().set({ sound: Boolean(v) }) },
  { id: "explain", label: "Explain every setting in the forms", page: "interface", words: "help tooltips notes", scope: "this browser", kind: "switch", about: "On: a line under each setting of a form says what it does. Off: it sits behind the ? beside its name.", get: () => useExplain.getState().on, set: (_c, v) => useExplain.getState().set(Boolean(v)) },
  {
    id: "theme.mode", label: "Theme: dark, light or the system's", page: "interface", words: "dark light system mode night day", scope: "this browser", kind: "choice", about: "Which of your two themes is up: the dark one, the light one, or the one your system says.",
    get: () => useThemeChoice.getState().mode,
    set: (_c, v) => useThemeChoice.getState().set({ mode: v as "dark" | "light" | "system" }),
    options: () => [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }],
  },
  {
    id: "theme.night", label: "Dark theme", page: "interface", words: `theme palette colours ${themeNames(false)}`, scope: "this browser", kind: "choice", about: "The theme shown while the dark one is up.",
    get: () => useThemeChoice.getState().night,
    set: (_c, v) => { const s = useThemeChoice.getState(); s.set({ night: String(v), mode: s.mode === "light" ? "dark" : s.mode }); },
    options: () => THEMES.filter((t) => !t.light).map((t) => ({ value: t.id, label: t.name })),
  },
  {
    id: "theme.day", label: "Light theme", page: "interface", words: `theme palette colours ${themeNames(true)}`, scope: "this browser", kind: "choice", about: "The theme shown while the light one is up. Pictures and videos stay on a dark stage.",
    get: () => useThemeChoice.getState().day,
    set: (_c, v) => { const s = useThemeChoice.getState(); s.set({ day: String(v), mode: s.mode === "dark" ? "light" : s.mode }); },
    options: () => THEMES.filter((t) => t.light).map((t) => ({ value: t.id, label: t.name })),
  },
  { id: "notify.each", label: "Notify after each render", page: "interface", words: "browser notification done finished", scope: "this browser", kind: "switch", about: "A notification of this browser when a render finishes or fails.", get: () => useNotify.getState().eachRender, set: (_c, v) => notifySwitch("eachRender", Boolean(v)) },
  { id: "notify.empty", label: "Notify when the queue is empty", page: "interface", words: "browser notification done", scope: "this browser", kind: "switch", about: "A notification of this browser when everything that was waiting is done.", get: () => useNotify.getState().whenEmpty, set: (_c, v) => notifySwitch("whenEmpty", Boolean(v)) },
  { id: "notify.banner", label: "Banner when renders finish", page: "interface", words: "toast banner done finished popup announce quiet", scope: "this browser", kind: "switch", about: "A banner over the screen when renders finish while another screen is open. Off: only failures are announced.", get: () => useNotify.getState().banner, set: (_c, v) => useNotify.getState().set({ banner: Boolean(v) }) },
  {
    id: "storage.unkeptDays", label: "Unkept renders go to the bin after", page: "storage", words: "expire expiring countdown not kept auto bin day never keep everything", scope: "Afflatus", kind: "choice",
    about: "How long a render nobody kept has before it goes to the bin by itself. Never: nothing goes on its own.",
    get: (c) => (c.server ? String(c.server.unkeptDays) : undefined),
    set: (c, v) => c.save({ unkeptDays: Number(v) as 0 | 1 | 3 | 7 }),
    options: () => [{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "A week" }, { value: "0", label: "Never" }],
  },
  {
    id: "storage.binDays", label: "Keep what is in the bin", page: "storage", words: "bin retention erase delete week 30 days until emptied trash", scope: "Afflatus", kind: "choice",
    about: "How long the bin holds what was moved to it before it is erased. Until emptied: nothing is erased until you empty it.",
    get: (c) => (c.server ? String(c.server.binDays) : undefined),
    set: (c, v) => c.save({ binDays: Number(v) as 0 | 7 | 30 }),
    options: () => [{ value: "7", label: "A week" }, { value: "30", label: "30 days" }, { value: "0", label: "Until emptied" }],
  },
  server("tagCheck", "Danbooru tag check", "prompts", "Tags written for an anime model are compared with danbooru's list: another name or a typo is pointed out under the prompt.", "typo tags anime"),
  server("civitaiLookups", "Search Hugging Face and Civitai", "models", "Missing model files, trigger words and model pages may be looked for on Hugging Face and Civitai (file hashes are sent).", "civitai lookups trigger words lora names"),
  server("downloadModels", "Download missing models", "models", "Missing model files may be fetched into ComfyUI, through ComfyUI-Manager.", "download missing files into comfyui manager fetch"),
  server("updateChecks", "Newer versions on Civitai: check once a day", "models", "Once a day, Civitai is asked for newer versions of the models here (with Search Hugging Face and Civitai on; hashes are sent).", "check for newer versions of your models update civitai version"),
  { id: "bar.learn", label: "Learn what I use", page: "bar", words: "command bar ranking recent frequency", scope: "this browser", kind: "switch", about: "What you open often and lately comes first in the bar. Kept in this browser.", get: () => useBar.getState().learn, set: (_c, v) => useBar.getState().setLearn(Boolean(v)) },
  { id: "bar.preview", label: "Preview", page: "bar", words: "preview in the bar command bar shift", scope: "this browser", kind: "switch", about: "The selected result shown beside the list. Shift shows or hides it.", get: () => useBar.getState().preview, set: (_c, v) => useBar.getState().setPreview(Boolean(v)) },
  barPart("snippets", "Prompt snippets", "Type ; and a snippet's name in any prompt box: a space or Tab puts its text there.", "typed by name command bar ; expand kit"),
  barPart("history", "Prompt history", 'Type " in the bar to search every prompt that was rendered, with its render.', "in the bar command bar quote prompts"),
  barPart("cast", "Cast with @", "Type @ in the bar to add a person of the Prompt kit to the clip selected in the timeline editor, else to the open draft.", "command bar person people kit clip"),
  {
    id: "bar.forget", label: "Forget what I used", page: "bar", words: "command bar recents ranking reset clear start over", scope: "this browser", kind: "action", verb: "forget",
    about: "Recents and ranking start over. Asked first.",
    run: async () => {
      if (await ask({ title: "Forget what you used?", text: "The bar's recents and ranking start over, in this browser.", yes: "Forget" })) saveRanks({});
    },
  },
];

/**
 * Every other setting of the Settings screen: found, and opened on its page at its row (its id is the index's key: `settingHref`).
 * A row the bar already flips in place is left out, found by its key, by the bar's ids it lists in `also` (the theme row stands for
 * the three theme choices), or by its name.
 */
export const PAGES: SettingEntry[] = INDEX.filter((i) => !SETTINGS.some((s) => s.id === i.key || i.also?.includes(s.id) || s.label.toLowerCase() === i.label.toLowerCase())).map((i) => ({
  id: i.key, label: i.label, page: i.tab, words: i.words, kind: "page" as const,
}));

/** A rank learned under a page setting's old id ("set:page.<tab>.<label>", before they took the index's key): its key now, else as it was. */
export function settingKeyNow(key: string): string {
  if (!key.startsWith("set:page.")) return key;
  const page = PAGES.find((p) => key === `set:page.${p.page}.${p.label}`);
  return page ? `set:${page.id}` : key;
}

/** A setting's value, said: on/off, the choice's name. */
export function valueSaid(s: SettingEntry, ctx: SettingCtx): string {
  if (s.kind === "page" || !s.get) return "";
  const v = s.get(ctx);
  if (s.kind === "switch") return v === undefined ? "…" : v ? "on" : "off";
  return s.options?.(ctx).find((o) => o.value === v)?.label ?? String(v ?? "");
}
