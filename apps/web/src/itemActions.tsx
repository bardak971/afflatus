import { Send, ArrowRightFromLine, AudioLines, Clapperboard, Columns2, Copy, Download, Eraser, ExternalLink, Eye, Film, FlipHorizontal2, FlipVertical2, FolderKanban, Hand, ImageDown, Info, Maximize2, Mic, Paintbrush, Pencil, PenLine, PersonStanding, Scissors, Shuffle, SlidersHorizontal, Smile, SquareDashed, Star, Trash2, Undo2, VolumeX, Wand2, type LucideIcon } from "lucide-react";
import type { MenuItem } from "./ContextMenu";

/**
 * The one list of what can be done with an item of the library, per media type: every place that shows actions on an
 * item (the Studio's grid, the stage's results column and its bar, the viewer's menu and side, the timeline's media
 * shelf, the Projects panel, the command bar, a finished job of the queue) shows this list, in this order, with these
 * labels and keys. A place puts its own first section before it (Use in this draft, Use in clip 3, Show in the Studio…)
 * and says where the keys act; it does not make a list of its own. Pure, for the tests: the hooks that fill it with
 * what each action does are in useItemActions.tsx.
 */

export type Kind = "image" | "video" | "audio";

export type ActionId =
  | "open" | "keep" | "download" | "rename"
  | "reuse-same" | "reuse-new" | "variation" | "i2v" | "extend" | "motion"
  | "upscale" | "face" | "hand" | "background" | "inpaint" | "edit" | "outpaint" | "mirror-h" | "mirror-v"
  | "trim" | "save-frame" | "extract-audio" | "remove-sound" | "voice"
  | "compare" | "details" | "copy-seed" | "comfy"
  | "timeline" | "move" | "send"
  | "bin" | "erase";

export type GroupId = "item" | "make" | "passes" | "tools" | "look" | "put" | "last";

interface Spec {
  group: GroupId;
  label: string;
  /** The viewer's key for it, in the keys grammar: drawn only where it acts (`keysShown`). */
  key?: string;
  kinds: readonly Kind[];
  icon: LucideIcon;
  /** What it does, in a sentence: the button's tip (a menu shows the reason it is off instead). */
  tip: string;
}

const ALL: readonly Kind[] = ["image", "video", "audio"];
const SEEN: readonly Kind[] = ["image", "video"];

/** Every action, in the order every list shows them. */
export const ACTIONS: Record<ActionId, Spec> = {
  open: { group: "item", label: "Open", key: "Enter", kinds: ALL, icon: Eye, tip: "Open it large, with how it was made and everything that can be done with it." },
  keep: { group: "item", label: "Keep", key: "S", kinds: ALL, icon: Star, tip: "Keep it: it never goes to the bin on its own. What nobody kept goes to the bin by itself after its time (Settings › Storage)." },
  download: { group: "item", label: "Download", key: "D", kinds: ALL, icon: Download, tip: "Download the file, under the app's name for it." },
  rename: { group: "item", label: "Rename…", key: "F2", kinds: ALL, icon: Pencil, tip: "A name of your own, which the library shows and the search goes by." },
  "reuse-same": { group: "make", label: "Reuse · same seed", key: "L", kinds: ALL, icon: SlidersHorizontal, tip: "Open the form with the same generation parameters and the same seed, as a new draft." },
  "reuse-new": { group: "make", label: "Reuse · new seed", key: "Shift+L", kinds: ALL, icon: SlidersHorizontal, tip: "Open the form with the same generation parameters and a new seed, as a new draft." },
  variation: { group: "make", label: "Variation", key: "V", kinds: ALL, icon: Shuffle, tip: "Same parameters, new seed: queued at once." },
  i2v: { group: "make", label: "Image to video (i2v)", key: "M", kinds: ["image"], icon: Clapperboard, tip: "A new video with this picture as the first frame, on the video model used last." },
  extend: { group: "make", label: "Extend", key: "C", kinds: ["video"], icon: ArrowRightFromLine, tip: "A new clip that carries on from the end of this one, same model and parameters." },
  motion: { group: "make", label: "Motion transfer…", key: "Shift+M", kinds: SEEN, icon: PersonStanding, tip: "A new draft of Motion transfer with this in its place: a picture is what moves, a video is how it moves (the driving video)." },
  upscale: { group: "passes", label: "Upscale 2x", key: "U", kinds: ["image"], icon: Maximize2, tip: "Upscale 2x: queued at once with the picture's generation parameters." },
  face: { group: "passes", label: "Face refine", key: "F", kinds: ["image"], icon: Smile, tip: "Face refine: queued at once with the picture's generation parameters." },
  hand: { group: "passes", label: "Hand refine", key: "H", kinds: ["image"], icon: Hand, tip: "Hand refine: Face refine on the hand detector (hand_yolov8s), at denoise 0.35, crop factor 2, a prompt about hands; queued at once with the picture's generation parameters." },
  background: { group: "passes", label: "Remove background", key: "B", kinds: ["image"], icon: Eraser, tip: "Remove background: queued at once." },
  inpaint: { group: "passes", label: "Inpaint…", key: "I", kinds: ["image"], icon: Paintbrush, tip: "Inpaint: a new draft with this picture as the source, the mask painter open." },
  edit: { group: "passes", label: "Edit…", key: "E", kinds: ["image"], icon: PenLine, tip: "Edit / img2img: a new draft in the form with this picture as the source." },
  outpaint: { group: "passes", label: "Outpaint…", key: "R", kinds: ["image"], icon: SquareDashed, tip: "Outpaint: a new draft in the form, the picture on a larger canvas." },
  "mirror-h": { group: "passes", label: "Mirror ↔", key: "Shift+H", kinds: ["image"], icon: FlipHorizontal2, tip: "A mirrored copy, left and right swapped: a new picture beside this one, kept, its source remembered. Instant, no GPU." },
  "mirror-v": { group: "passes", label: "Mirror ↕", key: "Shift+V", kinds: ["image"], icon: FlipVertical2, tip: "A mirrored copy, top and bottom swapped: a new picture beside this one, kept, its source remembered. Instant, no GPU." },
  trim: { group: "tools", label: "Trim", key: "T", kinds: ["video", "audio"], icon: Scissors, tip: "Pick an in and an out, then copy, split or remove the range (a video: save its frames, or generate between them; a sound: its loudness evened out)." },
  "save-frame": { group: "tools", label: "Save frame", key: "G", kinds: ["video"], icon: ImageDown, tip: "Save the frame the video is paused on as an image in your library." },
  "extract-audio": { group: "tools", label: "Extract audio", kinds: ["video"], icon: AudioLines, tip: "Its audio track as a file of its own in your library: for another clip, or as music." },
  "remove-sound": { group: "tools", label: "Remove sound", kinds: ["video"], icon: VolumeX, tip: "A copy of the video without its sound, beside it in your library; this one stays as it is." },
  voice: { group: "tools", label: "Use as voice sample", kinds: ["video", "audio"], icon: Mic, tip: "A new draft on a model that speaks with this voice sample." },
  compare: { group: "look", label: "Compare", key: "X", kinds: SEEN, icon: Columns2, tip: "Pin this one and move to another with the arrow keys: side by side, videos in step, two pictures also with a wipe." },
  details: { group: "look", label: "Details", key: "P", kinds: ALL, icon: Info, tip: "The generation parameters: those it was made with, or for a file made elsewhere the ones written in it (PNG info)." },
  "copy-seed": { group: "look", label: "Copy the seed", kinds: ALL, icon: Copy, tip: "The seed it was rendered with, on the clipboard." },
  comfy: { group: "look", label: "Open in ComfyUI", kinds: ALL, icon: ExternalLink, tip: "Its graph, built again from these parameters, in ComfyUI's editor." },
  timeline: { group: "put", label: "Timeline", kinds: ALL, icon: Film, tip: "At the end of a timeline, or a new one from it; a sound as a timeline's music." },
  move: { group: "put", label: "Move to", kinds: ALL, icon: FolderKanban, tip: "Into a project and a folder, or back to the Inbox." },
  send: { group: "put", label: "Send to", kinds: SEEN, icon: Send, tip: "The file itself to your Telegram chat or Discord channel (Settings › Notifications), with its name." },
  bin: { group: "last", label: "Move to the bin", key: "Del", kinds: ALL, icon: Trash2, tip: "Move to the bin." },
  // only in the bin, after Put back (see itemActions)
  erase: { group: "last", label: "Delete now…", kinds: ALL, icon: Trash2, tip: "Erased now, file and all, instead of waiting in the bin. Asked first; cannot be undone." },
};

/** The order of every list (Delete now is not in it: it is the bin's own, see itemActions). */
export const ORDER = (Object.keys(ACTIONS) as ActionId[]).filter((id) => id !== "erase");

/** What a media type's list holds, in order: what never applies to the type is not in it at all. */
export const actionIds = (kind: Kind): ActionId[] => ORDER.filter((id) => ACTIONS[id].kinds.includes(kind));

/** The passes by the viewer's key for them (viewer/shared.ts OPS reads the recipe for each). */
export const PASS_KEYS: Partial<Record<ActionId, string>> = { upscale: "u", face: "f", hand: "h", background: "b", inpaint: "i", edit: "e", outpaint: "r" };

/** A group's heading, where a place shows headings (the viewer's side); a video's tools and a sound's are named for it. */
export const groupTitle = (group: GroupId, kind: Kind): string =>
  ({ item: "", make: "Make from it", passes: "Passes", tools: kind === "audio" ? "Sound" : "Video tools", look: "Look", put: "Put it in", last: "" })[group];

/** What the list is made from: the item, and what is known of it and of the place now. */
export interface ItemFacts {
  kind: Kind;
  /** Send to: Telegram, Discord, those set up in Settings › Notifications; none, and Send to is not in the list. */
  shares?: MenuItem[];
  inBin: boolean;
  kept: boolean;
  hasSound: boolean;
  /** Its generation parameters are being read. */
  reading: boolean;
  /** Made here (it has generation parameters). */
  madeHere: boolean;
  /** Made here with a model that is still here: what reuses its parameters can. */
  generated: boolean;
  seed: number | null;
  /** The video model a picture would open (i2v), by name; null: none takes a first frame. */
  opener: string | null;
  /** The model a Motion transfer would open on, by name; null or absent: none is installed. */
  mover?: string | null;
  /** With more than one model to choose from, Image to video's and Motion transfer's submenus: each model, the one used last first. */
  openers?: MenuItem[];
  movers?: MenuItem[];
  /** A model can carry a clip on (Extend). */
  carrier: boolean;
  /** The recipe each pass would use, by its title; absent: none is installed for it. */
  passes: Partial<Record<ActionId, string>>;
  /** A model takes a voice sample. */
  voice: boolean;
  comfyOnline: boolean;
  /** Open in the viewer over the screen: it is the one shown, Open has nothing to do. */
  shownHere?: boolean;
  /** Compare works here; a string: why not. */
  compare: true | string;
  comparing?: boolean;
  trimming?: boolean;
  /** The Timeline submenu (recent timelines, another, a new one; for a sound: as music). */
  timelines: MenuItem[];
  /** The Move to submenu (project › folder, the Inbox). */
  moves: MenuItem[];
  /** What is running now: its action is off meanwhile. */
  busy?: Partial<Record<ActionId, boolean>>;
  /** A job just queued from it (a pass, a variation): its button says "Queued" for a moment. */
  queued?: Partial<Record<ActionId, boolean>>;
}

/** One action of the list, as a place draws it: a menu line, a button. */
export interface ItemAction {
  id: ActionId;
  group: GroupId;
  label: string;
  key?: string;
  icon: LucideIcon;
  tip: string;
  /** Why it does nothing now, or a few quiet words on what it does. */
  note?: string;
  disabled: boolean;
  /** A switch that is on (Kept, Trim open, comparing). */
  pressed?: boolean;
  /** Its job was just queued: drawn with the ok look, its label "Queued", for a moment. */
  done?: boolean;
  danger?: boolean;
  run?(): void;
  items?: MenuItem[];
}

export type Runs = Partial<Record<ActionId, () => void>>;

/** Out of everything but its own little submenus: the reason it is off, or nothing when one of its lines works. */
const anyOn = (items: MenuItem[]): boolean => items.some((it) => it !== "—" && !it.disabled && (it.run || (it.items && anyOn(it.items))));

/**
 * The item's list: every action its type has, in order; one that does not apply now stays in its place, off, with the
 * reason as its note. In the bin the list is the bin's own: Put back and Delete now first, then Open, Download and
 * Compare (a look that changes nothing); nothing else, as nothing else can be done there.
 * `runs` is what each does in the place; an action with no run there is off. `notes` are the place's own words on one.
 */
export function itemActions(f: ItemFacts, runs: Runs, notes: Partial<Record<ActionId, string>> = {}): ItemAction[] {
  const notMade = f.reading ? "reading…" : f.madeHere ? "its model is not here" : "not generated here";
  const why = (id: ActionId): string | undefined => {
    if (f.inBin && !["open", "download", "bin", "compare"].includes(id)) return "in the bin";
    switch (id) {
      case "open": return f.shownHere ? "shown here" : undefined;
      case "reuse-same": case "reuse-new": case "variation": return f.generated ? undefined : notMade;
      case "i2v": return f.opener ? undefined : "no video model takes a first frame";
      case "extend": return f.carrier ? undefined : "no video model carries a clip on";
      case "motion": return f.mover ? undefined : "no model does motion transfer";
      case "upscale": case "face": case "hand": case "background": case "inpaint": case "edit": case "outpaint": return f.passes[id] ? undefined : "no model for it";
      case "extract-audio": case "remove-sound": return f.hasSound ? undefined : "it has no sound";
      case "voice": return f.kind === "video" && !f.hasSound ? "it has no sound" : f.voice ? undefined : "no model takes a voice sample";
      case "compare": return f.compare === true ? undefined : f.compare;
      case "copy-seed": return f.seed !== null ? undefined : f.reading ? "reading…" : "no seed";
      case "comfy": return !f.madeHere ? (f.reading ? "reading…" : "not generated here") : f.comfyOnline ? undefined : "ComfyUI is offline";
      case "timeline": return anyOn(f.timelines) ? undefined : f.kind === "audio" ? "no timeline yet" : undefined;
      case "move": return anyOn(f.moves) ? undefined : "no project yet";
      default: return undefined;
    }
  };
  const list = actionIds(f.kind).map((id): ItemAction => {
    const spec = ACTIONS[id];
    const off = why(id);
    const items = id === "timeline" ? f.timelines : id === "move" ? f.moves : id === "send" ? f.shares : id === "i2v" && (f.openers?.length ?? 0) > 1 ? f.openers : id === "motion" && (f.movers?.length ?? 0) > 1 ? f.movers : undefined;
    const run = runs[id];
    const base: ItemAction = { id, group: spec.group, label: spec.label, key: spec.key, icon: spec.icon, tip: spec.tip, note: off ?? notes[id], disabled: Boolean(off) || Boolean(f.busy?.[id]) || (!run && !items?.length), run, items: off ? undefined : items };
    if (f.queued?.[id] && !off) return { ...base, label: "Queued", done: true };
    switch (id) {
      case "keep": return { ...base, label: f.kept ? "Unkeep" : "Keep", pressed: f.kept, tip: f.kept ? "Kept: it stays. Unkeep it to let it go to the bin after a day again." : spec.tip };
      case "bin": return f.inBin
        ? { ...base, label: "Put back", key: undefined, icon: Undo2, tip: "Out of the bin, back where it was." }
        : { ...base, danger: true };
      case "trim": return { ...base, pressed: Boolean(f.trimming) };
      case "compare": return { ...base, pressed: Boolean(f.comparing) };
      case "copy-seed": return { ...base, note: off ?? (f.seed !== null ? String(f.seed) : undefined) };
      case "i2v": return { ...base, note: off ?? f.opener ?? undefined };
      case "motion": return { ...base, note: off ?? f.mover ?? undefined };
      default: return base;
    }
  });
  // Send to only where somewhere to send is set up
  if (!f.inBin) return f.shares?.length ? list : list.filter((x) => x.id !== "send");
  const spec = ACTIONS.erase;
  const erase: ItemAction = { id: "erase", group: spec.group, label: spec.label, icon: spec.icon, tip: spec.tip, danger: true, disabled: !runs.erase, run: runs.erase };
  const pick = (id: ActionId) => list.filter((a) => a.id === id);
  return [...pick("bin"), erase, ...pick("open"), ...pick("download"), ...pick("compare")];
}

/** Where a list is shown: each place's keys act or not. */
export type Place = "grid" | "stage" | "viewer" | "inline" | "shelf" | "projects" | "command" | "queue";

/**
 * Whether a place draws an action's key: only where the key does it. The viewer's keys act in the viewer (over the
 * screen, or in place on the stage, where Enter opens it large and F2 asks its name); the command bar names the viewer's key; the Projects
 * panel's own keys keep, rename and bin a row; the Studio's grid, the media shelf and the queue have none of these.
 */
export function keysShown(place: Place, id: ActionId): boolean {
  switch (place) {
    case "viewer": return id !== "open";
    case "inline": case "stage": return true;
    case "command": return true;
    case "projects": return id === "keep" || id === "rename" || id === "bin";
    default: return false;
  }
}

/** The submenu the passes fold into in a menu, by its label. */
export const PASSES = "Passes";

/**
 * The list as a menu: its groups apart, the passes folded into a submenu (in the viewer's side they are buttons; in the
 * stage's Passes menu, `fold` false, lines of their own), the keys only where they act. Every menu of an item is this,
 * after the place's own first section.
 */
export function toMenu(list: ItemAction[], place: Place, fold = true): MenuItem[] {
  const line = (a: ItemAction): MenuItem => ({
    label: a.label, key: keysShown(place, a.id) ? a.key : undefined, icon: <a.icon size={14} />, note: a.note, danger: a.danger, disabled: a.disabled,
    ...(a.items ? { items: a.items } : { run: a.run }),
  });
  const out: MenuItem[] = [];
  let group: GroupId | null = null;
  for (const a of list) {
    if (a.group !== group && group !== null) out.push("—");
    if (a.group === "passes" && fold) {
      if (group !== "passes") {
        const passes = list.filter((x) => x.group === "passes");
        const off = passes.every((x) => x.disabled);
        out.push({ label: PASSES, icon: <Wand2 size={14} />, disabled: off, note: off ? passes[0]?.note : undefined, items: passes.map(line) });
      }
    } else out.push(line(a));
    group = a.group;
  }
  return out;
}

/** A menu of an item: the place's own first section, then the list. */
export const placeMenu = (own: MenuItem[], list: ItemAction[], place: Place): MenuItem[] => {
  const head = own.filter((it, i) => !(it === "—" && i === own.length - 1));
  return [...head, ...(head.length ? ["—" as const] : []), ...toMenu(list, place)];
};

/**
 * The stage's bar under the item: one short row (Keep, Variation, Upscale 2x or Trim, Compare), "Passes" with what makes
 * something from it, and "···" with the rest of the list; the bin at the end. Every action is in exactly one of them,
 * but the row's, which "Passes" lists again with its own group.
 */
export function stageBar(list: ItemAction[]): { row: ItemAction[]; passes: ItemAction[]; more: ItemAction[]; bin: ItemAction | undefined } {
  // told by an action only that kind has (Trim is a video's and a sound's)
  const only = (k: Kind) => list.some((a) => ACTIONS[a.id].kinds.length === 1 && ACTIONS[a.id].kinds[0] === k);
  const kind: Kind = list.some((a) => a.id === "upscale") ? "image" : only("video") ? "video" : "audio";
  const rowIds: ActionId[] = kind === "image" ? ["keep", "variation", "upscale", "compare"] : kind === "video" ? ["keep", "variation", "trim", "compare"] : ["keep", "variation", "trim"];
  const folded: GroupId[] = kind === "audio" ? [] : ["make", "passes", "tools"];
  const row = rowIds.flatMap((id) => list.filter((a) => a.id === id));
  const passes = list.filter((a) => folded.includes(a.group));
  const more = list.filter((a) => a.id !== "bin" && !folded.includes(a.group) && !rowIds.includes(a.id));
  return { row, passes, more, bin: list.find((a) => a.id === "bin") };
}

/**
 * Where each action sits in the viewer's side: the buttons of its groups (Make from it, Passes, the tools, Look with
 * Download), the Keep of the line under the name, the name itself (F2), the seed's cell, ComfyUI under the parameters,
 * the timeline row, the folder chip, the bin at the foot. Open has no place there: the item is open.
 */
export type SideSlot = "buttons" | "status" | "name" | "seed" | "parameters" | "put" | "folder" | "foot" | "none";

export const sideSlot = (id: ActionId): SideSlot => {
  const group = ACTIONS[id].group;
  if (group === "make" || group === "passes" || group === "tools") return "buttons";
  switch (id) {
    case "compare": case "details": case "download": case "send": return "buttons";
    case "keep": return "status";
    case "rename": return "name";
    case "copy-seed": return "seed";
    case "comfy": return "parameters";
    case "timeline": return "put";
    case "move": return "folder";
    case "bin": return "foot";
    default: return "none";
  }
};

/** The viewer's side's buttons, in groups: the list's own groups in its order, Download last in Look (where the picture is looked at). */
export function sideGroups(list: ItemAction[]): Array<{ group: GroupId; actions: ItemAction[] }> {
  const out: Array<{ group: GroupId; actions: ItemAction[] }> = [];
  const put = (group: GroupId, a: ItemAction) => {
    const at = out.find((g) => g.group === group);
    if (at) at.actions.push(a);
    else out.push({ group, actions: [a] });
  };
  for (const a of list) if (sideSlot(a.id) === "buttons" && a.id !== "download") put(a.group, a);
  const download = list.find((a) => a.id === "download");
  if (download) put("look", download);
  return out;
}

/** What a key pressed in the viewer is in the grammar of the list's keys ("Shift+L", "Del", "F2", "U"). */
export function keyOfEvent(e: { key: string; shiftKey: boolean }): string {
  // Backspace is Del wherever Del works (a Mac's keyboard has no Delete key of its own)
  if (e.key === "Delete" || e.key === "Backspace") return "Del";
  if (e.key === "F2" || e.key === "Enter") return e.key;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Shift with a letter is a key of its own (Shift+L, Shift+H): it never does what the letter alone does
  return e.shiftKey && /^[A-Z]$/.test(k) ? `Shift+${k}` : k;
}

/** The action a key does in a place, when it acts there and is on now; passes included. */
export function actionOfKey(list: ItemAction[], place: Place, key: string): ItemAction | undefined {
  return list.find((a) => a.key === key && keysShown(place, a.id) && !a.disabled && a.run);
}
