/**
 * What is typed in the bar, read by fixed rules (never a language model): the mode its first character
 * picks, and in the command mode, which command and its figures. Pure, run at every keystroke.
 */

import { TRANSITION_KINDS, TRANSITIONS, type TransitionKind } from "@afflatus/core";

export type Mode = "all" | "command" | "setting" | "calc" | "queue" | "keys" | "cast";

/** The first character of what is typed, and the mode it opens. */
export const MODE_KEYS: Record<string, Mode> = { ">": "command", "/": "setting", "=": "calc", "!": "queue", "?": "keys", "@": "cast" };

/**
 * The characters that once were modes and are now the render search's keys, typed first in an empty bar: `"` the prompts
 * (`prompt:`), `#` the projects and folders (`in:`). Their values list what the modes listed, and they mix with other keys.
 */
export const FOLDS: Record<string, string> = { '"': "prompt:", "#": "in:" };

/** The mode and what is typed after its character (trimmed at the start). Cast only when it is on. */
export function modeOf(typed: string, optional: { cast: boolean } = { cast: true }): { mode: Mode; text: string } {
  const first = typed[0];
  const mode = first ? MODE_KEYS[first] : undefined;
  if (!mode || (mode === "cast" && !optional.cast)) return { mode: "all", text: typed.trim() };
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
  | { cmd: "open-comfy"; machine?: string }
  | { cmd: "start-pod"; machine: string }
  | { cmd: "stop-pod"; machine: string }
  | { cmd: "deploy-gpu" }
  | { cmd: "deploy-again" }
  | { cmd: "hunt-gpu" }
  | { cmd: "cancel-hunt" }
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
  | { cmd: "redo" }
  | { cmd: "delete-clip" }
  /** The open timeline, else the open draft, under a new name. */
  | { cmd: "rename"; name: string }
  | { cmd: "clip"; number: number }
  /** `kind` null: the cut made plain again; undefined: the words name none, or several (the bar lists those they fit). */
  | { cmd: "transition"; words: string; kind?: TransitionKind | null }
  | { cmd: "slow-motion"; factor: 2 | 4 }
  | { cmd: "motion-windows" }
  | { cmd: "stop-all-pods" }
  | { cmd: "spending" }
  | { cmd: "find-models"; words: string }
  | { cmd: "check-updates" }
  | { cmd: "model-updates" }
  | { cmd: "picked" }
  | { cmd: "get-missing" }
  | { cmd: "update" }
  | { cmd: "go-back" }
  | { cmd: "test-notify"; channel?: "telegram" | "discord" }
  | { cmd: "sign-out" }
  | { cmd: "sign-out-everywhere" };
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
  { id: "render-missing", name: "Render all", typed: "render all", example: "render all", what: "The clips of the open timeline that have no take, as its Render all" },
  { id: "export", name: "Export timeline…", typed: "export", example: "export", what: "The open timeline as one video" },
  { id: "export-editor", name: "Export for a video editor…", typed: "export for editor", example: "export for resolve", what: "The open timeline as its clips and a project file for DaVinci Resolve, Premiere Pro or Kdenlive" },
  { id: "finish", name: "Finish timeline…", typed: "finish", example: "finish", what: "The Finish dialog on the open timeline: every take upscaled to its final quality" },
  { id: "fix-all", name: "Fix all", typed: "fix all", example: "fix all", what: "What the open timeline's Needs a look lists, mended as its Fix all does" },
  { id: "generate", name: "Render the draft", typed: "render draft", example: "render draft", what: "The open draft, as its Render button" },
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
  { id: "machines", name: "Show the machines", typed: "machines", example: "comfyuis", what: "With several machines: the status bar's panel of every machine, its figures, its pause and its menu" },
  { id: "start-pod", name: "Start pod…", typed: "start pod ", example: "start pod comfy-5090", what: "A rented pod (RunPod), started: billed from then, at its rate; it stops by itself when idle", needs: true },
  { id: "stop-pod", name: "Stop pod…", typed: "stop pod ", example: "stop pod comfy-5090", what: "A rented pod, stopped: the GPU stops billing, its disk goes on", needs: true },
  { id: "stop-all-pods", name: "Stop all pods…", typed: "stop all pods", example: "stop all pods", what: "Every rented pod that runs or starts, stopped at once (asked first): their GPUs stop billing, their disks go on" },
  { id: "spending", name: "Spending", typed: "spending", example: "costs", what: "Queue › Costs: where the money went (the rented GPUs, this PC's electricity); with RunPod, today and this month against your caps and the balance's runway" },
  { id: "deploy-gpu", name: "Deploy a GPU…", typed: "deploy gpu", example: "deploy gpu", what: "A GPU rented on RunPod, picked from what is free now: billed from your Deploy until it ends, by itself once idle" },
  { id: "deploy-again", name: "Deploy again", typed: "deploy again", example: "deploy again", what: "The last deploy's GPU and choices, on RunPod: its rate asked first" },
  { id: "hunt-gpu", name: "Hunt a GPU…", typed: "hunt gpu", example: "hunt gpu", what: "Deploy a GPU on its hunt: RunPod asked every 30 s, the best GPU that comes free within your price deployed for the renders waiting" },
  { id: "cancel-hunt", name: "Cancel the hunt", typed: "cancel hunt", example: "cancel hunt", what: "The GPU hunt under way: nothing deployed, the home machines it paused go on" },
  { id: "open-comfy", name: "Open ComfyUI", typed: "open comfyui", example: "open comfyui on second gpu", what: "ComfyUI's own page in a new tab, the first ComfyUI or the one named; locked, the tab lands logged in" },
  { id: "machine-log", name: "ComfyUI log of…", typed: "log ", example: "log second gpu", what: "With several machines: that machine's console, in the Queue", needs: true },
  { id: "machine-times", name: "Render times of…", typed: "render times ", example: "render times second gpu", what: "With several machines: what that machine rendered and how long it took", needs: true },
  { id: "machine-models", name: "Models on…", typed: "models on ", example: "models on second gpu", what: "With several machines: Settings › Models, that machine's tab: what it has, its switches, downloads to it", needs: true },
  { id: "use-only", name: "Use only…", typed: "use only ", example: "use only second gpu", what: "With several machines: every other one paused, everything waiting goes to this one", needs: true },
  { id: "empty-bin", name: "Empty the bin…", typed: "empty the bin", example: "empty the bin", what: "Erases what is in the bin, asked first" },
  { id: "put-back-all", name: "Put all back", typed: "put all back", example: "put all back", what: "Everything in the bin back where it was, as the bin's Put all back" },
  { id: "bin-unused", name: "Bin unused takes…", typed: "bin unused takes", example: "bin unused takes", what: "Of the open timeline, asked first" },
  { id: "clip", name: "Go to clip…", typed: "clip ", example: "clip 3", what: "In the open timeline: selected, the playhead on its start", needs: true },
  { id: "undo", name: "Undo", typed: "undo", example: "undo", what: "The open editor's last change, else the move or bin a banner offers to undo" },
  { id: "redo", name: "Redo", typed: "redo", example: "redo", what: "What the open editor's Undo took back, else the move or bin a banner offers to redo" },
  { id: "delete-clip", name: "Delete clip", typed: "delete clip", example: "delete clip", what: "The selected clip off the open timeline, as Del; Undo brings it back" },
  { id: "rename", name: "Rename…", typed: "rename ", example: "rename Harbor cut", what: "The open timeline, else the open draft", needs: true },
  { id: "transition", name: "Transition…", typed: "transition ", example: "transition dissolve", what: "On the cut into the selected clip, as its join's choice in the column: dissolve, dip to black or white, flash, wipe, slide, circle, zoom; transition off makes it a plain cut", needs: true },
  { id: "slow-motion", name: "Slow motion", typed: "slow motion", example: "slow motion 4x", what: "The selected clip at half speed (or a quarter: 4x), as a new take, as its menu's Slow motion" },
  { id: "motion-windows", name: "Motion transfer in windows", typed: "motion transfer in windows", example: "motion transfer in windows", what: "The selected clip, a video brought in, put on the source lane and made into Motion transfer clips window by window, as its menu" },
  { id: "split", name: "Split clip at playhead", typed: "split", example: "split", what: "The clip selected in the open timeline, as its key in the editor" },
  { id: "previous-take", name: "Previous take", typed: "previous take", example: "prev take", what: "The selected clip plays its take before, as its key in the editor" },
  { id: "next-take", name: "Next take", typed: "next take", example: "next take", what: "The selected clip plays its take after, as its key in the editor" },
  { id: "mirror-pin", name: "Mirror pinned frame", typed: "mirror pin", example: "mirror pin", what: "A pinned frame of the selected clip flipped at render time (or back: mirror pin off), as its right-click menu" },
  { id: "cancel-waiting", name: "Remove all waiting…", typed: "remove waiting", example: "remove waiting", what: "Every waiting job out of the queue, asked first; the running one goes on" },
  { id: "retry-failed", name: "Retry all failed", typed: "retry failed", example: "retry failed", what: "The failed jobs the queue lists, queued again oldest first" },
  { id: "dismiss-failed", name: "Dismiss all failed…", typed: "dismiss failed", example: "dismiss failed", what: "The failed jobs the queue lists, off the history, asked first" },
  { id: "group-queue", name: "Group by model", typed: "group by model", example: "group by model", what: "Same model together, the loaded one first" },
  { id: "find-models", name: "Find models…", typed: "find models ", example: "find models wan lightning", what: "Civitai, Hugging Face and your own, in one search, to download onto this PC (with Search Hugging Face and Civitai on)" },
  { id: "picked", name: "Picked models", typed: "picked", example: "picked", what: "The model files picked in Find models or the bar: onto this PC (asked, with their total), or open there" },
  { id: "get-missing", name: "Get missing files", typed: "get missing files", example: "get missing files", what: "The open form's missing model files, looked up and downloaded onto this PC (asked, with their total)" },
  { id: "model-updates", name: "Model updates", typed: "model updates", example: "model updates", what: "Newer versions of your models on Civitai: asked now, then the list in Settings › Models" },
  { id: "check-updates", name: "Check for updates", typed: "check for updates", example: "check for updates", what: "Is a newer Afflatus out: GitHub asked now, as About's Check now" },
  { id: "update", name: "Update Afflatus", typed: "update", example: "update", what: "To the latest release, as About's Update: Afflatus restarts once the queue is empty; your library stays as it is" },
  { id: "go-back", name: "Go back to the previous version…", typed: "go back", example: "go back", what: "The version before the last update, its library as it was then (asked first), as About's Go back" },
  { id: "sign-out", name: "Sign out", typed: "sign out", example: "sign out", what: "This browser signed out, as the Access card's Sign out on this device: the sign-in page comes next (with a password set)" },
  { id: "sign-out-everywhere", name: "Sign out everywhere…", typed: "sign out everywhere", example: "sign out everywhere", what: "Every device signed out, this one too (asked first), as the Access card's: each needs the password again" },
  { id: "test-notify", name: "Send a test notification", typed: "test notification", example: "test notification telegram", what: "A test message to Telegram or Discord, as their card's Send a test" },
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
  // a render on one machine of several, this once: "render all on second gpu", "render clips 3-5 on studio", "render draft on studio"
  if ((m = /^(render .+?) on (.+)$/i.exec(t))) {
    const head = parseCommand(m[1]!);
    if (head && (head.cmd === "render-clips" || head.cmd === "render-missing" || head.cmd === "generate")) return { ...head, machine: m[2]!.trim() };
  }
  if ((m = /^render (?:clips?|c) ?(.+)$/i.exec(t)) || (m = /^render ([\d][\d\s,;.\-–—to]*)$/i.exec(t))) {
    const clips = clipList(m[1]!);
    return clips ? { cmd: "render-clips", clips } : null;
  }
  // "render missing" was its name before the editor's Render all lent it its own; both still say it
  if (/^render (?:the )?(?:missing|all)(?: clips)?$/.test(low)) return { cmd: "render-missing" };
  // the draft's Render button, by name
  if (/^render (?:the )?(?:open )?draft$/.test(low)) return { cmd: "generate" };
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
  // every rented pod at once, before one by its name
  if (/^stop (?:all|every)(?: the| rented| running)* (?:pods?|gpus?|machines)$|^stop (?:the )?(?:rented |running )?(?:pods|gpus)$/.test(low)) return { cmd: "stop-all-pods" };
  if ((m = /^start pod (.+)$/i.exec(t))) return { cmd: "start-pod", machine: m[1]!.trim() };
  if ((m = /^stop pod (.+)$/i.exec(t))) return { cmd: "stop-pod", machine: m[1]!.trim() };
  if ((m = /^open comfy(?:ui)?(?: (?:on|of) (.+))?$/i.exec(t))) return m[1] ? { cmd: "open-comfy", machine: m[1].trim() } : { cmd: "open-comfy" };
  // signing out before a machine's log: "log out" is no machine called "out"
  if (/^(?:sign|log) ?out (?:of )?(?:everywhere|all(?: devices)?|every device|all browsers)$/.test(low)) return { cmd: "sign-out-everywhere" };
  if (/^(?:sign|log) ?out(?: (?:of )?(?:this (?:device|browser|computer)|here))?$/.test(low)) return { cmd: "sign-out" };
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
  if (/^redo$/.test(low)) return { cmd: "redo" };
  if (/^(?:delete|remove) (?:the )?(?:selected )?clip$/.test(low)) return { cmd: "delete-clip" };
  if ((m = /^rename (.+)$/i.exec(t))) return { cmd: "rename", name: m[1]!.trim().slice(0, 120) };
  if ((m = /^(?:transition|trans)(?: (.*))?$/.exec(low))) return transitionOf((m[1] ?? "").trim());
  if ((m = /^slow(?:[ -]?mo(?:tion)?)?(?: (?:x|×)?\s?([24])\s?(?:x|×)?)?$/.exec(low))) return { cmd: "slow-motion", factor: m[1] === "4" ? 4 : 2 };
  if (/^(?:motion transfer(?: in windows)?|(?:to|make) (?:the )?source(?: lane)?|source lane)$/.test(low)) return { cmd: "motion-windows" };
  if (/^(?:spending|spend|spent|money|costs?|budget|(?:runpod )?balance|(?:spending )?caps?|electricity)(?: today)?$/.test(low)) return { cmd: "spending" };
  if ((m = /^(?:find|browse|search(?: for)?) (?:a )?models?(?: (.+))?$/i.exec(t))) return { cmd: "find-models", words: (m[1] ?? "").trim() };
  if (/^picked(?: (?:models|files))?$/.test(low)) return { cmd: "picked" };
  if (/^(?:get|download|fetch) (?:the )?missing(?: model)?(?: files| models)?$/.test(low)) return { cmd: "get-missing" };
  if (/^(?:(?:models?|loras?|checkpoints?) updates?|newer (?:models|loras|versions)|check (?:my )?models?(?: for updates?)?)$/.test(low)) return { cmd: "model-updates" };
  if (/^(?:check (?:for )?(?:updates?|(?:a )?new version)|updates)$/.test(low)) return { cmd: "check-updates" };
  if (/^(?:update|upgrade)(?: afflatus)?(?: now)?$/.test(low)) return { cmd: "update" };
  if (/^(?:go back|roll ?back|downgrade)(?: to (?:the )?(?:previous|last|old)(?: version)?| to v?\d[\d.]*)?$/.test(low)) return { cmd: "go-back" };
  if ((m = /^(?:send (?:a )?)?test (?:notification|message|telegram|discord)(?: (?:on|to|via) (telegram|discord))?$/.exec(low))) {
    const said = /telegram|discord/.exec(low)?.[0] as "telegram" | "discord" | undefined;
    return said ? { cmd: "test-notify", channel: said } : { cmd: "test-notify" };
  }
  if (/^(?:prev|previous) take$/.test(low)) return { cmd: "previous-take" };
  if (/^next take$/.test(low)) return { cmd: "next-take" };
  if ((m = /^(?:mirror|flip) (?:the )?(?:pin(?:ned)?|frame|pinned frame)s?(?: (on|off))?$/.exec(low))) return { cmd: "mirror-pin", off: m[1] === "off" };
  if (/^(?:unmirror|unflip) (?:the )?(?:pin(?:ned)?|frame|pinned frame)s?$/.test(low)) return { cmd: "mirror-pin", off: true };
  if (/^(?:cancel|remove) (?:all )?(?:the )?waiting(?: jobs)?$/.test(low)) return { cmd: "cancel-waiting" };
  if (/^retry (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "retry-failed" };
  if (/^dismiss (?:all )?(?:the )?failed(?: jobs)?$/.test(low)) return { cmd: "dismiss-failed" };
  if (/^group (?:the )?(?:queue )?by model$/.test(low)) return { cmd: "group-queue" };
  if (/^(?:unload|free)(?: (?:the )?models?)?$/.test(low) || /^free (?:the )?vram$/.test(low)) return { cmd: "unload" };
  if ((m = /^unload (.+)$/i.exec(t))) return { cmd: "unload", machine: m[1]!.trim() };
  // "generate" was the draft's button before every send to the GPU said Render: typed by habit, it still works
  if (/^gen(?:erate)?(?: (?:the )?(?:open )?draft)?$/.test(low)) return { cmd: "generate" };
  // with several ComfyUIs, on one of them this once: "generate on second gpu"
  if ((m = /^gen(?:erate)?(?: (?:the )?(?:open )?draft)? on (.+)$/i.exec(t))) return { cmd: "generate", machine: m[1]!.trim() };
  if ((m = /^new timeline(?: (.+))?$/i.exec(t))) return { cmd: "new-timeline", name: (m[1] ?? "").trim().slice(0, 120) };
  if ((m = /^new folder (.+)$/i.exec(t))) return { cmd: "new-folder", name: m[1]!.trim().slice(0, 120) };
  if ((m = /^new (person|place|style|preset|snippet) (.+)$/i.exec(t))) return { cmd: `new-${m[1]!.toLowerCase()}` as KitNew, name: m[2]!.trim().slice(0, 120) };
  if ((m = /^save (?:it )?as (?:a )?preset (.+)$/i.exec(t))) return { cmd: "save-preset", name: m[1]!.trim().slice(0, 120) };
  if ((m = /^(?:apply )?preset (.+)$/i.exec(t))) return { cmd: "preset", name: m[1]!.trim() };
  if (/^import(?: (?:a )?(?:comfyui )?workflow)?$/.test(low)) return { cmd: "import-workflow" };
  if (/^(?:deploy|rent) (?:it |the (?:last|same) (?:one|gpu) )?again$/.test(low)) return { cmd: "deploy-again" };
  if (/^(?:cancel|stop|end) (?:the )?(?:gpu )?hunt$/.test(low)) return { cmd: "cancel-hunt" };
  if (/^hunt(?: (?:for )?an?)?(?: (?:gpu|pod))?$/.test(low)) return { cmd: "hunt-gpu" };
  if (/^(?:deploy|rent)(?: an?)?(?: (?:gpu|pod|runpod))?$/.test(low)) return { cmd: "deploy-gpu" };
  if (/^finish(?: (?:the )?timeline)?$/.test(low)) return { cmd: "finish" };
  if (/^fix(?: all)?$/.test(low)) return { cmd: "fix-all" };
  if (/^(?:(?:view|open|show) )?(?:the )?last render$/.test(low)) return { cmd: "view-last" };
  if (/^(?:reconnect(?: to comfyui)?|test comfyui|test (?:the )?connection)$/.test(low)) return { cmd: "reconnect" };
  return null;
}

/**
 * The words a transition is called by, beside its label ("Cross dissolve"): what someone would type for it. Off, none,
 * cut and plain take the transition off.
 */
const TRANSITION_WORDS: Record<TransitionKind, string> = {
  dissolve: "dissolve cross fade mix", "dip-black": "dip black fade to black", "dip-white": "dip white fade to white whiteout",
  flash: "flash", "wipe-left": "wipe left", "wipe-right": "wipe right", "slide-left": "slide left push", "slide-right": "slide right push",
  circle: "circle open iris", zoom: "zoom in",
};
const OFF = /^(?:off|none|cut|plain(?: cut)?|remove|no(?:ne)?)$/;

/** The transitions some words name, best first: each word in its label or its other words. */
export function transitionsNamed(words: string): TransitionKind[] {
  const w = words.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!w.length) return [...TRANSITION_KINDS];
  return TRANSITION_KINDS.filter((k) => {
    const hay = `${TRANSITIONS[k].label} ${TRANSITION_WORDS[k]}`.toLowerCase();
    return w.every((x) => hay.split(/\s+/).some((h) => h.startsWith(x)));
  });
}

/** `transition …`: the kind its words name when they name one alone, null for off, else the words left to list from. */
function transitionOf(words: string): Command {
  if (OFF.test(words)) return { cmd: "transition", words, kind: null };
  const named = transitionsNamed(words);
  return words && named.length === 1 ? { cmd: "transition", words, kind: named[0]! } : { cmd: "transition", words };
}
