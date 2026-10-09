import { ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, Camera, ChevronLeft, ChevronRight, Copy, Eye, Film, Gauge, Image as ImageIcon, Images, Link2, ListEnd, Mic, Music, Repeat, Scissors, SlidersHorizontal, Split, Trash2, Volume2, VolumeX, Wand2 } from "lucide-react";
import type { InputSpec, ReferenceValue } from "@afflatus/core";
import type { Asset, Clip, ClipPatch, RecipeInfo, Timeline, TimelinePatch } from "../api";
import type { MenuItem } from "../ContextMenu";
import { pinInputs, splitPoint } from "./model";
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
}

/** Split the clip at the playhead (S): on when the playhead stands inside what it plays. */
const splitHere = (c: Clip, act: ClipMenuActions): MenuItem => {
  const onIt = act.onClip(c);
  const cut = onIt ? splitPoint(c, onIt.assetMs) : null;
  const at = cut && "at" in cut ? cut.at : null;
  return { label: "Split at the playhead", key: "S", icon: <Split size={14} />, disabled: at === null || act.pending.split, note: !onIt ? "put the playhead on this clip" : at === null ? "move the playhead inside the clip" : "two clips, the second from the playhead on", run: () => at !== null && act.split(c.id, at) };
};

/** The take before or after the one that plays (Alt [ and Alt ]): the clip panel's list of takes, from the keyboard. */
const takeSteps = (c: Clip, act: ClipMenuActions): MenuItem[] => {
  const i = c.takes.findIndex((x) => x.id === c.take?.id);
  return [
    { label: "Previous take", key: "Alt + [", icon: <ChevronLeft size={14} />, disabled: i <= 0, note: i <= 0 ? "the first take plays" : `take ${i} of ${c.takes.length}`, run: () => act.stepTake(c.id, -1) },
    { label: "Next take", key: "Alt + ]", icon: <ChevronRight size={14} />, disabled: i < 0 || i >= c.takes.length - 1, note: i >= c.takes.length - 1 ? "the last take plays" : `take ${i + 2} of ${c.takes.length}`, run: () => act.stepTake(c.id, 1) },
  ];
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
    ...(c.take ? [splitHere(c, act)] : []),
    ...(c.kind === "video" && c.takes.length > 1 ? takeSteps(c, act) : []),
    ...(c.take || c.takes.length > 1 ? ["—" as const] : []),
    { label: "Set range to this clip", icon: <Scissors size={14} />, disabled: c.lengthMs <= 0, note: c.lengthMs > 0 ? "In at its start, Out at its end" : "nothing plays yet", run: () => act.setRange({ inMs: c.atMs, outMs: c.atMs + c.lengthMs }) },
    { label: "Duplicate clip", icon: <Copy size={14} />, disabled: act.pending.duplicate, note: "a copy right after it, with its takes", run: () => act.duplicate(c.id) },
    // the same as dragging it along the track, from the keyboard too
    { label: "Move earlier", key: "Alt + ←", icon: <ArrowLeft size={14} />, disabled: index <= 0, run: () => act.move(c.id, -1) },
    { label: "Move later", key: "Alt + →", icon: <ArrowRight size={14} />, disabled: index >= act.clips.length - 1, run: () => act.move(c.id, 1) },
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
    ...(c.lengthMs > 0 ? [{ label: "At the playhead", icon: <Camera size={14} />, note: act.onClip(c) ? undefined : "put the playhead on this clip", items: [
      { label: "Extend from this frame", icon: <Link2 size={14} />, disabled: !act.onClip(c) || act.pending.add, note: act.onClip(c) ? "cuts it here; a new clip carries on" : "put the playhead on this clip", run: () => { const here = act.onClip(c); if (here) act.continueFrom(c, here.localMs); } },
      { label: "Save frame", icon: <Camera size={14} />, disabled: !act.onClip(c) || act.pending.frame, note: act.onClip(c) ? "the frame at the playhead, to your library" : "put the playhead on this clip", run: () => { const here = act.onClip(c); if (!here) return; if (c.take) act.frame(c.take.asset.id, Math.round(here.assetMs)); else if (c.still) act.open(c.still); } },
    ] }] : []),
    ...(c.kind === "video" && c.take ? [{ label: "Slow motion", icon: <Gauge size={14} />, note: "as a new take", items: [
      { label: "×2", icon: <Gauge size={14} />, disabled: act.pending.range, note: "the whole clip at half speed, as a new take; sound slowed too", run: () => act.slow(2, c.atMs, c.atMs + c.lengthMs) },
      { label: "×4", icon: <Gauge size={14} />, disabled: act.pending.range, note: "a quarter speed", run: () => act.slow(4, c.atMs, c.atMs + c.lengthMs) },
    ] }] : []),
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
