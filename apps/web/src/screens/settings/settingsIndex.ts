/** The tabs of Settings and every setting by the words someone would look for: the screen's search and the command bar's `/` read them. */

export const TABS = [
  { id: "comfyui", label: "ComfyUI" },
  { id: "models", label: "Models" },
  { id: "designer", label: "Designer" },
  { id: "prompts", label: "Prompts" },
  { id: "interface", label: "Interface" },
  { id: "bar", label: "Command bar" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
] as const;
export type Tab = (typeof TABS)[number]["id"];

/** Tabs that were merged into another: an old address (/settings/appearance) still opens the right one. */
export const MOVED: Record<string, Tab> = { appearance: "interface", notifications: "interface" };

/**
 * Every setting, by the words someone would look for: what the search box finds, and the tab it is on. `key`: the
 * anchor its row carries (`data-setting`, see `settingHref`); `also`: the command bar's ids of the same setting,
 * found on the same row; `near`: where to land when the row is not shown (the key only shows with lookups on).
 */
export interface SettingSpot {
  tab: Tab;
  label: string;
  key: string;
  also?: string[];
  near?: string;
  words?: string;
}

export const INDEX: SettingSpot[] = [
  { tab: "comfyui", label: "ComfyUI URL", key: "comfy.url", words: "address connection test port 8188" },
  { tab: "comfyui", label: "Folder on this computer", key: "comfy.folder", words: "comfyui folder open in comfyui directory main.py" },
  { tab: "comfyui", label: "Node pack", key: "comfy.pack", words: "custom_nodes afflatus-nodes minimax h3 latent install" },
  { tab: "comfyui", label: "Unload models after", key: "comfy.unload", words: "vram free idle minutes never" },
  { tab: "models", label: "Models", key: "models.families", words: "models on or off in the lists families switch hide" },
  { tab: "models", label: "What is ready", key: "models.ready", words: "missing files nodes operations" },
  { tab: "models", label: "Files in use", key: "models.files", near: "models.families", words: "which file several fit checkpoint text encoder vae slot automatic pick choose" },
  { tab: "models", label: "Civitai API key", key: "models.civitaiKey", near: "server.civitaiLookups", words: "token" },
  { tab: "models", label: "Search Hugging Face and Civitai", key: "server.civitaiLookups", words: "civitai lookups search trigger words model pages lora names missing" },
  { tab: "models", label: "Download missing models", key: "server.downloadModels", words: "download missing files into comfyui manager" },
  { tab: "models", label: "Download a model from a URL", key: "models.link", near: "server.downloadModels", words: "link hugging face civitai get" },
  { tab: "models", label: "Newer versions on Civitai", key: "models.updates", also: ["server.updateChecks"], words: "newer versions of your models update check once a day lora checkpoint version" },
  { tab: "designer", label: "LLMs", key: "designer.llms", words: "language model base url api key vision openai" },
  { tab: "designer", label: "System prompts", key: "designer.notes", words: "instructions designer standing" },
  { tab: "prompts", label: "Prompting guides", key: "prompts.guides", words: "prompting guides per model designer rules examples family guide" },
  { tab: "designer", label: "Context size", key: "designer.context", near: "designer.llms", words: "llm tokens context window" },
  { tab: "designer", label: "Max output tokens", key: "designer.tokens", near: "designer.llms", words: "llm thinking answer length" },
  { tab: "designer", label: "Clear every conversation", key: "designer.forget", words: "forget every conversation chat history" },
  { tab: "prompts", label: "Danbooru tag check", key: "server.tagCheck", words: "typo tags" },
  { tab: "prompts", label: "Wildcards and weights", key: "prompts.wildcards", words: "wildcard {a|b} weight ctrl up down emphasis random choice" },
  { tab: "interface", label: "Dark theme · Light theme", key: "interface.theme", also: ["theme.mode", "theme.night", "theme.day"], words: "theme appearance dark light system accent catppuccin mocha macchiato frappe latte rose pine moon dawn studio neutral grey tokyo night day kanagawa wave lotus" },
  { tab: "interface", label: "Accent", key: "interface.accent", words: "accent colour color appearance theme" },
  { tab: "interface", label: "Explain every setting in the forms", key: "explain", words: "help tooltips" },
  { tab: "interface", label: "Play videos on hover", key: "hover.video", words: "mouse card preview" },
  { tab: "interface", label: "Play sound on hover", key: "hover.sound", words: "audio mouse card" },
  { tab: "interface", label: "Compare opens on original vs result", key: "compare.result", words: "compare pass upscale source wipe side by side" },
  { tab: "bar", label: "Shortcut", key: "bar.shortcut", words: "command bar shortcut ctrl k keyboard palette search" },
  { tab: "bar", label: "Learn what I use", key: "bar.learn", words: "command bar ranking recent" },
  { tab: "bar", label: "Preview", key: "bar.preview", words: "preview in the bar command bar shift side" },
  { tab: "bar", label: "Forget what I used", key: "bar.forget", words: "command bar recents ranking reset clear start over" },
  { tab: "bar", label: "Prompt snippets", key: "bar.snippets", words: "typed by name command bar ; expand" },
  { tab: "bar", label: "Prompt history", key: "bar.history", words: "in the bar command bar quote" },
  { tab: "bar", label: "Cast with @", key: "bar.cast", words: "command bar person people" },
  { tab: "storage", label: "Disk", key: "storage.disk", words: "disk usage space size" },
  { tab: "storage", label: "Bin", key: "storage.bin", words: "empty the bin trash delete" },
  { tab: "storage", label: "Takes that never play", key: "storage.idle", near: "storage.disk", words: "idle" },
  { tab: "storage", label: "Render times kept for", key: "storage.renderTimes", words: "history retention days forget" },
  { tab: "storage", label: "Forget every render time", key: "storage.forgetTimes", words: "estimates reset clear render stats history start again" },
  { tab: "storage", label: "Back up now", key: "storage.backup", words: "backup zip export restore database files" },
  { tab: "interface", label: "Notify when the queue is empty", key: "notify.empty", words: "notifications browser" },
  { tab: "interface", label: "Notify after each render", key: "notify.each", words: "notifications browser" },
  { tab: "about", label: "About Afflatus", key: "about.version", words: "version about license source github" },
  { tab: "about", label: "On this computer", key: "about.checks", words: "start-up checks startup ffmpeg ffprobe node data folder tools missing install path preflight" },
];

/** A tab's address: ComfyUI's is Settings itself. */
export const tabHref = (tab: Tab) => (tab === "comfyui" ? "/settings" : `/settings/${tab}`);

/** The setting of a key (or of one of the command bar's ids in `also`). */
export const spotOf = (key: string) => INDEX.find((i) => i.key === key || i.also?.includes(key));

/**
 * Where a setting is: its tab with `?find=<key>`. Settings opens the tab, scrolls to the row that carries
 * `data-setting="<key>"` and outlines it until the next click. A key it does not know opens `tab` (or Settings).
 */
export function settingHref(key: string, tab?: Tab): string {
  const spot = spotOf(key);
  if (!spot) return tabHref(tab ?? "comfyui");
  return `${tabHref(spot.tab)}?find=${encodeURIComponent(spot.key)}`;
}
