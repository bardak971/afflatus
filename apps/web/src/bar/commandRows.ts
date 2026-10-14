import type { Entity, RecipeInfo, RentedSpending, RentedState, UpdatesView } from "../api";
import { TRANSITIONS, type TransitionKind } from "@afflatus/core";
import { rowKeys, type RowId } from "../keys/table";
import type { Item } from "./items";
import { prepare } from "./match";
import { COMMANDS, KIT_OF, parseCommand, type Command, type CommandId, type KitNew } from "./parse";
import type { TimelineAim } from "./actions/ctx";
import { est, plural, usd, when } from "../format";
import { unloadBlock } from "../queueRules";
import { rateSaid, rentedSaid } from "../machines";

const upper = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null);

/** A command read from what is typed, as a row of the bar: its words, what it touches and how many. */

/** What the queue says to the command rows: counts, never its progress (which changes at every sampler step). */
interface QueueNow {
  paused: boolean;
  online: boolean;
  rendering: boolean;
  running: boolean;
  waiting: number;
  failed: number;
  /** The model loads that grouping the queue by model would save. */
  saves: number;
  /** With several ComfyUIs, each one by the name it is shown under: the bar offers Pause, Resume, Use only and Unload for each. */
  machines: Array<{ id: string; label: string; paused: boolean; online: boolean | null; running: boolean; rented: RentedState | null }>;
  /** A GPU hunt is under way: Cancel the hunt is offered. */
  hunting?: boolean;
}

/** What the command rows say of the moment: the timeline aimed at, the queue, the selected clip, what Undo would undo, the bin. */
export interface CommandCtx {
  aim: TimelineAim | null;
  queue: QueueNow | null;
  selectedClip: {
    number: number; timelineName: string; pins?: Array<{ where: string; on: boolean }>;
    /** The join before it and its transition (`> transition`); whether it can be slowed, or put on the source lane. */
    cutIn?: "none" | "extends" | "cut"; transition?: TransitionKind | null; slow?: unknown; toSource?: unknown;
  } | null;
  bannerUndo: string | null;
  editorUndo: string | null;
  binEmpty: boolean;
  binSaid: string;
  /** What the rented GPUs cost (`> spending`); null without a RunPod key, or before it is read. */
  spending?: RentedSpending | null;
  /** Afflatus's own updates (Settings › About): Check, Update and Go back. */
  updates?: UpdatesView | null;
  /** Telegram and Discord set up, for `> test notification`. */
  channels?: { telegram: boolean; discord: boolean };
  /** Find models searches online only with Search Hugging Face and Civitai on. */
  lookups?: boolean;
}

/** A rented pod that bills now: running, or on its way up. */
export const billing = (r: RentedState | null | undefined) => Boolean(r && (r.status === "RUNNING" || r.status === "STARTING" || r.status === "PROVISIONING"));

/** What the cut into the selected clip says to `> transition`, or why it has none. */
function cutSaid(c: CommandCtx["selectedClip"]): string {
  if (!c) return "No clip selected in an open timeline";
  if (c.cutIn === "none") return `Clip ${c.number} is the first: no cut before it`;
  if (c.cutIn === "extends") return `Clip ${c.number} extends clip ${c.number - 1}: a transition goes on a cut`;
  return `${c.timelineName} · the cut from clip ${c.number - 1}${c.transition ? `, now ${TRANSITIONS[c.transition].label.toLowerCase()}` : ""}`;
}

/** The figures of `> spending`: this month against its cap, the balance and how long it lasts. */
function spendingSaid(s: RentedSpending): string {
  return [
    `this month ${usd(s.month)}${s.caps.month ? ` of ${usd(s.caps.month)}` : ""}`,
    s.balance !== null && `balance ${usd(s.balance)}${s.lowBalance ? " (low)" : ""}`,
    s.runwayMs !== null && s.spendPerHr !== null && `lasts ${est(s.runwayMs)} at ${usd(s.spendPerHr)}/h`,
  ].filter(Boolean).join(" · ");
}

/**
 * The key table's row that does what a command does, when pressing it does that in the place the command acts on:
 * split and the takes in the timeline editor (a clip selected). Read from the table, never a second copy of a chord;
 * `half` is one chord of a pair (Alt+[ for the previous take, Alt+] for the next). Generate and rendering a clip have
 * none: their key is Ctrl+Enter, which inside the bar runs a row's second action, so the row would say a key that does
 * something else there.
 */
export const COMMAND_KEYS: Partial<Record<CommandId, { row: RowId; half?: 0 | 1 }>> = {
  split: { row: "split" },
  "previous-take": { row: "take", half: 0 },
  "next-take": { row: "take", half: 1 },
};

/** A command's key, said on its row. */
export function commandKeys(c: Command | { cmd: CommandId }): string | undefined {
  const at = COMMAND_KEYS[c.cmd];
  return at ? rowKeys(at.row, at.half) : undefined;
}

/** The commands offered only where they apply: a clip selected in the open editor, jobs waiting, failures, loads to save. */
const LIVE: CommandId[] = ["split", "previous-take", "next-take", "mirror-pin", "slow-motion", "motion-windows", "cancel-waiting", "retry-failed", "dismiss-failed", "group-queue", "unload", "cancel-hunt", "stop-all-pods", "spending", "update", "go-back", "test-notify"];
/** What is done to the whole queue, listed after its jobs in the `!` mode. */
export const QUEUE_BULK: CommandId[] = ["cancel-waiting", "retry-failed", "dismiss-failed", "group-queue"];

/** "Render clips 3–5": a run of three or more clips said as a range. */
const said = (c: Command): string => c.cmd === "render-clips" ? `${c.clips.length > 1 ? "Render clips" : "Render clip"} ${c.clips.length > 2 && c.clips.at(-1)! - c.clips[0]! === c.clips.length - 1 ? `${c.clips[0]}–${c.clips.at(-1)}` : c.clips.join(", ")}` : "";

/** A command read from what is typed, as a row: its words, what it touches and how many. */
export function commandRow(x: CommandCtx, c: Command, recipe?: RecipeInfo, preset?: Extract<Entity, { kind: "preset" }>): Item {
  const { aim, queue: queueNow, selectedClip, bannerUndo, editorUndo, binEmpty, binSaid } = x;
  const t = aim?.name ?? "the open timeline";
  const named = "name" in c ? c.name : "";
  const kitNew = (cmd: KitNew): [string, string] => [`New ${KIT_OF[cmd]} “${named}”`, "In the Prompt kit, opened there"];
  const mirrorWords = c.cmd === "mirror-pin" && c.off ? "Mirror off" : "Mirror pinned frame";
  const words: Record<Command["cmd"], [string, string]> = {
    "render-clips": [`${said(c)} of ${t}${"machine" in c && c.machine ? ` on ${c.machine}` : ""}`, c.cmd === "render-clips" ? `${plural(c.clips.length, "clip")} · they go to the end of the queue · Ctrl+Enter: to the top` : ""],
    "render-missing": [`Render missing clips of ${t}${"machine" in c && c.machine ? ` on ${c.machine}` : ""}`, "Clips with no take yet, or whose join went stale · Ctrl+Enter: at the top of the queue"],
    export: [`Export ${t}`, "The export dialog opens on it"],
    "export-editor": [`Export ${t} for a video editor`, "The export dialog opens on For an editor: its clips and a project file for Resolve, Premiere or Kdenlive"],
    finish: [`Finish ${t}…`, "The Finish dialog: every take upscaled to its final quality"],
    "fix-all": [`Fix all in ${t}`, "What Needs attention lists, mended as its Fix all"],
    generate: c.cmd === "generate" && c.machine ? [`Generate on ${c.machine}`, `${machineSaid(queueNow, c.machine)} · the open draft, on that machine this once`] : ["Generate", "The open draft, as its Generate button"],
    preset: [`Apply ${preset?.name ?? named}`, preset ? `Preset${preset.source === "shipped" ? " · built in" : ""} · on the open draft` : "No preset by that name"],
    "save-preset": [`Save as preset “${named}”`, "The open draft's model, form and cast"],
    unload: c.cmd === "unload" && c.machine ? [`Unload ${c.machine}`, `${machineSaid(queueNow, c.machine)} · its models out of memory`] : ["Unload models", upper(unloadBlock(queueNow)) ?? "ComfyUI's models out of memory · the next render loads them again"],
    "new-timeline": [named ? `New timeline “${named}”` : "New timeline", "In the project you work in · opens in the editor"],
    "new-folder": [`New folder “${named}”`, "At the top of the project you work in"],
    "new-person": kitNew("new-person"),
    "new-place": kitNew("new-place"),
    "new-style": kitNew("new-style"),
    "new-preset": kitNew("new-preset"),
    "new-snippet": kitNew("new-snippet"),
    "deploy-gpu": ["Deploy a GPU…", "RunPod · what is free now, by price · billed from your Deploy"],
    "deploy-again": ["Deploy again", "The last deploy's GPU and choices · its rate asked first"],
    "hunt-gpu": ["Hunt a GPU…", "RunPod asked every 30 s · the best GPU that comes free within your price · billed once deployed"],
    "cancel-hunt": ["Cancel the hunt", "Nothing deployed · the home machines it paused go on"],
    "import-workflow": ["Import workflow…", "The Workflows screen's file picker: .json, PNG or MP4"],
    "view-last": ["View last render", "What the last finished job made, in the viewer"],
    reconnect: ["Reconnect to ComfyUI", queueNow && !queueNow.online ? "ComfyUI is offline · asked again now" : "ComfyUI asked again now: its address, its files, its nodes"],
    seed: [`Seed ${c.cmd === "seed" ? c.value : ""}`, "In the open draft's form"],
    steps: [`Steps ${c.cmd === "steps" ? c.value : ""}`, "In the open draft's form"],
    cfg: [`CFG ${c.cmd === "cfg" ? c.value : ""}`, "In the open draft's form"],
    size: [`Size ${c.cmd === "size" ? `${c.width}×${c.height}` : ""}`, "In the open draft's form"],
    length: [`Length ${c.cmd === "length" ? `${c.seconds} s` : ""}`, "In the open draft's form"],
    machines: ["Show the ComfyUIs", queueNow?.machines.length ? `${queueNow.machines.length} ComfyUIs · their figures, pause and menu` : "With several ComfyUIs: each one's figures and actions"],
    "start-pod": [`Start ${c.cmd === "start-pod" ? podOf(queueNow, c.machine)?.label ?? c.machine : ""}`, c.cmd === "start-pod" ? startSaid(podOf(queueNow, c.machine)?.rented) : ""],
    "stop-pod": [`Stop ${c.cmd === "stop-pod" ? podOf(queueNow, c.machine)?.label ?? c.machine : ""}`, `${c.cmd === "stop-pod" ? machineSaid(queueNow, c.machine) : ""} · the GPU stops billing, its disk goes on`],
    "open-comfy": [c.cmd === "open-comfy" && c.machine ? `Open ComfyUI on ${c.machine}` : "Open ComfyUI", c.cmd === "open-comfy" && c.machine ? `${machineSaid(queueNow, c.machine)} · its own page, in a new tab` : "ComfyUI's own page, in a new tab"],
    "machine-log": [`ComfyUI log of ${c.cmd === "machine-log" ? c.machine : ""}`, `${c.cmd === "machine-log" ? machineSaid(queueNow, c.machine) : ""} · its console, in the Queue`],
    "machine-times": [`Render times of ${c.cmd === "machine-times" ? c.machine : ""}`, `${c.cmd === "machine-times" ? machineSaid(queueNow, c.machine) : ""} · what it rendered and how long it took`],
    "machine-models": [`Models on ${c.cmd === "machine-models" ? c.machine : ""}`, `${c.cmd === "machine-models" ? machineSaid(queueNow, c.machine) : ""} · Settings › Models, its tab`],
    "load-panel": [c.cmd === "load-panel" && c.machine ? `Load a model on ${c.machine}…` : "Load a model…", c.cmd === "load-panel" && c.machine ? `${machineSaid(queueNow, c.machine)} · this form's model, a draft's, or any by name` : "This form's model, a recent draft's, or any by name"],
    load: [`Load ${recipe?.title ?? (c.cmd === "load" ? c.model : "")}`, recipe ? `${recipe.family.toUpperCase()} · its models into ComfyUI, ahead of a render` : "No model by that name"],
    "new-draft": [`New draft on ${recipe?.title ?? (c.cmd === "new-draft" ? c.recipe : "")}`, recipe ? `${recipe.family.toUpperCase()} · opens in the Studio` : "No model by that name"],
    pause: c.cmd === "pause" && c.machine ? [`Pause ${c.machine}`, `${machineSaid(queueNow, c.machine)} · it finishes what it runs, then takes nothing new`] : [queueNow?.machines.length ? "Pause all ComfyUIs" : "Pause queue", queueNow ? `${queueNow.running ? "running" : "nothing running"}, ${queueNow.waiting} waiting · what runs finishes` : "What runs finishes; nothing new starts"],
    resume: c.cmd === "resume" && c.machine ? [`Resume ${c.machine}`, `${machineSaid(queueNow, c.machine)} · it takes work again`] : [queueNow?.machines.length ? "Resume all ComfyUIs" : "Resume queue", `${queueNow?.waiting ?? 0} waiting`],
    "use-only": [`Use only ${c.cmd === "use-only" ? c.machine : ""}`, `${c.cmd === "use-only" ? machineSaid(queueNow, c.machine) : ""} · every other ComfyUI paused: everything waiting goes to this one`],
    "empty-bin": ["Empty the bin…", binEmpty ? "The bin is empty" : `${binSaid} · asked first · cannot be undone`],
    "put-back-all": ["Put all back", binEmpty ? "The bin is empty" : `${binSaid} · each back where it was`],
    "bin-unused": [`Bin unused takes of ${t}…`, aim?.entry ? (aim.entry.unusedTakes ? `${plural(aim.entry.unusedTakes, "take")} · asked first` : "It has none") : "Asked first"],
    "link-folder": [c.cmd === "link-folder" && c.path ? `Link ${c.path}` : "Link a folder of your disk", "Used in place, nothing copied"],
    "new-project": [`New project “${c.cmd === "new-project" ? c.name : ""}”`, "Made, and worked in"],
    // the key that does the same in the editor is drawn on the row's right (from the key table), not said here
    split: [selectedClip ? `Split clip ${selectedClip.number} at playhead` : "Split clip at playhead", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
    "previous-take": [selectedClip ? `Clip ${selectedClip.number}: previous take` : "Previous take", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
    "next-take": [selectedClip ? `Clip ${selectedClip.number}: next take` : "Next take", selectedClip ? selectedClip.timelineName : "No clip selected in an open timeline"],
    "mirror-pin": [
      selectedClip ? `Clip ${selectedClip.number}: ${mirrorWords.toLowerCase()}` : mirrorWords,
      !selectedClip ? "No clip selected in an open timeline" : selectedClip.pins?.length ? `${selectedClip.timelineName} · flipped at render time, the library picture unchanged` : "Nothing pinned on it",
    ],
    "cancel-waiting": ["Cancel all waiting…", queueNow?.waiting ? `${queueNow.waiting} waiting · asked first · the running one goes on` : "Nothing waits"],
    "retry-failed": ["Retry all failed", queueNow?.failed ? `${plural(queueNow.failed, "failed job")} · the same jobs, oldest first` : "None failed"],
    "dismiss-failed": ["Dismiss all failed…", queueNow?.failed ? `${plural(queueNow.failed, "failed job")} · off the history, asked first` : "None failed"],
    "group-queue": ["Group by model", queueNow?.saves ? `saves ${plural(queueNow.saves, "load")} · same model together` : "Grouping saves no load"],
    // the editor's history while one is open (as its Ctrl+Z), else the newest banner's Undo (a move, a bin)
    undo: aim?.open ? [editorUndo ? `Undo: ${editorUndo}` : "Undo", editorUndo ? `In ${t}, as its Ctrl+Z` : `Nothing to undo in ${t}`] : [bannerUndo ? `Undo: ${bannerUndo}` : "Undo", bannerUndo ? "What the banner says was done, put back" : "Nothing to undo"],
    clip: [`Go to clip ${c.cmd === "clip" ? c.number : ""} of ${t}`, aim?.entry && c.cmd === "clip" && c.number > aim.entry.clips ? `${t} has ${plural(aim.entry.clips, "clip")}` : "Selected, the playhead on its start"],
    transition: c.cmd === "transition" && c.kind !== undefined
      ? [`${selectedClip ? `Clip ${selectedClip.number}: ` : ""}${c.kind ? `${TRANSITIONS[c.kind].label} on its cut` : "plain cut"}`, cutSaid(selectedClip)]
      : [`Transition${c.cmd === "transition" && c.words ? ` “${c.words}”` : "…"}`, c.cmd === "transition" && c.words ? "No transition called that" : "On the cut into the selected clip"],
    "slow-motion": [`${selectedClip ? `Clip ${selectedClip.number}: slow` : "Slow"} motion ×${c.cmd === "slow-motion" ? c.factor : 2}`, !selectedClip ? "No clip selected in an open timeline" : selectedClip.slow ? `${selectedClip.timelineName} · the whole clip at ${c.cmd === "slow-motion" && c.factor === 4 ? "a quarter" : "half"} speed, as a new take` : "It has no take to slow"],
    "motion-windows": [`${selectedClip ? `Clip ${selectedClip.number}: ` : ""}Motion transfer in windows`, !selectedClip ? "No clip selected in an open timeline" : selectedClip.toSource ? `${selectedClip.timelineName} · on the source lane, made into Motion transfer clips window by window` : "Only a video brought in (no model of its own) goes on the source lane"],
    "stop-all-pods": stopAllSaid(queueNow),
    spending: x.spending ? [`Spending today ${usd(x.spending.today)}${x.spending.caps.day ? ` of ${usd(x.spending.caps.day)}` : ""}`, spendingSaid(x.spending)] : ["Spending", "The rented GPUs: no RunPod key set, or not read yet"],
    "find-models": [c.cmd === "find-models" && c.words ? `Find models: “${c.words}”` : "Find models…", x.lookups ? "Civitai, Hugging Face and yours · to download onto this PC" : "Turn on Search Hugging Face and Civitai (Settings › Models) first"],
    "check-updates": ["Check for updates", x.updates?.newer && x.updates.latest ? `Afflatus ${x.updates.latest.version} is out · you have ${x.updates.version}` : x.updates ? `You have ${x.updates.version}${x.updates.checkedAt ? ` · checked ${when(x.updates.checkedAt)}` : ""} · GitHub asked now` : "GitHub asked now"],
    update: x.updates?.newer && x.updates.latest
      ? [`Update to ${x.updates.latest.version}`, x.updates.canUpdate ? `You have ${x.updates.version} · Afflatus restarts once the queue is empty; your library stays as it is` : x.updates.cannot ?? "Not from here"]
      : ["Update Afflatus", x.updates ? `You have ${x.updates.version}, the latest known · check for updates asks again` : "Not read yet"],
    "go-back": x.updates?.previous
      ? [`Go back to ${x.updates.previous.version}…`, x.updates.here ? "Its library as it was at the update · asked first · Afflatus restarts" : "Only on the computer Afflatus runs on"]
      : ["Go back to the previous version…", "No previous version kept"],
    "test-notify": [`Send a test notification${c.cmd === "test-notify" && c.channel ? ` to ${c.channel === "telegram" ? "Telegram" : "Discord"}` : ""}`, channelsSaid(x.channels)],
  };
  const [label, meta] = words[c.cmd];
  // one row a transition kind (`> transition` lists them): each its own key
  const kindKey = c.cmd === "transition" && c.kind !== undefined ? `:${c.kind ?? "off"}` : "";
  return { key: `cmd:${c.cmd}${recipe ? `:${recipe.id}` : ""}${preset ? `:${preset.id}` : ""}${kindKey}`, kind: "command", label, meta, group: "Commands", verb: "run", p: prepare(label), command: c, recipe, preset, keys: commandKeys(c) };
}

/** `> stop all pods`: how many bill now, by name. */
function stopAllSaid(q: QueueNow | null): [string, string] {
  const pods = (q?.machines ?? []).filter((m) => billing(m.rented));
  return [pods.length ? `Stop all pods · ${pods.length}…` : "Stop all pods…", pods.length ? `${pods.map((m) => m.label).join(", ")} · their GPUs stop billing, their disks go on · asked first` : "No pod runs or starts"];
}

/** Which of Telegram and Discord `> test notification` can write to. */
function channelsSaid(ch: CommandCtx["channels"]): string {
  const set = [ch?.telegram && "Telegram", ch?.discord && "Discord"].filter(Boolean);
  return set.length ? `${set.join(" and ")} set up · a test message, as their card's Send a test` : "Set up Telegram or Discord first (Settings › Interface)";
}

/** Whether a command offered only where it applies applies now. */
const applies = (x: CommandCtx, id: CommandId): boolean =>
  id === "split" || id === "previous-take" || id === "next-take" ? Boolean(x.selectedClip)
  : id === "mirror-pin" ? Boolean(x.selectedClip?.pins?.length)
  : id === "cancel-waiting" ? Boolean(x.queue?.waiting)
  : id === "retry-failed" || id === "dismiss-failed" ? Boolean(x.queue?.failed)
  : id === "group-queue" ? Boolean(x.queue?.saves)
  : id === "unload" ? Boolean(x.queue?.online)
  : id === "cancel-hunt" ? Boolean(x.queue?.hunting)
  : id === "slow-motion" ? Boolean(x.selectedClip?.slow)
  : id === "motion-windows" ? Boolean(x.selectedClip?.toSource)
  // a pod running or starting: the one command that stops paying for all of them
  : id === "stop-all-pods" ? Boolean(x.queue?.machines.some((m) => billing(m.rented)))
  : id === "spending" ? Boolean(x.spending)
  : id === "update" ? Boolean(x.updates?.newer)
  : id === "go-back" ? Boolean(x.updates?.previous)
  : id === "test-notify" ? Boolean(x.channels?.telegram || x.channels?.discord)
  : true;

/** A machine's state in a word, for its rows ("rendering", "paused"); "not found" for a name no machine has. */
/** A machine by the name typed: the same name, else the first that begins with it. */
function podOf(q: QueueNow | null, label: string) {
  return q?.machines.find((x) => x.label.toLowerCase() === label.toLowerCase()) ?? q?.machines.find((x) => x.label.toLowerCase().startsWith(label.toLowerCase()));
}

function machineSaid(q: QueueNow | null, label: string): string {
  const m = podOf(q, label);
  if (!m) return "no ComfyUI by that name";
  // a rented pod says its own state: stopped is not offline
  if (m.rented && m.rented.status !== "RUNNING") return rentedSaid(m.rented);
  return m.paused ? "paused" : m.online === false ? "offline" : m.running ? "rendering" : "idle";
}

/** What a Start of a rented pod says before it is chosen: its rate, or that it cannot. */
function startSaid(r: RentedState | null | undefined): string {
  if (!r) return "no rented pod by that name";
  if (r.capped) return "a spending cap is reached";
  return r.status === "EXITED" || r.status === "ERROR" ? rateSaid(r) : rentedSaid(r);
}

/**
 * With several ComfyUIs, each one's own rows, ready to run: Pause or Resume it, Use only it, Unload it, Load a model on it,
 * its log, its render times and its models, Generate on it, and with a timeline open, Render missing on it. Typing "pause" lists
 * every machine that can be paused, "use only" every machine, a machine's name all it can do.
 */
const machineRows = (x: CommandCtx): Item[] =>
  (x.queue?.machines ?? []).flatMap((m) => {
    const own = (c: Command) => {
      const row = commandRow(x, c);
      const said = { "use-only": "use only", "load-panel": "load a model on", "machine-log": "comfyui log console", "open-comfy": "open comfyui on", "start-pod": "start pod", "stop-pod": "stop pod", "machine-times": "render times", "machine-models": "models on", generate: "generate on", "render-missing": "render missing on" } as Partial<Record<Command["cmd"], string>>;
      return { ...row, key: `${row.key}:${m.id}`, p: prepare(`${row.label} ${said[c.cmd] ?? c.cmd} ${m.label}`) };
    };
    // a rented pod: Start while it is stopped, Stop while it runs
    const r = m.rented;
    const pod = r ? (r.status === "EXITED" || r.status === "ERROR" ? [own({ cmd: "start-pod", machine: m.label })] : r.status === "RUNNING" ? [own({ cmd: "stop-pod", machine: m.label })] : []) : [];
    // Start last: a pod's name typed and Enter pressed shows it, it does not start it
    return [
      own(m.paused ? { cmd: "resume", machine: m.label } : { cmd: "pause", machine: m.label }), own({ cmd: "use-only", machine: m.label }),
      ...(m.online !== false && !m.running ? [own({ cmd: "unload", machine: m.label })] : []),
      ...(m.online !== false ? [own({ cmd: "load-panel", machine: m.label })] : []),
      own({ cmd: "open-comfy", machine: m.label }), own({ cmd: "machine-log", machine: m.label }), own({ cmd: "machine-times", machine: m.label }), own({ cmd: "machine-models", machine: m.label }),
      ...(m.online !== false ? [own({ cmd: "generate", machine: m.label })] : []),
      // with a timeline open: its clips with no take, rendered on this machine
      ...(m.online !== false && x.aim ? [own({ cmd: "render-missing", machine: m.label })] : []),
      ...pod,
    ];
  });

/** A command that needs no figures, as a row ready to run (its clip and counts said), when it applies. */
export const liveRow = (x: CommandCtx, id: CommandId): Item[] => (applies(x, id) ? [commandRow(x, { cmd: id } as Command)] : []);

/** The commands as they are offered before their figures: their names found like anything else. */
export const templateItems = (): Item[] =>
  COMMANDS.map((c) => ({ key: `cmd:${c.id}`, kind: "command" as const, label: c.name, meta: `${c.what} · ${c.example}`, group: "Commands" as const, verb: c.needs ? "complete" : "run", p: prepare(`${c.name} ${c.typed}`), complete: c.needs ? `> ${c.typed}` : undefined, keys: commandKeys({ cmd: c.id }) }));

/**
 * The commands as the bar offers them now: those that depend on the moment with what they act on, and only when they
 * apply; one that needs no figures is ready as it stands (Enter on "Pause queue" pauses it), one that does completes the bar.
 */
export const commandTemplates = (x: CommandCtx): Item[] => [
  ...templateItems().flatMap((t) => {
    const id = t.key.slice(4) as CommandId;
    if (LIVE.includes(id)) return liveRow(x, id).map((r) => ({ ...r, p: t.p }));
    const ready = t.complete ? null : parseCommand(COMMANDS.find((c) => c.id === id)?.typed ?? "");
    return [ready ? { ...commandRow(x, ready), p: t.p } : t];
  }),
  ...machineRows(x),
];
