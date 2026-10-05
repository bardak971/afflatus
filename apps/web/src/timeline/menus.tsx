import { Camera, Copy, Eye, Gauge, Link2, Music, Repeat, Scissors, SlidersHorizontal, Split, Trash2, Volume2, VolumeX, Wand2 } from "lucide-react";
import type { Asset, Clip, ClipPatch, RecipeInfo, Timeline, TimelinePatch } from "../api";
import type { MenuItem } from "../ContextMenu";
import { pinInputs } from "./model";
import type { TimeRange } from "./Track";

/** Where the playhead stands on a clip, as the player says it. */
export type Place = { clip: Clip; localMs: number; assetMs: number };

/** What a clip's menu reaches in the editor: its mutations by name, and what it reads to say each line. */
export interface ClipMenuActions {
  /** The clips as they are on screen, for a clip's number. */
  clips: Clip[];
  recipes: RecipeInfo[];
  inputsOf(c: Clip): Record<string, unknown>;
  /** Where the playhead stands on a clip, when it stands on this one. */
  onClip(c: Clip): Place | null;
  /** Which of the editor's mutations is running: its lines are disabled meanwhile. */
  pending: { render: boolean; split: boolean; duplicate: boolean; loop: boolean; add: boolean; frame: boolean; range: boolean };
  render(c: Clip): void;
  patch(clip: string, patch: ClipPatch): void;
  setRange(range: TimeRange): void;
  split(clip: string, atMs: number): void;
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
  /** The clips picked with Ctrl + click: a menu on one of them removes them all. */
  picked: Set<string>;
  removeMany(clips: string[]): void;
}

/** Split the clip at the playhead: on when the playhead stands inside what it plays. */
const splitHere = (c: Clip, act: ClipMenuActions): MenuItem => {
  const take = c.take!;
  const onIt = act.onClip(c);
  const at = onIt?.assetMs ?? 0;
  const inPlay = Boolean(onIt) && at >= take.startMs + 40 && at <= take.endMs - 40;
  return { label: "Split clip at playhead", icon: <Split size={14} />, disabled: !inPlay || act.pending.split, note: !onIt ? "put the playhead on this clip" : !inPlay ? "move the playhead inside the clip" : "two clips, the second from the playhead on", run: () => act.split(c.id, at) };
};

/** The right-click menu of a clip: what the Inspector offers on it, at the pointer. */
export const clipMenuItems = (c: Clip, act: ClipMenuActions): MenuItem[] => {
  const index = act.clips.findIndex((x) => x.id === c.id);
  const recipe = act.recipes.find((r) => r.id === c.recipe);
  const canCarry = Boolean(recipe && index > 0 && recipe.inputs.some((i) => (i.type === "clip" && i.role === "previous") || (i.type === "image" && i.role === "start")));
  const video = c.take?.asset ?? null;
  return [
    ...(c.kind === "video" && recipe ? [{ label: c.take ? "New take" : "Render this clip", key: "Ctrl + Enter", icon: <Wand2 size={14} />, disabled: Boolean(c.job) || act.pending.render, run: () => act.render(c) }] : []),
    ...(canCarry ? [c.joined === "continue"
      ? { label: "Make it a cut", icon: <Scissors size={14} />, note: `from clip ${index}`, run: () => act.patch(c.id, { joined: "cut" }) }
      : { label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "carries its motion on", run: () => act.patch(c.id, { joined: "continue" }) }]
      // said rather than hidden: an imported workflow with no first-frame or previous-clip input cannot extend
      : c.kind === "video" && recipe && index > 0 ? [{ label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "this model cannot extend a clip", disabled: true, run: () => {} }] : []),
    "—" as const,
    { label: "Set range to this clip", key: "I  O", icon: <Scissors size={14} />, disabled: c.lengthMs <= 0, note: c.lengthMs > 0 ? "In at its start, Out at its end" : "nothing plays yet", run: () => act.setRange({ inMs: c.atMs, outMs: c.atMs + c.lengthMs }) },
    ...(c.take ? [splitHere(c, act)] : []),
    { label: "Duplicate clip", icon: <Copy size={14} />, disabled: act.pending.duplicate, note: "a copy right after it, with its takes", run: () => act.duplicate(c.id) },
    // a clip that plays round: its last frame pinned to its first (the model has to take a last frame)
    ...(c.kind === "video" && recipe && pinInputs(recipe).end ? (() => {
      const pins = pinInputs(recipe);
      const stored = act.inputsOf(c);
      const flows = index > 0 && c.joined === "continue";
      const opens = !flows && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
      const ends = typeof stored[pins.end!] === "string" ? (stored[pins.end!] as string) : null;
      const loops = Boolean(ends && ends === opens);
      return [{
        label: "Make it loop", icon: <Repeat size={14} />, disabled: loops || (!opens && !c.take) || act.pending.loop,
        note: loops ? "it loops already: its last frame is its first" : opens ? "its last frame becomes its first frame, so it plays round and round" : c.take ? "its last frame becomes the first frame of its take, so it plays round and round; from the next take" : "give it a first frame, or render it once",
        run: () => act.loop(c),
      }];
    })() : []),
    ...(c.lengthMs > 0 ? [
      { label: "Extend from this frame", icon: <Link2 size={14} />, disabled: !act.onClip(c) || act.pending.add, note: act.onClip(c) ? "cuts it here; a new clip carries on" : "put the playhead on this clip", run: () => { const here = act.onClip(c); if (here) act.continueFrom(c, here.localMs); } },
      { label: "Save frame", icon: <Camera size={14} />, disabled: !act.onClip(c) || act.pending.frame, note: act.onClip(c) ? "the frame at the playhead, to your library" : "put the playhead on this clip", run: () => { const here = act.onClip(c); if (!here) return; if (c.take) act.frame(c.take.asset.id, Math.round(here.assetMs)); else if (c.still) act.open(c.still); } },
    ] : []),
    ...(c.kind === "video" && c.take ? [
      { label: "Slow motion ×2", icon: <Gauge size={14} />, disabled: act.pending.range, note: "the whole clip at half speed, as a new take; sound slowed too", run: () => act.slow(2, c.atMs, c.atMs + c.lengthMs) },
      { label: "Slow motion ×4", icon: <Gauge size={14} />, disabled: act.pending.range, note: "a quarter speed", run: () => act.slow(4, c.atMs, c.atMs + c.lengthMs) },
    ] : []),
    ...(video ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer, with Trim", run: () => act.open(video) }] : []),
    // a still has no sound of its own to mute
    ...(c.kind === "video" ? ["—" as const, c.sound === "muted"
      ? { label: "Unmute", icon: <Volume2 size={14} />, run: () => act.patch(c.id, { sound: "own" }) }
      : { label: "Mute", icon: <VolumeX size={14} />, run: () => act.patch(c.id, { sound: "muted" }) }] : []),
    "—" as const,
    act.picked.has(c.id) && act.picked.size > 1
      ? { label: `Remove the ${act.picked.size} picked clips`, key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings them back one by one", run: () => act.removeMany([...act.picked]) }
      : { label: "Remove clip", key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings it back", run: () => act.remove(c.id) },
  ];
};

/** What the menu on a clip's audio strip reaches. */
export interface SoundMenuActions {
  patch(clip: string, patch: ClipPatch): void;
  /** The audio picker, for this clip. */
  pick(c: Clip): void;
  /** The clip selected, its panel open. */
  select(clip: string): void;
}

/** Right-click on a clip's audio strip: what the clip panel's sound section does, in place. */
export const soundMenuItems = (c: Clip, act: SoundMenuActions): MenuItem[] => {
  const hasOwn = c.kind === "video" && Boolean(c.take?.asset.hasSound);
  return [
    { label: "Own audio", icon: <Volume2 size={14} />, note: hasOwn ? undefined : c.kind === "still" ? "a still has none" : "this video has no sound", disabled: !hasOwn || c.sound === "own", run: () => act.patch(c.id, { sound: "own" }) },
    { label: "Mute", icon: <VolumeX size={14} />, disabled: c.sound === "muted", run: () => act.patch(c.id, { sound: "muted" }) },
    ...(c.soundAsset ? [{ label: "Use the audio file", icon: <Music size={14} />, note: c.soundAsset.name || undefined, disabled: c.sound === "file", run: () => act.patch(c.id, { sound: "file" }) }] : []),
    { label: c.soundAsset ? "Choose another audio file…" : "Choose an audio file…", icon: <Music size={14} />, run: () => act.pick(c) },
    ...(c.soundAsset ? [{ label: "Remove the audio file", icon: <Trash2 size={14} />, danger: true, run: () => act.patch(c.id, { soundAsset: null, sound: hasOwn ? "own" : "muted" }) }] : []),
    "—",
    { label: "Volume and sound settings", icon: <SlidersHorizontal size={14} />, note: `${c.volume} % · in the clip panel`, run: () => act.select(c.id) },
  ];
};

/** What the menu on the music strip reaches. */
export interface MusicMenuActions {
  /** The music picker. */
  pick(): void;
  /** The music panel. */
  open(): void;
  edit(patch: TimelinePatch): void;
}

/** Right-click on the music strip: what the music panel does, in place. */
export const musicMenuItems = (m: Timeline["music"] | undefined, act: MusicMenuActions): MenuItem[] => [
  { label: m ? "Change the music…" : "Choose music…", icon: <Music size={14} />, run: () => act.pick() },
  ...(m
    ? [
        { label: "Music settings", icon: <SlidersHorizontal size={14} />, note: `${m.volume} % · fades ${(m.fadeInMs / 1000).toFixed(1)} s / ${(m.fadeOutMs / 1000).toFixed(1)} s`, run: () => act.open() },
        { label: m.duck ? "Stop ducking under speech" : "Duck under speech", icon: <Volume2 size={14} />, note: "quieter while people talk", run: () => act.edit({ music: { duck: !m.duck } }) },
        "—" as const,
        { label: "Remove music", icon: <Trash2 size={14} />, danger: true, run: () => act.edit({ music: { asset: null } }) },
      ]
    : []),
];
