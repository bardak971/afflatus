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
  | { cmd: "render-clips"; clips: number[] }
  | { cmd: "render-missing" }
  | { cmd: "export" }
  | { cmd: "seed"; value: number }
  | { cmd: "steps"; value: number }
  | { cmd: "cfg"; value: number }
  | { cmd: "size"; width: number; height: number }
  | { cmd: "length"; seconds: number }
  | { cmd: "load"; model: string }
  | { cmd: "new-draft"; recipe: string }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "empty-bin" }
  | { cmd: "bin-unused" }
  | { cmd: "link-folder"; path: string }
  | { cmd: "new-project"; name: string }
  | { cmd: "split" }
  | { cmd: "previous-take" }
  | { cmd: "next-take" }
  | { cmd: "cancel-waiting" }
  | { cmd: "retry-failed" }
  | { cmd: "dismiss-failed" }
  | { cmd: "group-queue" }
  | { cmd: "unload" }
  | { cmd: "generate" }
  | { cmd: "new-timeline"; name: string }
  | { cmd: "new-folder"; name: string }
  | { cmd: "import-workflow" }
  | { cmd: "finish" }
  | { cmd: "fix-all" }
  | { cmd: "view-last" }
  | { cmd: "reconnect" }
  | { cmd: KitNew; name: string }
  | { cmd: "preset"; name: string }
  | { cmd: "save-preset"; name: string };
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
  { id: "empty-bin", name: "Empty bin…", typed: "empty bin", example: "empty bin", what: "Erases what is in the bin, asked first" },
  { id: "bin-unused", name: "Bin unused takes…", typed: "bin unused takes", example: "bin unused takes", what: "Of the open timeline, asked first" },
  { id: "split", name: "Split clip at playhead", typed: "split", example: "split", what: "The clip selected in the open timeline, as its key in the editor" },
  { id: "previous-take", name: "Previous take", typed: "previous take", example: "prev take", what: "The selected clip plays its take before, as its key in the editor" },
  { id: "next-take", name: "Next take", typed: "next take", example: "next take", what: "The selected clip plays its take after, as its key in the editor" },
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
  if ((m = /^render (?:clips?|c) ?(.+)$/i.exec(t)) || (m = /^render ([\d][\d\s,;.\-–—to]*)$/i.exec(t))) {
    const clips = clipList(m[1]!);
    return clips ? { cmd: "render-clips", clips } : null;
  }
  if (/^render (?:the )?missing(?: clips)?$/.test(low)) return { cmd: "render-missing" };
  if (/^export(?: (?:the )?timeline)?$/.test(low)) return { cmd: "export" };
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
  if ((m = /^load (.+)$/i.exec(t))) return { cmd: "load", model: m[1]!.trim() };
  if ((m = /^new draft (.+)$/i.exec(t))) return { cmd: "new-draft", recipe: m[1]!.trim() };
  if (/^pause(?: (?:the )?queue)?$/.test(low)) return { cmd: "pause" };
  if (/^(?:resume|unpause)(?: (?:the )?queue)?$/.test(low)) return { cmd: "resume" };
  if (/^empty (?:the )?(?:bin|trash)$/.test(low)) return { cmd: "empty-bin" };
  if (/^bin (?:the )?unused(?: takes)?$/.test(low)) return { cmd: "bin-unused" };
  if ((m = /^link (?:a )?folder(?: (.+))?$/i.exec(t))) return { cmd: "link-folder", path: (m[1] ?? "").trim() };
  if ((m = /^new project (.+)$/i.exec(t))) return { cmd: "new-project", name: m[1]!.trim().slice(0, 120) };
  if (/^split(?: (?:the )?clip)?(?: at (?:the )?playhead)?$/.test(low)) return { cmd: "split" };
  if (/^(?:prev|previous) take$/.test(low)) return { cmd: "previous-take" };
  if (/^next take$/.test(low)) return { cmd: "next-take" };
  if (/^cancel (?:all )?(?:the )?waiting(?: jobs)?$/.test(low)) return { cmd: "cancel-waiting" };
  if (/^retry (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "retry-failed" };
  if (/^dismiss (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "dismiss-failed" };
  if (/^group (?:the )?(?:queue )?by model$/.test(low)) return { cmd: "group-queue" };
  if (/^(?:unload|free)(?: (?:the )?models?)?$/.test(low) || /^free (?:the )?vram$/.test(low)) return { cmd: "unload" };
  if (/^gen(?:erate)?(?: (?:the )?(?:open )?draft)?$/.test(low)) return { cmd: "generate" };
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
