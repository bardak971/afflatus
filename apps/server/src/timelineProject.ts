import { plural, slug, TRANSITIONS, transitionSpan } from "@afflatus/core";
import { extOf } from "./media";
import { partWindow } from "./timelineExport";
import { joinFade, transitionOfRow, visible, type Laid } from "./timelineModel";

/**
 * A timeline for a video editor (DaVinci Resolve, Premiere Pro, Kdenlive): every clip's own file, where it plays on the
 * timeline and from where in its file, what is heard, and the music as the player plays it, written as a project file
 * the editor rebuilds the timeline from. The files are copied as they are, whole: the editor can move a cut either way.
 * A seamless chain stays seamless as plain cuts: its takes were decoded as one piece when they were rendered.
 * Pure, for the tests: the zip around it is the route's (timelines-api.ts).
 */

export interface ProjectItem {
  kind: "video" | "still";
  /** Its file in the zip (`media/…`), and the storage key it is copied from. */
  file: string;
  key: string;
  /** Where it plays on the timeline and for how long. */
  atMs: number;
  lengthMs: number;
  /** Where in its file it starts (0 for a picture). */
  inMs: number;
  /** How long its file is: the room the editor has around the cut. Null for a picture. */
  fileMs: number | null;
  /** Its file's own size (a finished take is larger than a draft): what the editor is told the file is. */
  width: number | null;
  height: number | null;
  /** What is heard: its own sound, nothing, or a sound file from the clip's start. */
  sound: "own" | "muted" | "file";
  hasSound: boolean;
  /** 0 to 1. */
  volume: number;
  soundFile?: { file: string; key: string; fileMs: number | null };
  /** The video export dissolves into it over the clip before for this long; the editor gets a marker there. */
  dissolveMs?: number;
  /** The cut into it has a transition (a dissolve, a dip, a flash…), centred on the cut: the editor gets a marker there. */
  transition?: { label: string; ms: number };
  /** Its number on the timeline ("clip 3"). */
  clip: number;
}

export interface ProjectPlan {
  name: string;
  width: number;
  height: number;
  fps: number;
  totalMs: number;
  items: ProjectItem[];
  /** The music, as heard under the video, in `media/music.wav` from the start. */
  music: boolean;
}

/** The project of the clips that play (`shown`, within `win`), as the video export lays them out. */
export function projectPlan(name: string, layout: { shown: Laid[]; win: { a: number; b: number } | null; frame: { width: number; height: number }; fps: number; totalMs: number; music: boolean }): ProjectPlan {
  const files = new Map<string, string>();
  // one file per item of the library, however often it plays: a take used twice is copied once
  const fileFor = (asset: { id: string; mime: string }, label: string) => {
    let f = files.get(asset.id);
    if (!f) files.set(asset.id, (f = `media/${String(files.size + 1).padStart(2, "0")}-${slug(label, 40) || "clip"}.${extOf(asset.mime)}`));
    return f;
  };
  const items: ProjectItem[] = [];
  const at0 = layout.win?.a ?? 0;
  for (const l of layout.shown) {
    const { from, to } = partWindow(l, layout.win);
    const p = l.p;
    const clip = l.index + 1;
    const before = items.at(-1);
    const sound = {
      sound: p.clip.sound, volume: p.clip.volume / 100,
      ...(p.clip.sound === "file" && p.sound ? { soundFile: { file: fileFor(p.sound, `clip-${clip}-sound`), key: p.sound.file_key, fileMs: p.sound.duration_ms } } : {}),
    };
    const atMs = l.atMs + from - at0;
    // a cut's transition, as the video export plays it (core transitions.ts): said by a marker, the editor's own to add
    const t = transitionOfRow(p.clip);
    const span = before && from === 0 ? transitionSpan(t, p.clip.joined, before.lengthMs, to - from) : 0;
    const marked = t && span ? { transition: { label: TRANSITIONS[t.kind].label, ms: span } } : {};
    if (p.clip.kind === "still") {
      if (!p.still) continue;
      items.push({ kind: "still", file: fileFor(p.still, `clip-${clip}-still`), key: p.still.file_key, atMs, lengthMs: to - from, inMs: 0, fileMs: null, width: p.still.width, height: p.still.height, hasSound: false, clip, ...sound, ...marked });
      continue;
    }
    const x = p.active!;
    // where the video export fades this clip in over the one before: the same fade the player shows (joinFade)
    const fade = before?.kind === "video" && from === 0 ? joinFade(x, p.clip.joined === "continue") : null;
    items.push({
      kind: "video", file: fileFor(x.asset, `clip-${clip}-take`), key: x.asset.file_key, atMs, lengthMs: to - from,
      inMs: visible(x).start + from, fileMs: x.asset.duration_ms, width: x.asset.width, height: x.asset.height, hasSound: Boolean(x.asset.has_sound), clip, ...sound,
      ...(fade ? { dissolveMs: fade.ms } : {}),
      ...marked,
    });
  }
  return { name, width: layout.frame.width, height: layout.frame.height, fps: layout.fps, totalMs: layout.totalMs, items, music: layout.music };
}

/**
 * How many frames a file holds. Rounded, not floored: the length the library keeps is a few ms under the file's own (5850
 * against 5854.2 ms, 281 frames at 48 a second), and flooring lost its last frame.
 */
export const fileFrames = (fileMs: number, fps: number) => Math.round((fileMs * fps) / 1000);

/**
 * A clip in frames, for both writers: where it starts and ends on the timeline (each end rounded on its own, so the clips
 * stay end to end), and where in its file. The in point and the length rounded apart could end a frame past the file
 * (a take of 281 frames played to 282). The last clip of a track then ends a frame sooner, its in point kept: a seamless
 * join starts exactly where it should. A clip with another after it cannot end sooner without a black frame: its in
 * point steps back instead.
 */
export function framesOf(fps: number, at: { atMs: number; lengthMs: number; inMs: number; fileMs: number | null }, tail = false) {
  const fr = (ms: number) => Math.round((ms * fps) / 1000);
  const start = fr(at.atMs);
  let end = fr(at.atMs + at.lengthMs);
  const last = at.fileMs !== null ? fileFrames(at.fileMs, fps) : Infinity;
  let inF = fr(at.inMs);
  const over = inF + (end - start) - last;
  if (over > 0) {
    if (tail) end -= over;
    else inF = Math.max(0, inF - over);
  }
  return { start, end, in: inF, out: Math.min(inF + end - start, last) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The project as Final Cut Pro 7 XML (xmeml), which DaVinci Resolve and Premiere Pro import: one video track, the clips'
 * own sound on the first audio track, their sound files on the second, the music on the third; a marker where the video
 * export dissolves. The files are named by their path beside the project file.
 */
export function fcp7Xml(plan: ProjectPlan): string {
  const fr = (ms: number) => Math.round((ms * plan.fps) / 1000);
  const rate = `<rate><timebase>${plan.fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const seen = new Set<string>();
  let n = 0;
  // a file is described once, where it is first used; after that it is named by its id
  const file = (path: string, fileMs: number | null, video: boolean, audio: boolean, size: { width: number | null; height: number | null } = { width: null, height: null }) => {
    const id = `file-${path}`;
    if (seen.has(id)) return `<file id="${esc(id)}"/>`;
    seen.add(id);
    const name = path.split("/").pop()!;
    return `<file id="${esc(id)}"><name>${esc(name)}</name><pathurl>${esc(path)}</pathurl>${rate}${fileMs !== null ? `<duration>${fileFrames(fileMs, plan.fps)}</duration>` : ""}<media>${video ? `<video><samplecharacteristics><width>${size.width ?? plan.width}</width><height>${size.height ?? plan.height}</height></samplecharacteristics></video>` : ""}${audio ? "<audio><channelcount>2</channelcount></audio>" : ""}</media></file>`;
  };
  const level = (v: number) => (v === 1 ? "" : `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${v.toFixed(3)}</value></parameter></effect></filter>`);
  // `tail`: the last clip of its track (see framesOf)
  const item = (name: string, at: { atMs: number; lengthMs: number; inMs: number; fileMs: number | null }, tail: boolean, fileXml: string, extra = "") => {
    const f = framesOf(plan.fps, at, tail);
    return `<clipitem id="clipitem-${++n}"><name>${esc(name)}</name>${rate}<start>${f.start}</start><end>${f.end}</end><in>${f.in}</in><out>${f.out}</out>${fileXml}${extra}</clipitem>`;
  };
  const video = plan.items.map((i, k, all) => item(`clip ${i.clip}`, i, k === all.length - 1, file(i.file, i.fileMs, true, i.kind === "video" && i.hasSound, i)));
  const own = plan.items.filter((i) => i.kind === "video" && i.sound === "own" && i.hasSound && i.volume > 0)
    .map((i, k, all) => item(`clip ${i.clip} sound`, i, k === all.length - 1, file(i.file, i.fileMs, true, true, i), `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>${level(i.volume)}`));
  const files = plan.items.filter((i) => i.sound === "file" && i.soundFile && i.volume > 0)
    .map((i, k, all) => item(`clip ${i.clip} sound file`, { atMs: i.atMs, lengthMs: Math.min(i.lengthMs, i.soundFile!.fileMs ?? i.lengthMs), inMs: 0, fileMs: i.soundFile!.fileMs }, k === all.length - 1, file(i.soundFile!.file, i.soundFile!.fileMs, false, true), level(i.volume)));
  const music = plan.music ? [item("music", { atMs: 0, lengthMs: plan.totalMs, inMs: 0, fileMs: plan.totalMs }, true, file("media/music.wav", plan.totalMs, false, true))] : [];
  const markers = [
    ...plan.items.filter((i) => i.dissolveMs).map((i) => `<marker><name>${esc(`dissolve ${(i.dissolveMs! / 1000).toFixed(2)} s`)}</name><comment>${esc(`Afflatus's video export dissolves clip ${i.clip} in over the clip before here.`)}</comment><in>${fr(i.atMs)}</in><out>-1</out></marker>`),
    ...plan.items.filter((i) => i.transition).map((i) => `<marker><name>${esc(transitionWords(i))}</name><comment>${esc(`Afflatus's video export has this transition into clip ${i.clip}, centred on the cut.`)}</comment><in>${fr(i.atMs)}</in><out>-1</out></marker>`),
  ];
  const track = (items: string[]) => `<track>${items.join("")}</track>`;
  // the sequence ends where its last clip does (a frame sooner when that clip was cut to its file's end)
  const ends = plan.items.at(-1) ? framesOf(plan.fps, plan.items.at(-1)!, true).end : fr(plan.totalMs);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    `<sequence id="sequence-1"><name>${esc(plan.name)}</name><duration>${ends}</duration>${rate}`,
    `<media><video><format><samplecharacteristics>${rate}<width>${plan.width}</width><height>${plan.height}</height></samplecharacteristics></format>${track(video)}</video>`,
    `<audio>${[own, files, music].filter((t) => t.length).map(track).join("")}</audio></media>`,
    ...markers,
    "</sequence>",
    "</xmeml>",
    "",
  ].join("\n");
}

/**
 * The project as OpenTimelineIO (.otio), which Kdenlive and DaVinci Resolve import: the same tracks as the XML, gaps where
 * a track has nothing, the dissolves as markers. Volumes are kept in each clip's metadata (OpenTimelineIO has no level).
 */
export function otioJson(plan: ProjectPlan): string {
  const rt = (frames: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: plan.fps, value: frames });
  const range = (start: number, frames: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start), duration: rt(frames) });
  type At = { atMs: number; lengthMs: number; inMs: number; fileMs: number | null };
  const clip = (name: string, path: string, at: At, tail: boolean, metadata: Record<string, unknown> = {}) => {
    const f = framesOf(plan.fps, at, tail);
    const last = at.fileMs !== null ? fileFrames(at.fileMs, plan.fps) : null;
    return {
      OTIO_SCHEMA: "Clip.1", name, metadata, effects: [], markers: [], source_range: range(f.in, f.out - f.in),
      media_reference: { OTIO_SCHEMA: "ExternalReference.1", name: path.split("/").pop(), metadata: {}, target_url: path, available_range: last !== null ? range(0, last) : null },
    };
  };
  const gap = (frames: number) => ({ OTIO_SCHEMA: "Gap.1", name: "", metadata: {}, effects: [], markers: [], source_range: range(0, frames) });
  // a track's clips in order, with gaps between them where it is silent, placed in frames as the XML places them
  const laidTrack = (name: string, kind: "Video" | "Audio", parts: Array<{ at: At; make: (tail: boolean) => object }>) => {
    const children: object[] = [];
    let at = 0;
    for (const [k, p] of parts.entries()) {
      const tail = k === parts.length - 1;
      const f = framesOf(plan.fps, p.at, tail);
      if (f.start > at) children.push(gap(f.start - at));
      children.push(p.make(tail));
      at = f.start + (f.out - f.in);
    }
    return { OTIO_SCHEMA: "Track.1", name, kind, metadata: {}, effects: [], markers: [], source_range: null, children };
  };
  const markers = [
    ...plan.items.filter((i) => i.dissolveMs).map((i) => ({
      OTIO_SCHEMA: "Marker.2", name: `dissolve ${(i.dissolveMs! / 1000).toFixed(2)} s`, color: "ORANGE", metadata: { afflatus: { clip: i.clip } }, marked_range: range(framesOf(plan.fps, i).start, 0), comment: `Afflatus's video export dissolves clip ${i.clip} in over the clip before here.`,
    })),
    ...plan.items.filter((i) => i.transition).map((i) => ({
      OTIO_SCHEMA: "Marker.2", name: transitionWords(i), color: "PURPLE", metadata: { afflatus: { clip: i.clip } }, marked_range: range(framesOf(plan.fps, i).start, 0), comment: `Afflatus's video export has this transition into clip ${i.clip}, centred on the cut.`,
    })),
  ];
  const soundFileAt = (i: ProjectItem): At => ({ atMs: i.atMs, lengthMs: Math.min(i.lengthMs, i.soundFile!.fileMs ?? i.lengthMs), inMs: 0, fileMs: i.soundFile!.fileMs });
  const musicAt: At = { atMs: 0, lengthMs: plan.totalMs, inMs: 0, fileMs: plan.totalMs };
  const tracks = [
    laidTrack("V1", "Video", plan.items.map((i) => ({ at: i, make: (tail) => clip(`clip ${i.clip}`, i.file, i, tail) }))),
    laidTrack("A1 clip sound", "Audio", plan.items.filter((i) => i.kind === "video" && i.sound === "own" && i.hasSound && i.volume > 0).map((i) => ({ at: i, make: (tail) => clip(`clip ${i.clip} sound`, i.file, i, tail, { afflatus: { volume: i.volume } }) }))),
    laidTrack("A2 sound files", "Audio", plan.items.filter((i) => i.sound === "file" && i.soundFile && i.volume > 0).map((i) => ({ at: soundFileAt(i), make: (tail) => clip(`clip ${i.clip} sound file`, i.soundFile!.file, soundFileAt(i), tail, { afflatus: { volume: i.volume } }) }))),
    ...(plan.music ? [laidTrack("A3 music", "Audio", [{ at: musicAt, make: (tail) => clip("music", "media/music.wav", musicAt, tail) }])] : []),
  ];
  const timeline = {
    OTIO_SCHEMA: "Timeline.1", name: plan.name, metadata: {}, global_start_time: null,
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", metadata: {}, effects: [], markers, source_range: null, children: tracks },
  };
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

/** A transition's marker: its name and length ("Flash 0.25 s"). */
const transitionWords = (i: ProjectItem) => `${i.transition!.label} ${(i.transition!.ms / 1000).toFixed(2)} s`;

/** What is in the zip and how to open it, as the zip's README. */
export function projectReadme(plan: ProjectPlan, version: string): string {
  const s = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;
  const dissolves = plan.items.filter((i) => i.dissolveMs);
  const cuts = plan.items.filter((i) => i.transition);
  return [
    `${plan.name}: a timeline from Afflatus ${version}, for a video editor.`,
    `${plan.width} x ${plan.height}, ${plan.fps} fps, ${s(plan.totalMs)}, ${plural(plan.items.length, "clip")}.`,
    "",
    "Unpack the whole zip, then import the project file from where it lies (the clips are in media/ beside it):",
    "- DaVinci Resolve: File > Import > Timeline, and pick project.xml (or project.otio).",
    "- Premiere Pro: File > Import, and pick project.xml.",
    "- Kdenlive: File > Import > OpenTimelineIO, and pick project.otio.",
    "If the editor shows the clips as offline, point it at the media/ folder (Resolve: Relink Clips; Premiere: Link Media).",
    "",
    "Tracks: V1 the clips, A1 their own sound, A2 the sound files set on clips, A3 the music (as heard in Afflatus, ducked under voices).",
    "Every clip's file is whole: its in and out points are where Afflatus plays it, and the frames around are there to move a cut.",
    "",
    "Not in it: colour matching between clips, frame interpolation and upscaling (options of Afflatus's video export), and the",
    "short dissolves the video export makes at some joins; each of those has a marker, to add one where you want it.",
    ...(dissolves.length ? ["", "Dissolves in Afflatus's export:", ...dissolves.map((i) => `- ${s(i.atMs)}, clip ${i.clip}: ${(i.dissolveMs! / 1000).toFixed(2)} s`)] : []),
    ...(cuts.length ? ["", "Transitions in Afflatus's export (centred on the cut, each a marker):", ...cuts.map((i) => `- ${s(i.atMs)}, clip ${i.clip}: ${transitionWords(i)}`)] : []),
    "",
  ].join("\n");
}
