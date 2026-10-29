/**
 * The "?" text of the settings an agent may change through MCP (server mcpSettings.ts), by setting key or dotted path: one
 * text, read by the Settings page's rows and by MCP's read_settings and change_setting, so that what the page explains and
 * what an agent is told never drift apart. A setting the page explains with words built as it renders (a machine's name in
 * them) keeps its own; one the page explains nowhere (a dialog's remembered choices) is said here from what it does.
 */
export const SETTING_HELP = {
  unloadAfterMinutes: `Minutes without a render, then ComfyUI's models are unloaded and the VRAM is freed; the next render loads them again. 0 = never: they stay loaded until something else needs the VRAM. "Unload models" in the Queue does it by hand. With several ComfyUIs, each counts from its own last render.`,
  tagCheck: "For tag prompts (SDXL: Illustrious, NoobAI, Pony). Anime models learned danbooru's tags: another word does little, a typo nothing. One line under the prompt says how many tags are not on the list and opens the fixes; what the designer writes is put right the same way. The list is a file of Afflatus's: nothing is sent anywhere.",
  families: "Each model family on each machine: ready, how many of its operations are, off there (switched off, its files there), no files there, or away (not answering). Click a cell for that machine's tab. The switch turns the family off on every machine (out of the model lists), or back on wherever its files are.",
  allFamilies: "On: a family not switched by hand is on whatever files are found; its files are listed greyed until they are there (fetched by a pod, downloaded into a ComfyUI of your own). Off: a family not switched by hand follows its files, offered when they are found and left out when they are not.",
  slotFiles: "Where several files fit a family's slot (a checkpoint, a text encoder, a VAE), the one chosen by hand: family id, then slot id, then the file. A slot not named takes the file its patterns find first.",
  designerLlm: "The LLM the designer writes with (an id of the LLMs set in Settings › Designer); the first when none is named. Picked in the designer's panel, remembered for the next conversation.",
  designerInstructions: `Standing instructions of your own, each under a name, picked in the designer's panel for a draft or a clip; the one picked holds for every answer of that conversation. They are added after the model's prompting guide (Settings › Prompts) and WIN over it: an instruction that says "always name the focal length" brings the lens back into every prompt, which the guides now avoid unless the picture calls for it. Say what the guide cannot know: your taste, your subject matter, your limits.`,
  designerInstruction: "The system prompt in use (an id of the system prompts); empty: none. Picked in the designer's panel, remembered for the next conversation.",
  designerGuides: "How each model family's prompts are written, as the designer is told first: the rules of the model's own guide, and one example of the form. Change a family's text and yours replaces the built-in one for that family; the eye in the designer panel shows the whole system prompt as it is sent.",
  rentCaps: "At a cap, the render running finishes, then the pods stop; what waits goes to your other machines, and Start and Deploy say the cap is reached. Empty: no cap. The day cap is compute only, the month cap the whole bill. Both are RunPod's bill, its last hours counted here.",
  costs: "What a kWh costs you, in your own money. Queue › Costs multiplies it by the energy the GPU drew while each render ran on this PC (read by the Afflatus node pack on an NVIDIA GPU). Empty: the energy alone is shown. Rented GPUs are priced by the hour, not by this.",
  volumeUnusedDays: "A network volume no pod ran on for this long is flagged here and on the tab: it bills every month all the same.",
  bootLogDays: "A deployed pod's boot log, kept with its run in Queue › Costs (its row's \"boot log\"): RunPod's system log of the image's pull, layer by layer, and the pod's own boot log, up to ComfyUI's first answer. RunPod drops both when the pod is terminated; kept, they tell a pull that never began (RunPod's side) from one that crawled (the host's link). Dropped after the days set. The pull's speed and size are kept with each run either way.",
  civitaiLookups: `On: when a model file is missing, "Search" asks Hugging Face for a file of exactly that name, and Civitai (civitai.com and civitai.red) for models with a close name. What is found is shown with a link, and with a Download button when downloading is on. Your own model files are also matched once to the site that has them, so that a rented GPU fetches them from there instead of from this PC: Civitai is sent each file's SHA-256 (a fingerprint of its content, not the file), Hugging Face its name. Off: Afflatus never contacts Hugging Face or Civitai; missing models still get links that open a search in your browser.`,
  updateChecks: "Once a day, Civitai is asked for newer versions of the models here (with Search Hugging Face and Civitai on; hashes are sent).",
  downloadModels: `On: a missing model file gets a "Download" button, from the URL the workflow's author gave, or from Civitai once it is found there. When Afflatus can write ComfyUI's model folders (ComfyUI on this machine), it downloads the file there itself: straight to disk, resumed after a cut, named only once complete, two at a time. Otherwise the Afflatus node pack does the same on ComfyUI's machine, or, last, ComfyUI-Manager saves it (the file passes through Afflatus, which shows the progress). Nothing is downloaded until you press the button. Off: Afflatus never downloads anything; missing models only get links to open in your browser.`,
  renderHistoryDays: `What the Queue's "Render times" and the estimates on the buttons are made from. Older renders are folded into one line per model and day, kept for good: the charts still reach back, the list does not.`,
  jobHistoryDays: "How long a done, failed or stopped job stays in the Queue's history before it is deleted from the database, checked every hour. A job still used is kept whatever its age: one whose result is in the library, on a clip, behind an export or a render time, or from a rented pod still running. The prompt history keeps the pictures and the settings either way. For good: no job is deleted.",
  unkeptDays: "A render nobody kept (S keeps one) goes to the bin by itself this long after it was made, or after it was unkept or put back. Never: nothing goes on its own, and the library keeps everything until you bin it. What is on a timeline is always kept.",
  binDays: "How long the bin holds what was moved to it before it is erased, file and all. Until emptied: nothing is erased until you empty the bin (here, in the bin's strip, or > empty the bin).",
  finish: "How Finish all clips brings a timeline to its final quality, the Finish dialog's defaults (each run can differ): the route (SeedVR2, H3's latent re-sample, RTX VSR, a pixel upscale model, H3's Face refine), its factor, the colour fix, and each route's own settings.",
  "bar.shortcut": "Opens the bar from anywhere, a text box included. Click it, then press the keys of the new one; Escape leaves it as it was.",
  "bar.snippets": "Type ;name in any prompt box, then a space or Tab: the snippet's text goes there.",
  "bar.cast": "Type @ in the bar to add a person of the Prompt kit to the clip selected in the timeline editor, else to the open draft.",
  pinnedProjects: "The projects pinned to the rail under the one worked in, in their order there (project ids, four at most): one click switches to each.",
  pinnedFields: "The settings pinned to the top of the model forms (right-click a setting's name: Pin to the top), kept per model family and shared by every browser. Forget takes every pin off: the forms lose their Pinned card; no value changes.",
  "notify.picture": "Telegram and Discord: a render done and the queue empty come with a small still of the result (a video's first frame), at most 1280 px.",
  "notify.events": "Per kind of notice (a render done or failed, the queue empty, a render stuck, a pod stopped, a cap reached, a low balance, ComfyUI gone, the GPU hunt's finds and give-ups), whether it goes to Telegram and to Discord. Where they go is set in Afflatus itself.",
} as const satisfies Record<string, string>;

export type SettingHelpKey = keyof typeof SETTING_HELP;

/** A setting's "?" text by its dotted path: its own, else the nearest setting it is part of ("rentCaps.day" → rentCaps). */
export function settingHelp(path: string): string | undefined {
  const help: Record<string, string> = SETTING_HELP;
  for (let parts = path.split("."); parts.length; parts = parts.slice(0, -1)) {
    const found = help[parts.join(".")];
    if (found) return found;
  }
  return undefined;
}

/** The tabs of Settings, in the order the page shows them: the web's settingsIndex.ts and MCP's show_page read them. */
export const SETTING_TABS = [
  { id: "comfyui", label: "ComfyUI" },
  { id: "rented", label: "Rented GPUs" },
  { id: "models", label: "Models" },
  { id: "designer", label: "Designer" },
  { id: "prompts", label: "Prompts" },
  { id: "interface", label: "Interface" },
  { id: "access", label: "Access" },
  { id: "bar", label: "Command bar" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
] as const;
export type SettingTab = (typeof SETTING_TABS)[number]["id"];
