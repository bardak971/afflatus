import { ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, Camera, ChevronLeft, ChevronRight, Copy, Eye, Film, Gauge, Image as ImageIcon, Images, Link2, ListEnd, Mic, Music, Repeat, Scissors, SlidersHorizontal, Split, Trash2, Volume2, VolumeX, Wand2, X } from "lucide-react";
import type { InputSpec, ReferenceValue } from "@afflatus/core";
import type { Asset, Clip, ClipPatch, RecipeInfo, Timeline, TimelinePatch } from "../api";
import { fold, groups, type MenuItem } from "../ContextMenu";
import { PIN_WORDS, pinInputs, splitPoint, type PinMirror, type TimeRange } from "./model";
import { unsplittable } from "./runSplit";

/** Where the playhead stands on a clip, as the player says it. */
type Place = { clip: Clip; localMs: number; assetMs: number };

/** What a clip's menu reaches in the editor: its mutations by name, and what it reads to say each line. */
export interface ClipMenuActions {
  /** The clips as they are on screen, for a clip's number. */
  clips: Clip[];
  recipes: RecipeInfo[];
  /** The timeline's source: a window of it does not split (unsplittable). */
  source?: Timeline["source"];
  inputsOf(c: Clip): Record<string, unknown>;
  /** Where the playhead stands on a clip, when it stands on this one. */
  onClip(c: Clip): Place | null;
  /** Which of the editor's mutations is running: its lines are disabled meanwhile. */
  pending: { render: boolean; split: boolean; duplicate: boolean; loop: boolean; add: boolean; frame: boolean; range: boolean };
  render(c: Clip): void;
  patch(clip: string, patch: ClipPatch): void;
  setRange(range: TimeRange): void;
  split(clip: string, atMs: number): void;
  /** The clip plays its take before (-1) or after (1), as a click on it in the clip panel. */
  stepTake(clip: string, by: -1 | 1): void;
  duplicate(clip: string): void;
  loop(c: Clip): void;
  /** Cut the clip at this moment of it and add a clip that continues from there. */
  continueFrom(c: Clip, localMs: number): void;
  /** The frame at this moment of a video, saved to the library. */
  frame(asset: string, at: number): void;
  /** The viewer, on this asset. */
  open(asset: Asset): void;
  slow(factor: 2 | 4, inMs: number, outMs: number): void;
  remove(clip: string): void;
  /** One place earlier (-1) or later (1) on the timeline. */
  move(clip: string, by: -1 | 1): void;
  /** The clips picked with Ctrl + click: a menu on one of them removes them all. */
  picked: Set<string>;
  removeMany(clips: string[]): void;
  /** The join before this clip opened in the column (its extend or cut, its transition), the clip selected with it. */
  openJoin?(clip: string): void;
  /** The part of a video clip that plays made the timeline's source, the clips made from it to take its place (Motion transfer, window by window). */
  toSource?(c: Clip): void;
}

/** Split the clip at the playhead (S, Ctrl B): on when the playhead stands inside what it plays. */
const splitHere = (c: Clip, act: ClipMenuActions): MenuItem => {
  const onIt = act.onClip(c);
  const cut = onIt ? splitPoint(c, onIt.assetMs) : null;
  const at = cut && "at" in cut ? cut.at : null;
  const why = unsplittable(c, act.recipes, act.source ?? null);
  return { label: "Split at the playhead", key: "S | Ctrl+B", icon: <Split size={14} />, disabled: Boolean(why) || at === null || act.pending.split, note: why ?? (!onIt ? "put the playhead on this clip" : at === null ? "move the playhead inside the clip" : "two clips, the second from the playhead on"), run: () => !why && at !== null && act.split(c.id, at) };
};

/**
 * The take before and after the one that plays (Alt [ and Alt ]): the clip panel's list of takes, from the keyboard. Only
 * the steps there are (none before the first take).
 */
const takeSteps = (c: Clip, act: ClipMenuActions): MenuItem[] => {
  const i = c.takes.findIndex((x) => x.id === c.take?.id);
  if (i < 0) return [];
  return [
    ...(i > 0 ? [{ label: "Previous take", key: "Alt+[", icon: <ChevronLeft size={14} />, note: `take ${i} of ${c.takes.length}`, run: () => act.stepTake(c.id, -1) }] : []),
    ...(i < c.takes.length - 1 ? [{ label: "Next take", key: "Alt+]", icon: <ChevronRight size={14} />, note: `take ${i + 2} of ${c.takes.length}`, run: () => act.stepTake(c.id, 1) }] : []),
  ];
};

/**
 * The right-click menu of a clip: what the Inspector offers on it, at the pointer, in the menus' order (ContextMenu.tsx):
 * its video and a new take first, then what makes something from it, its tools (its joins folded), its place on the
 * timeline, Remove last. A row that would change nothing is not drawn (Move earlier on the first clip, Make it loop on a
 * clip that loops already).
 */
export const clipMenuItems = (c: Clip, act: ClipMenuActions): MenuItem[] => {
  const index = act.clips.findIndex((x) => x.id === c.id);
  const recipe = act.recipes.find((r) => r.id === c.recipe);
  const canCarry = Boolean(recipe && index > 0 && recipe.inputs.some((i) => (i.type === "clip" && i.role === "previous") || (i.type === "image" && i.role === "start")));
  const video = c.take?.asset ?? null;
  const next = index >= 0 ? act.clips[index + 1] : undefined;
  const here = act.onClip(c);
  const onIt = here ? undefined : "put the playhead on this clip";
  // a clip that plays round: its last frame pinned to its first (the model has to take a last frame)
  const loop = ((): MenuItem[] => {
    if (c.kind !== "video" || !recipe || !pinInputs(recipe).end) return [];
    const pins = pinInputs(recipe);
    const stored = act.inputsOf(c);
    const flows = index > 0 && c.joined === "continue";
    const opens = !flows && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
    const ends = typeof stored[pins.end!] === "string" ? (stored[pins.end!] as string) : null;
    if (ends && ends === opens) return [];
    return [{
      label: "Make it loop", icon: <Repeat size={14} />, disabled: (!opens && !c.take) || act.pending.loop,
      note: act.pending.loop ? "making…" : opens ? "its last frame becomes its first frame, so it plays round and round" : c.take ? "its last frame becomes the first frame of its take, so it plays round and round; from the next take" : "give it a first frame, or render it once",
      run: () => act.loop(c),
    }];
  })();
  // its joins, before and after: on the selected clip the dots on the track are mostly under its trim edges, which take
  // the press there (the edges first, so that a trim is never a join's click)
  const joins: MenuItem[] = [
    ...(canCarry ? [c.joined === "continue"
      ? { label: "Make it a cut", icon: <Scissors size={14} />, note: `from clip ${index}`, run: () => act.patch(c.id, { joined: "cut" }) }
      : { label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "carries its motion on", run: () => act.patch(c.id, { joined: "continue" }) }]
      // said rather than hidden: an imported workflow with no first-frame or previous-clip input cannot extend
      : c.kind === "video" && recipe && index > 0 ? [{ label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "this model cannot extend a clip", disabled: true }] : []),
    ...(act.openJoin && index > 0 ? [{ label: `How it meets clip ${index}`, icon: <Link2 size={14} />, note: "the join before it", run: () => act.openJoin!(c.id) }] : []),
    ...(act.openJoin && next ? [{ label: `How it meets clip ${index + 2}`, icon: <Link2 size={14} />, note: "the join after it", run: () => act.openJoin!(next.id) }] : []),
  ];
  return groups(
    // open, and the most used: its video, a new take, the takes around the one that plays
    [
      ...(video ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer, with Trim", run: () => act.open(video) }] : []),
      ...(c.kind === "video" && recipe ? [{ label: c.take ? "Render a new take" : "Render this clip", key: "Ctrl+Enter", icon: <Wand2 size={14} />, disabled: Boolean(c.job) || act.pending.render, note: c.job ? "it is in the queue" : act.pending.render ? "queueing…" : undefined, run: () => act.render(c) }] : []),
      // two rows folded only to keep the menu short (the conventions' exception): a clip's menu is the longest
      ...(c.kind === "video" && c.takes.length > 1 ? fold("Takes", <Images size={14} />, takeSteps(c, act), 2) : []),
    ],
    // what makes something from it
    [
      { label: "Duplicate clip", icon: <Copy size={14} />, disabled: act.pending.duplicate, note: act.pending.duplicate ? "copying…" : "a copy right after it, with its takes", run: () => act.duplicate(c.id) },
      ...loop,
      ...(c.lengthMs > 0 ? [{ label: "At the playhead", icon: <Camera size={14} />, note: onIt, items: [
        { label: "Extend from this frame", icon: <Link2 size={14} />, disabled: !here || act.pending.add, note: onIt ?? (act.pending.add ? "adding…" : "cuts it here; a new clip carries on"), run: () => { const at = act.onClip(c); if (at) act.continueFrom(c, at.localMs); } },
        { label: "Save frame", icon: <Camera size={14} />, disabled: !here || act.pending.frame, note: onIt ?? (act.pending.frame ? "saving…" : "the frame at the playhead, to your library"), run: () => { const at = act.onClip(c); if (!at) return; if (c.take) act.frame(c.take.asset.id, Math.round(at.assetMs)); else if (c.still) act.open(c.still); } },
      ] }] : []),
      ...(c.kind === "video" && c.take ? [{ label: "Slow motion", icon: <Gauge size={14} />, note: "as a new take", items: [
        { label: "×2", icon: <Gauge size={14} />, disabled: act.pending.range, note: act.pending.range ? "busy…" : "the whole clip at half speed, as a new take; sound slowed too", run: () => act.slow(2, c.atMs, c.atMs + c.lengthMs) },
        { label: "×4", icon: <Gauge size={14} />, disabled: act.pending.range, note: act.pending.range ? "busy…" : "a quarter speed", run: () => act.slow(4, c.atMs, c.atMs + c.lengthMs) },
      ] }] : []),
      // a video brought in (a meme, a dance): what it plays, made again with a picture moving like it, window by window
      ...(video && c.kind === "video" && !c.recipe && act.toSource ? [{ label: "Motion transfer in windows…", icon: <Film size={14} />, note: "the source lane: what it plays, made into clips", run: () => act.toSource!(c) }] : []),
    ],
    // its tools
    [
      ...(c.take ? [splitHere(c, act)] : []),
      { label: "Set range to this clip", icon: <Scissors size={14} />, disabled: c.lengthMs <= 0, note: c.lengthMs > 0 ? "In at its start, Out at its end" : "nothing plays yet", run: () => act.setRange({ inMs: c.atMs, outMs: c.atMs + c.lengthMs }) },
      // a still has no sound of its own to mute
      ...(c.kind === "video" ? [c.sound === "muted"
        ? { label: "Unmute", icon: <Volume2 size={14} />, run: () => act.patch(c.id, { sound: "own" }) }
        : { label: "Mute", icon: <VolumeX size={14} />, run: () => act.patch(c.id, { sound: "muted" }) }] : []),
      ...fold("Joins", <Link2 size={14} />, joins),
    ],
    // its place on the timeline: the same as dragging it along the track, from the keyboard too
    [
      ...(index > 0 ? [{ label: "Move earlier", key: "Alt+←", icon: <ArrowLeft size={14} />, run: () => act.move(c.id, -1) }] : []),
      ...(index >= 0 && index < act.clips.length - 1 ? [{ label: "Move later", key: "Alt+→", icon: <ArrowRight size={14} />, run: () => act.move(c.id, 1) }] : []),
    ],
    [act.picked.has(c.id) && act.picked.size > 1
      ? { label: `Remove the ${act.picked.size} picked clips`, key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings them all back", run: () => act.removeMany([...act.picked]) }
      : { label: "Remove clip", key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings it back", run: () => act.remove(c.id) }],
  );
};

/** What the menu on a clip's audio strip reaches. */
export interface SoundMenuActions {
  patch(clip: string, patch: ClipPatch): void;
  /** The audio picker, for this clip. */
  pick(c: Clip): void;
  /** The clip selected, its panel open. */
  select(clip: string): void;
}

/**
 * Right-click on a clip's audio strip: what the clip panel's sound section does, in place. What it plays is a choice of
 * three, ticked (its own audio only where it has one); then another file, the panel, and the file taken off last.
 */
export const soundMenuItems = (c: Clip, act: SoundMenuActions): MenuItem[] => {
  const hasOwn = c.kind === "video" && Boolean(c.take?.asset.hasSound);
  return groups(
    [
      ...(hasOwn ? [{ label: "Own audio", icon: <Volume2 size={14} />, checked: c.sound === "own", run: () => act.patch(c.id, { sound: "own" }) }] : []),
      { label: "Mute", icon: <VolumeX size={14} />, checked: c.sound === "muted", run: () => act.patch(c.id, { sound: "muted" }) },
      ...(c.soundAsset ? [{ label: "Use the audio file", icon: <Music size={14} />, note: c.soundAsset.name || undefined, checked: c.sound === "file", run: () => act.patch(c.id, { sound: "file" }) }] : []),
    ],
    [
      { label: c.soundAsset ? "Choose another audio file…" : "Choose an audio file…", icon: <Music size={14} />, run: () => act.pick(c) },
      { label: "Volume and sound settings", icon: <SlidersHorizontal size={14} />, note: `${c.volume} % · in the clip panel`, run: () => act.select(c.id) },
    ],
    c.soundAsset && [{ label: "Remove the audio file", icon: <Trash2 size={14} />, danger: true, run: () => act.patch(c.id, { soundAsset: null, sound: hasOwn ? "own" : "muted" }) }],
  );
};

/** What the menu on the music strip reaches. */
export interface MusicMenuActions {
  /** The music picker. */
  pick(): void;
  /** The music panel. */
  open(): void;
  edit(patch: TimelinePatch): void;
}

/** Right-click on the music strip: what the music panel does, in place; Remove last. */
export const musicMenuItems = (m: Timeline["music"] | undefined, act: MusicMenuActions): MenuItem[] => groups(
  [
    ...(m ? [{ label: "Music settings", icon: <SlidersHorizontal size={14} />, note: `${m.volume} % · fades ${(m.fadeInMs / 1000).toFixed(1)} s / ${(m.fadeOutMs / 1000).toFixed(1)} s`, run: () => act.open() }] : []),
    { label: m ? "Change the music…" : "Choose music…", icon: <Music size={14} />, run: () => act.pick() },
  ],
  m && [{ label: "Duck under speech", icon: <Volume2 size={14} />, checked: m.duck, note: "quieter while people talk", run: () => act.edit({ music: { duck: !m.duck } }) }],
  m && [{ label: "Remove music", icon: <Trash2 size={14} />, danger: true, run: () => act.edit({ music: { asset: null } }) }],
);

/** What a library item's menu in the timeline's media reaches. */
export interface PlaceActions {
  /** The clip selected, if any: its places come first; else the last clip's. */
  current: Clip | null;
  clips: Clip[];
  recipes: RecipeInfo[];
  /** The timeline has music already. */
  music: boolean;
  inputsOf(c: Clip): Record<string, unknown>;
  editInputs(c: Clip, next: Record<string, unknown>): void;
  /** A clip selected, its panel open. */
  select(clip: string): void;
  patch(clip: string, patch: ClipPatch): void;
  edit(patch: TimelinePatch): void;
  /** The music panel. */
  openMusic(): void;
  add(v: { asset: string; after?: string | null }): void;
}

/**
 * Where a library item can go from the timeline's media library, first in its right-click menu: into the
 * selected clip's places (the last clip when none is selected, and said so), and onto the timeline. Each
 * mirrors a drop: the same place, the same effect.
 */
export const placeItems = (a: Asset, act: PlaceActions): MenuItem[] => {
  if (a.inBin) return [];
  const { current, clips } = act;
  const target = current ?? clips.at(-1) ?? null;
  const n = target ? clips.findIndex((c) => c.id === target.id) + 1 : 0;
  const recipe = target?.recipe ? act.recipes.find((r) => r.id === target.recipe) : undefined;
  const values = target ? act.inputsOf(target) : {};
  const put = (input: string, value: unknown) => {
    if (!target) return;
    act.editInputs(target, { ...act.inputsOf(target), [input]: value });
    act.select(target.id);
  };
  const groups: MenuItem[][] = [];
  if (target && recipe) {
    if (a.kind === "image") {
      const pins = pinInputs(recipe);
      const pin = (where: "start" | "mid" | "end", label: string): MenuItem[] => {
        const input = pins[where];
        return input ? [{ label, icon: <ImageIcon size={14} />, note: values[input] ? "replaces the one there" : undefined, run: () => put(input, a.id) }] : [];
      };
      groups.push([...pin("start", "First frame"), ...pin("mid", "Keyframe"), ...pin("end", "Last frame")]);
    }
    const refs = recipe.inputs.filter((i): i is Extract<InputSpec, { type: "references" }> => i.type === "references" && (a.kind === "video" ? i.media === "video" : a.kind === "image" && i.media !== "video"));
    groups.push(refs.map((r): MenuItem => {
      const list = (values[r.id] as ReferenceValue[] | undefined) ?? [];
      const has = list.some((x) => x.asset === a.id);
      return {
        label: a.kind === "video" ? "Reference video" : "Reference image", icon: <Images size={14} />,
        note: has ? "already there" : `${list.length} of ${r.max}`, disabled: has || list.length >= r.max,
        run: () => put(r.id, [...list, { asset: a.id, role: r.roles[0]! }]),
      };
    }));
    const voice = recipe.inputs.find((i) => i.type === "audio" && i.role === "voice");
    if (voice && (a.kind === "audio" || (a.kind === "video" && a.hasSound))) {
      groups.push([{ label: "Voice sample", icon: <Mic size={14} />, note: a.kind === "video" ? "its sound" : values[voice.id] ? "replaces the one there" : undefined, run: () => put(voice.id, a.id) }]);
    }
  }
  if (target && a.kind === "audio") groups.push([{ label: "Clip audio", icon: <Volume2 size={14} />, note: "replaces its sound", run: () => act.patch(target.id, { soundAsset: a.id }) }]);
  const slots = groups.filter((g) => g.length).flatMap((g, i) => (i ? ["—" as const, ...g] : g));
  const out: MenuItem[] = [];
  if (slots.length) out.push({ label: `Use in clip ${n}`, note: current ? undefined : "the last clip", icon: <Film size={14} />, items: slots });
  if (a.kind === "audio") {
    out.push({ label: "Music under the whole video", icon: <Music size={14} />, note: act.music ? "replaces the music" : undefined, run: () => { act.edit({ music: { asset: a.id } }); act.openMusic(); } });
  } else {
    const at = current ? clips.findIndex((c) => c.id === current.id) : -1;
    out.push({
      label: "Place on the timeline", icon: <ListEnd size={14} />, items: [
        { label: "At the end", note: a.kind === "image" ? "as a still" : undefined, icon: <ListEnd size={14} />, run: () => act.add({ asset: a.id }) },
        ...(current ? [
          { label: `Before clip ${at + 1}`, icon: <ArrowLeftToLine size={14} />, run: () => act.add({ asset: a.id, after: at > 0 ? clips[at - 1]!.id : null }) },
          { label: `After clip ${at + 1}`, icon: <ArrowRightToLine size={14} />, run: () => act.add({ asset: a.id, after: current.id }) },
        ] : []),
      ],
    });
  }
  return out.length ? [...out, "—"] : [];
};

/** What a pinned frame's menu reaches: Mirror, and the pin's own actions where it is shown (Open, Change, Remove), each as its button or drop does. */
export interface PinMenuActions {
  mirror(on: boolean): void;
  /** The viewer, on the picture. */
  open?(): void;
  /** Another picture, from the library. */
  change?(): void;
  remove(): void;
}

/** The tooltip of a mirrored frame's mark. */
export const MIRRORED_TIP = "Mirrored at render time; the library picture is unchanged. Right-click to turn it off.";

/** The right-click menu of a pinned frame (the Inspector's row, the frame on the track): Mirror first, then what the pin does. */
export const pinMenuItems = (pin: PinMirror, act: PinMenuActions): MenuItem[] => groups(
  [{ label: "Mirror ↔", checked: pin.on, disabled: Boolean(pin.why), note: pin.why ?? "at render time", run: () => act.mirror(!pin.on) }],
  [
    ...(act.open ? [{ label: "Open", icon: <Eye size={14} />, run: act.open }] : []),
    ...(act.change ? [{ label: "Change…", icon: <ImageIcon size={14} />, run: act.change }] : []),
  ],
  [{ label: `Remove ${PIN_WORDS[pin.where]}`, icon: <X size={14} />, danger: true, run: act.remove }],
);
