import type { Settings } from "../api";
import { INDEX, TABS, type Tab } from "../screens/settings/settingsIndex";
import { allowNotifications, useExplain, useHoverPlay, useNotify } from "../store";
import { useThemeChoice } from "../theme/store";
import { THEMES } from "../theme/themes";
import { useBar } from "./store";

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
  kind: "switch" | "choice" | "page";
  get?(ctx: SettingCtx): boolean | string | undefined;
  set?(ctx: SettingCtx, value: boolean | string): void | Promise<void>;
  options?(ctx: SettingCtx): Array<{ value: string; label: string }>;
}

export const pageLabel = (tab: Tab) => TABS.find((t) => t.id === tab)?.label ?? "Settings";
export const pageHref = (tab: Tab) => (tab === "comfyui" ? "/settings" : `/settings/${tab}`);

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
  { id: "hover.video", label: "Play videos on hover", page: "appearance", words: "mouse card preview", scope: "this browser", kind: "switch", about: "Videos in the library play, muted, while the mouse rests on them. Off: a video card shows its frame until you open it.", get: () => useHoverPlay.getState().video, set: (_c, v) => useHoverPlay.getState().set({ video: Boolean(v) }) },
  { id: "hover.sound", label: "Play sound on hover", page: "appearance", words: "audio mouse card", scope: "this browser", kind: "switch", about: "The sound of a video playing on hover, and of a sound card. Off: they stay silent until opened.", get: () => useHoverPlay.getState().sound, set: (_c, v) => useHoverPlay.getState().set({ sound: Boolean(v) }) },
  { id: "explain", label: "Explain every setting in the forms", page: "appearance", words: "help tooltips notes", scope: "this browser", kind: "switch", about: "On: a line under each setting of a form says what it does. Off: it sits behind the ? beside its name.", get: () => useExplain.getState().on, set: (_c, v) => useExplain.getState().set(Boolean(v)) },
  {
    id: "theme.mode", label: "Theme: dark, light or the system's", page: "appearance", words: "dark light system mode night day", scope: "this browser", kind: "choice", about: "Which of your two themes is up: the dark one, the light one, or the one your system says.",
    get: () => useThemeChoice.getState().mode,
    set: (_c, v) => useThemeChoice.getState().set({ mode: v as "dark" | "light" | "system" }),
    options: () => [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }],
  },
  {
    id: "theme.night", label: "Dark theme", page: "appearance", words: "theme palette colours catppuccin rose pine", scope: "this browser", kind: "choice", about: "The theme shown while the dark one is up.",
    get: () => useThemeChoice.getState().night,
    set: (_c, v) => { const s = useThemeChoice.getState(); s.set({ night: String(v), mode: s.mode === "light" ? "dark" : s.mode }); },
    options: () => THEMES.filter((t) => !t.light).map((t) => ({ value: t.id, label: t.name })),
  },
  {
    id: "theme.day", label: "Light theme", page: "appearance", words: "theme palette colours latte dawn", scope: "this browser", kind: "choice", about: "The theme shown while the light one is up. Pictures and videos stay on a dark stage.",
    get: () => useThemeChoice.getState().day,
    set: (_c, v) => { const s = useThemeChoice.getState(); s.set({ day: String(v), mode: s.mode === "dark" ? "light" : s.mode }); },
    options: () => THEMES.filter((t) => t.light).map((t) => ({ value: t.id, label: t.name })),
  },
  { id: "notify.each", label: "Notify after each render", page: "notifications", words: "browser notification done finished", scope: "this browser", kind: "switch", about: "A notification of this browser when a render finishes or fails.", get: () => useNotify.getState().eachRender, set: async (_c, v) => { if (!v || (await allowNotifications())) useNotify.getState().set({ eachRender: Boolean(v) }); } },
  { id: "notify.empty", label: "Notify when the queue is empty", page: "notifications", words: "browser notification done", scope: "this browser", kind: "switch", about: "A notification of this browser when everything that was waiting is done.", get: () => useNotify.getState().whenEmpty, set: async (_c, v) => { if (!v || (await allowNotifications())) useNotify.getState().set({ whenEmpty: Boolean(v) }); } },
  server("tagCheck", "Danbooru tag check", "prompts", "Tags written for an anime model are compared with danbooru's list: another name or a typo is pointed out under the prompt.", "typo tags anime"),
  server("civitaiLookups", "Civitai lookups", "models", "Missing model files, trigger words and model pages may be looked for on Civitai (file hashes are sent).", "trigger words lora names"),
  server("downloadModels", "Download missing files into ComfyUI", "models", "Missing model files may be fetched into ComfyUI, through ComfyUI-Manager.", "manager fetch"),
  server("updateChecks", "Check for newer versions of your models", "models", "Once a day, Civitai is asked for newer versions of the models here (lookups on; hashes are sent).", "update civitai version"),
  { id: "bar.learn", label: "Learn what I use", page: "bar", words: "command bar ranking recent frequency", scope: "this browser", kind: "switch", about: "What you open often and lately comes first in the bar. Kept in this browser.", get: () => useBar.getState().learn, set: (_c, v) => useBar.getState().setLearn(Boolean(v)) },
  { id: "bar.preview", label: "Preview in the bar", page: "bar", words: "command bar shift", scope: "this browser", kind: "switch", about: "The selected result shown beside the list. Shift shows or hides it.", get: () => useBar.getState().preview, set: (_c, v) => useBar.getState().setPreview(Boolean(v)) },
  barPart("snippets", "Prompt snippets typed by name", "Type ; and a snippet's name in any prompt box: a space or Tab puts its text there.", "command bar ; expand kit"),
  barPart("history", "Prompt history in the bar", 'Type " in the bar to search every prompt that was rendered, with its render.', "command bar quote prompts"),
  barPart("cast", "Cast with @", "Type @ in the bar to add a person of the Prompt kit to the open draft.", "command bar person people kit"),
];

/** Every other setting of the Settings screen: found, and opened on its page. */
export const PAGES: SettingEntry[] = INDEX.filter((i) => !SETTINGS.some((s) => s.label.toLowerCase() === i.label.toLowerCase())).map((i) => ({
  id: `page.${i.tab}.${i.label}`, label: i.label, page: i.tab, words: i.words, kind: "page" as const,
}));

/** A setting's value, said: on/off, the choice's name. */
export function valueSaid(s: SettingEntry, ctx: SettingCtx): string {
  if (s.kind === "page" || !s.get) return "";
  const v = s.get(ctx);
  if (s.kind === "switch") return v === undefined ? "…" : v ? "on" : "off";
  return s.options?.(ctx).find((o) => o.value === v)?.label ?? String(v ?? "");
}
