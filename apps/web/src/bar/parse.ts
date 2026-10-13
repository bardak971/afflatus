/**
 * What is typed in the bar, read by fixed rules (never a language model): the mode its first character
 * picks, and in the command mode, which command and its figures. Pure, run at every keystroke.
 */

export type Mode = "all" | "command" | "place" | "setting" | "calc" | "queue" | "keys" | "history" | "cast";

/** The first character of what is typed, and the mode it opens. */
export const MODE_KEYS: Record<string, Mode> = { ">": "command", "#": "place", "/": "setting", "=": "calc", "!": "queue", "?": "keys", '"': "history", "@": "cast" };

/** The mode and what is typed after its character (trimmed at the start). History and cast only when they are on. */
export function modeOf(typed: string, optional: { history: boolean; cast: boolean } = { history: true, cast: true }): { mode: Mode; text: string } {
  const first = typed[0];
  const mode = first ? MODE_KEYS[first] : undefined;
  if (!mode || (mode === "history" && !optional.history) || (mode === "cast" && !optional.cast)) return { mode: "all", text: typed.trim() };
  return { mode, text: typed.slice(1).trimStart() };
}

export type Command =
  | { cmd: "render-clips"; clips: number[]; machine?: string }
  | { cmd: "render-missing"; machine?: string }
  | { cmd: "export" }
  | { cmd: "export-editor" }
  | { cmd: "seed"; value: number }
  | { cmd: "steps"; value: number }
  | { cmd: "cfg"; value: number }
  | { cmd: "size"; width: number; height: number }
  | { cmd: "length"; seconds: number }
  | { cmd: "load"; model: string }
  | { cmd: "load-panel"; machine?: string }
  | { cmd: "machines" }
  | { cmd: "machine-log"; machine: string }
  | { cmd: "machine-times"; machine: string }
  | { cmd: "machine-models"; machine: string }
  | { cmd: "new-draft"; recipe: string }
  | { cmd: "pause"; machine?: string }
  | { cmd: "resume"; machine?: string }
  | { cmd: "use-only"; machine: string }
  | { cmd: "empty-bin" }
  | { cmd: "put-back-all" }
  | { cmd: "bin-unused" }
  | { cmd: "link-folder"; path: string }
  | { cmd: "new-project"; name: string }
  | { cmd: "split" }
  | { cmd: "previous-take" }
  | { cmd: "next-take" }
  | { cmd: "mirror-pin"; off?: boolean }
  | { cmd: "cancel-waiting" }
  | { cmd: "retry-failed" }
  | { cmd: "dismiss-failed" }
  | { cmd: "group-queue" }
  | { cmd: "unload"; machine?: string }
  | { cmd: "generate"; machine?: string }
  | { cmd: "new-timeline"; name: string }
  | { cmd: "new-folder"; name: string }
  | { cmd: "import-workflow" }
  | { cmd: "finish" }
  | { cmd: "fix-all" }
  | { cmd: "view-last" }
  | { cmd: "reconnect" }
  | { cmd: KitNew; name: string }
  | { cmd: "preset"; name: string }
  | { cmd: "save-preset"; name: string }
  | { cmd: "undo" }
  | { cmd: "clip"; number: number };
export type CommandId = Command["cmd"];

/** A new entry of the Prompt kit, by its kind: `new person Ada`. */
export type KitNew = "new-person" | "new-place" | "new-style" | "new-preset" | "new-snippet";
/** The kind of the Prompt kit a `new …` command makes. */
export const KIT_OF: Record<KitNew, "person" | "place" | "style" | "preset" | "snippet"> = {
  "new-person": "person", "new-place": "place", "new-style": "style", "new-preset": "preset", "new-snippet": "snippet",
};

/**
 * Every command as it is offered before its figures are typed: its name, what to type, and an example. A
 * command whose figures are missing completes the bar to `typed` (Enter or Tab) rather than running.
 */
export const COMMANDS: Array<{ id: CommandId; name: string; typed: string; example: string; what: string; needs?: true }> = [
  { id: "render-clips", name: "Render clips…", typed: "render clips ", example: "render clips 3-5", what: "Clips of the open timeline, by their number", needs: true },
  { id: "render-missing", name: "Render missing clips", typed: "render missing", example: "render missing", what: "The clips of the open timeline that have no take" },
  { id: "export", name: "Export timeline", typed: "export", example: "export", what: "The open timeline as one video" },
  { id: "export-editor", name: "Export for a video editor", typed: "export for editor", example: "export for resolve", what: "The open timeline as its clips and a project file for DaVinci Resolve, Premiere Pro or Kdenlive" },
  { id: "finish", name: "Finish timeline…", typed: "finish", example: "finish", what: "The Finish dialog on the open timeline: every take upscaled to its final quality" },
  { id: "fix-all", name: "Fix all", typed: "fix all", example: "fix all", what: "What the open timeline's Needs attention lists, mended as its Fix all does" },
  { id: "generate", name: "Generate", typed: "generate", example: "generate", what: "The open draft, as its Generate button" },
  { id: "seed", name: "Set seed…", typed: "seed ", example: "seed 1234", what: "Of the open draft", needs: true },
  { id: "steps", name: "Set steps…", typed: "steps ", example: "steps 30", what: "Of the open draft", needs: true },
  { id: "cfg", name: "Set CFG…", typed: "cfg ", example: "cfg 4", what: "Of the open draft", needs: true },
  { id: "size", name: "Set size…", typed: "size ", example: "size 576x1024", what: "Of the open draft", needs: true },
  { id: "length", name: "Set length…", typed: "length ", example: "length 5s", what: "Of the open draft, in seconds", needs: true },
  { id: "preset", name: "Apply preset…", typed: "preset ", example: "preset night street", what: "A preset of the Prompt kit, on the open draft", needs: true },
  { id: "save-preset", name: "Save as preset…", typed: "save as preset ", example: "save as preset night street", what: "The open draft's model, form and cast, under a name", needs: true },
  { id: "load-panel", name: "Load a model…", typed: "load a model", example: "load a model on second gpu", what: "The Load a model panel: this form's model, a recent draft's, or any by name; on Auto or a machine" },
  { id: "load", name: "Load model…", typed: "load ", example: "load h3", what: "Its models into ComfyUI, ahead of a render", needs: true },
  { id: "unload", name: "Unload models", typed: "unload models", example: "unload models", what: "ComfyUI's models out of memory, as the Queue's button; not while a render runs" },
  { id: "new-draft", name: "New draft…", typed: "new draft ", example: "new draft klein", what: "On a model of your choice", needs: true },
  { id: "new-timeline", name: "New timeline", typed: "new timeline ", example: "new timeline Harbor cut", what: "In the project you work in, named or not; opens in the editor" },
  { id: "new-folder", name: "New folder…", typed: "new folder ", example: "new folder shots", what: "At the top of the project you work in", needs: true },
  { id: "new-project", name: "New project…", typed: "new project ", example: "new project Harbor", what: "Made and worked in", needs: true },
  { id: "new-person", name: "New person…", typed: "new person ", example: "new person Ada", what: "In the Prompt kit, opened there", needs: true },
  { id: "new-place", name: "New place…", typed: "new place ", example: "new place Harbor", what: "In the Prompt kit, opened there", needs: true },
  { id: "new-style", name: "New style…", typed: "new style ", example: "new style Noir", what: "In the Prompt kit, opened there", needs: true },
  { id: "new-preset", name: "New preset…", typed: "new preset ", example: "new preset Night street", what: "In the Prompt kit, opened there", needs: true },
  { id: "new-snippet", name: "New snippet…", typed: "new snippet ", example: "new snippet Cine look", what: "In the Prompt kit, its text written there", needs: true },
  { id: "import-workflow", name: "Import workflow…", typed: "import workflow", example: "import workflow", what: "A ComfyUI workflow from a file (.json, PNG or MP4), as the Workflows screen's Import" },
  { id: "link-folder", name: "Link folder…", typed: "link folder ", example: "link folder D:\\shoots", what: "Used in place, nothing copied" },
  { id: "pause", name: "Pause queue", typed: "pause queue", example: "pause queue", what: "What runs finishes; nothing new starts" },
  { id: "resume", name: "Resume queue", typed: "resume queue", example: "resume queue", what: "What waits starts again" },
  { id: "machines", name: "Show the ComfyUIs", typed: "machines", example: "comfyuis", what: "With several ComfyUIs: the status bar's panel of every machine, its figures, its pause and its menu" },
  { id: "machine-log", name: "ComfyUI log of…", typed: "log ", example: "log second gpu", what: "With several ComfyUIs: that machine's console, in the Queue", needs: true },
  { id: "machine-times", name: "Render times of…", typed: "render times ", example: "render times second gpu", what: "With several ComfyUIs: what that machine rendered and how long it took", needs: true },
  { id: "machine-models", name: "Models on…", typed: "models on ", example: "models on second gpu", what: "With several ComfyUIs: Settings › Models, that machine's tab: what it has, its switches, downloads to it", needs: true },
  { id: "use-only", name: "Use only…", typed: "use only ", example: "use only second gpu", what: "With several ComfyUIs: every other one paused, everything waiting goes to this one", needs: true },
  { id: "empty-bin", name: "Empty the bin…", typed: "empty the bin", example: "empty the bin", what: "Erases what is in the bin, asked first" },
  { id: "put-back-all", name: "Put all back", typed: "put all back", example: "put all back", what: "Everything in the bin back where it was, as the bin's Put all back" },
  { id: "bin-unused", name: "Bin unused takes…", typed: "bin unused takes", example: "bin unused takes", what: "Of the open timeline, asked first" },
  { id: "clip", name: "Go to clip…", typed: "clip ", example: "clip 3", what: "In the open timeline: selected, the playhead on its start", needs: true },
  { id: "undo", name: "Undo", typed: "undo", example: "undo", what: "The open editor's last change, else the move or bin a banner offers to undo" },
  { id: "split", name: "Split clip at playhead", typed: "split", example: "split", what: "The clip selected in the open timeline, as its key in the editor" },
  { id: "previous-take", name: "Previous take", typed: "previous take", example: "prev take", what: "The selected clip plays its take before, as its key in the editor" },
  { id: "next-take", name: "Next take", typed: "next take", example: "next take", what: "The selected clip plays its take after, as its key in the editor" },
  { id: "mirror-pin", name: "Mirror pinned frame", typed: "mirror pin", example: "mirror pin", what: "A pinned frame of the selected clip flipped at render time (or back: mirror pin off), as its right-click menu" },
  { id: "cancel-waiting", name: "Cancel all waiting…", typed: "cancel waiting", example: "cancel waiting", what: "Every waiting job, asked first; the running one goes on" },
  { id: "retry-failed", name: "Retry all failed", typed: "retry failed", example: "retry failed", what: "The failed jobs the queue lists, queued again oldest first" },
  { id: "dismiss-failed", name: "Dismiss all failed…", typed: "dismiss failed", example: "dismiss failed", what: "The failed jobs the queue lists, off the history, asked first" },
  { id: "group-queue", name: "Group by model", typed: "group by model", example: "group by model", what: "Same model together, the loaded one first" },
  { id: "view-last", name: "View last render", typed: "view last render", example: "last render", what: "What the last finished job made, in the viewer" },
  { id: "reconnect", name: "Reconnect to ComfyUI", typed: "reconnect", example: "reconnect", what: "ComfyUI asked again now: its address, its files, its nodes" },
];

const NUMBER = String.raw`(-?\d+(?:[.,]\d+)?)`;
const num = (s: string) => Number(s.replace(",", "."));

/**
 * Clip numbers: "3-5", "3–5", "3, 4, 7", "2 4", "3 to 5", "3..5". In order, each once, at most 200 of
 * them. Null when there is none or one is not a number.
 */
export function clipList(text: string): number[] | null {
  const parts = text.replace(/\s*(?:-|–|—|\.\.|to)\s*/g, "-").split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return null;
  const out = new Set<number>();
  for (const p of parts) {
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (hi - lo > 200) return null;
      for (let n = lo; n <= hi; n++) out.add(n);
      continue;
    }
    if (!/^\d+$/.test(p)) return null;
    out.add(Number(p));
  }
  const list = [...out].filter((n) => n >= 1).sort((a, b) => a - b);
  return list.length && list.length <= 200 ? list : null;
}

/** "576x1024", "576 × 1024", "576*1024". */
export function sizeOf(text: string): { width: number; height: number } | null {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(text.trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * The command a line of words says, with its figures; null when it says none fully (the bar then lists the
 * commands whose name matches). Words, not punctuation: "render clips 3-5", "seed 1234", "pause queue".
 */
export function parseCommand(input: string): Command | null {
  const t = input.trim().replace(/\s+/g, " ");
  const low = t.toLowerCase();
  let m: RegExpExecArray | null;
  // a render on one ComfyUI of several, this once: "render missing on second gpu", "render clips 3-5 on studio"
  if ((m = /^(render .+?) on (.+)$/i.exec(t))) {
    const head = parseCommand(m[1]!);
    if (head && (head.cmd === "render-clips" || head.cmd === "render-missing")) return { ...head, machine: m[2]!.trim() };
  }
  if ((m = /^render (?:clips?|c) ?(.+)$/i.exec(t)) || (m = /^render ([\d][\d\s,;.\-–—to]*)$/i.exec(t))) {
    const clips = clipList(m[1]!);
    return clips ? { cmd: "render-clips", clips } : null;
  }
  if (/^render (?:the )?missing(?: clips)?$/.test(low)) return { cmd: "render-missing" };
  if (/^export(?: (?:the )?timeline)?$/.test(low)) return { cmd: "export" };
  if (/^export(?: (?:the )?timeline)? for (?:an? )?(?:video )?(?:editor|resolve|davinci|premiere|kdenlive|nle)$/.test(low)) return { cmd: "export-editor" };
  if ((m = new RegExp(`^seed (\\d{1,10})$`).exec(low))) {
    const value = Number(m[1]);
    return value <= 2 ** 32 - 1 ? { cmd: "seed", value } : null;
  }
  if ((m = new RegExp(`^steps? ${NUMBER}$`).exec(low))) return Number.isInteger(num(m[1]!)) && num(m[1]!) > 0 ? { cmd: "steps", value: num(m[1]!) } : null;
  if ((m = new RegExp(`^(?:cfg|guidance) ${NUMBER}$`).exec(low))) return num(m[1]!) >= 0 ? { cmd: "cfg", value: num(m[1]!) } : null;
  if ((m = /^size (.+)$/.exec(low))) {
    const s = sizeOf(m[1]!);
    return s ? { cmd: "size", ...s } : null;
  }
  if ((m = new RegExp(`^(?:length|duration|seconds) ${NUMBER} ?(?:s|sec|secs|seconds?)?$`).exec(low))) return num(m[1]!) > 0 ? { cmd: "length", seconds: num(m[1]!) } : null;
  // the panel ("load a model", "load a model on second gpu") before a model by its name ("load h3")
  if ((m = /^load(?: a)? models?(?: on (.+))?$/i.exec(t))) return m[1] ? { cmd: "load-panel", machine: m[1].trim() } : { cmd: "load-panel" };
  if ((m = /^load (.+)$/i.exec(t))) return { cmd: "load", model: m[1]!.trim() };
  if ((m = /^new draft (.+)$/i.exec(t))) return { cmd: "new-draft", recipe: m[1]!.trim() };
  if (/^pause(?: (?:the )?queue| all)?$/.test(low)) return { cmd: "pause" };
  if (/^(?:resume|unpause)(?: (?:the )?queue| all)?$/.test(low)) return { cmd: "resume" };
  // one ComfyUI of several, by its name: "pause studio pc", "use only second gpu"
  if ((m = /^use only (.+)$/i.exec(t))) return { cmd: "use-only", machine: m[1]!.trim() };
  if (/^(?:show (?:the )?)?(?:machines|comfyuis|gpus)$/.test(low)) return { cmd: "machines" };
  if ((m = /^(?:comfyui )?(?:log|console) (?:of |on )?(.+)$/i.exec(t))) return { cmd: "machine-log", machine: m[1]!.trim() };
  if ((m = /^render times (?:of |on )?(.+)$/i.exec(t))) return { cmd: "machine-times", machine: m[1]!.trim() };
  if ((m = /^models (?:on|of) (.+)$/i.exec(t))) return { cmd: "machine-models", machine: m[1]!.trim() };
  if ((m = /^pause (.+)$/i.exec(t))) return { cmd: "pause", machine: m[1]!.trim() };
  if ((m = /^(?:resume|unpause) (.+)$/i.exec(t))) return { cmd: "resume", machine: m[1]!.trim() };
  if (/^empty (?:the )?(?:bin|trash)$/.test(low)) return { cmd: "empty-bin" };
  if (/^(?:put (?:all|everything) back|put back (?:all|everything)|restore (?:the )?(?:bin|trash|all))$/.test(low)) return { cmd: "put-back-all" };
  if (/^bin (?:the )?unused(?: takes)?$/.test(low)) return { cmd: "bin-unused" };
  if ((m = /^link (?:a )?folder(?: (.+))?$/i.exec(t))) return { cmd: "link-folder", path: (m[1] ?? "").trim() };
  if ((m = /^new project (.+)$/i.exec(t))) return { cmd: "new-project", name: m[1]!.trim().slice(0, 120) };
  if (/^split(?: (?:the )?clip)?(?: at (?:the )?playhead)?$/.test(low)) return { cmd: "split" };
  if ((m = /^(?:(?:go to|select|jump to) )?clip (\d{1,4})$/.exec(low))) return Number(m[1]) >= 1 ? { cmd: "clip", number: Number(m[1]) } : null;
  if (/^undo$/.test(low)) return { cmd: "undo" };
  if (/^(?:prev|previous) take$/.test(low)) return { cmd: "previous-take" };
  if (/^next take$/.test(low)) return { cmd: "next-take" };
  if ((m = /^(?:mirror|flip) (?:the )?(?:pin(?:ned)?|frame|pinned frame)s?(?: (on|off))?$/.exec(low))) return { cmd: "mirror-pin", off: m[1] === "off" };
  if (/^(?:unmirror|unflip) (?:the )?(?:pin(?:ned)?|frame|pinned frame)s?$/.test(low)) return { cmd: "mirror-pin", off: true };
  if (/^cancel (?:all )?(?:the )?waiting(?: jobs)?$/.test(low)) return { cmd: "cancel-waiting" };
  if (/^retry (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "retry-failed" };
  if (/^dismiss (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "dismiss-failed" };
  if (/^group (?:the )?(?:queue )?by model$/.test(low)) return { cmd: "group-queue" };
  if (/^(?:unload|free)(?: (?:the )?models?)?$/.test(low) || /^free (?:the )?vram$/.test(low)) return { cmd: "unload" };
  if ((m = /^unload (.+)$/i.exec(t))) return { cmd: "unload", machine: m[1]!.trim() };
  if (/^gen(?:erate)?(?: (?:the )?(?:open )?draft)?$/.test(low)) return { cmd: "generate" };
  // with several ComfyUIs, on one of them this once: "generate on second gpu"
  if ((m = /^gen(?:erate)?(?: (?:the )?(?:open )?draft)? on (.+)$/i.exec(t))) return { cmd: "generate", machine: m[1]!.trim() };
  if ((m = /^new timeline(?: (.+))?$/i.exec(t))) return { cmd: "new-timeline", name: (m[1] ?? "").trim().slice(0, 120) };
  if ((m = /^new folder (.+)$/i.exec(t))) return { cmd: "new-folder", name: m[1]!.trim().slice(0, 120) };
  if ((m = /^new (person|place|style|preset|snippet) (.+)$/i.exec(t))) return { cmd: `new-${m[1]!.toLowerCase()}` as KitNew, name: m[2]!.trim().slice(0, 120) };
  if ((m = /^save (?:it )?as (?:a )?preset (.+)$/i.exec(t))) return { cmd: "save-preset", name: m[1]!.trim().slice(0, 120) };
  if ((m = /^(?:apply )?preset (.+)$/i.exec(t))) return { cmd: "preset", name: m[1]!.trim() };
  if (/^import(?: (?:a )?(?:comfyui )?workflow)?$/.test(low)) return { cmd: "import-workflow" };
  if (/^finish(?: (?:the )?timeline)?$/.test(low)) return { cmd: "finish" };
  if (/^fix(?: all)?$/.test(low)) return { cmd: "fix-all" };
  if (/^(?:(?:view|open|show) )?(?:the )?last render$/.test(low)) return { cmd: "view-last" };
  if (/^(?:reconnect(?: to comfyui)?|test comfyui|test (?:the )?connection)$/.test(low)) return { cmd: "reconnect" };
  return null;
}
