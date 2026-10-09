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

/** Every setting, by the words someone would look for: what the search box finds, and the tab it is on. */
export const INDEX: Array<{ tab: Tab; label: string; words?: string }> = [
  { tab: "comfyui", label: "ComfyUI URL", words: "address connection test port 8188" },
  { tab: "comfyui", label: "Folder on this computer", words: "comfyui folder open in comfyui directory main.py" },
  { tab: "comfyui", label: "Node pack", words: "custom_nodes afflatus-nodes minimax h3 latent install" },
  { tab: "comfyui", label: "Unload models after", words: "vram free idle minutes never" },
  { tab: "models", label: "Models", words: "models on or off in the lists families switch hide" },
  { tab: "models", label: "What is ready", words: "missing files nodes operations" },
  { tab: "models", label: "Civitai API key", words: "token" },
  { tab: "models", label: "Search Hugging Face and Civitai", words: "civitai lookups search trigger words model pages lora names missing" },
  { tab: "models", label: "Download missing models", words: "download missing files into comfyui manager" },
  { tab: "models", label: "Download a model from a URL", words: "link hugging face civitai get" },
  { tab: "models", label: "Newer versions on Civitai", words: "newer versions of your models update check once a day lora checkpoint version" },
  { tab: "designer", label: "LLMs", words: "language model base url api key vision openai" },
  { tab: "designer", label: "System prompts", words: "instructions designer standing" },
  { tab: "prompts", label: "Prompting guides", words: "prompting guides per model designer rules examples family guide" },
  { tab: "designer", label: "Context size", words: "llm tokens context window" },
  { tab: "designer", label: "Max output tokens", words: "llm thinking answer length" },
  { tab: "designer", label: "Clear every conversation", words: "forget every conversation chat history" },
  { tab: "prompts", label: "Danbooru tag check", words: "typo tags" },
  { tab: "interface", label: "Theme", words: "appearance dark light system accent catppuccin mocha macchiato frappe latte rose pine moon dawn studio neutral grey tokyo night day kanagawa wave lotus" },
  { tab: "interface", label: "Accent colour", words: "appearance color" },
  { tab: "interface", label: "Explain every setting in the forms", words: "help tooltips" },
  { tab: "interface", label: "Play videos on hover", words: "mouse card preview" },
  { tab: "interface", label: "Play sound on hover", words: "audio mouse card" },
  { tab: "bar", label: "Shortcut", words: "command bar shortcut ctrl k keyboard palette search" },
  { tab: "bar", label: "Learn what I use", words: "command bar ranking recent" },
  { tab: "bar", label: "Prompt snippets", words: "typed by name command bar ; expand" },
  { tab: "bar", label: "Prompt history", words: "in the bar command bar quote" },
  { tab: "bar", label: "Cast with @", words: "command bar person people" },
  { tab: "storage", label: "Disk", words: "disk usage space size" },
  { tab: "storage", label: "Bin", words: "empty the bin trash delete" },
  { tab: "storage", label: "Takes that never play", words: "idle" },
  { tab: "storage", label: "Render times kept for", words: "history retention days forget" },
  { tab: "storage", label: "Back up now", words: "backup zip export restore database files" },
  { tab: "interface", label: "Notify when the queue is empty", words: "notifications browser" },
  { tab: "interface", label: "Notify after each render", words: "notifications browser" },
  { tab: "about", label: "Version", words: "about license source github" },
  { tab: "about", label: "Start-up checks: ffmpeg, ffprobe, Node, data folder", words: "tools missing install path preflight" },
];
