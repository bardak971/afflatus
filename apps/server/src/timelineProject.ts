import { plural, slug } from "@afflatus/core";
import { extOf } from "./media";
import { partWindow } from "./timelineExport";
import { joinFade, visible, type Laid } from "./timelineModel";

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
  /** What is heard: its own sound, nothing, or a sound file from the clip's start. */
  sound: "own" | "muted" | "file";
  hasSound: boolean;
  /** 0 to 1. */
  volume: number;
  soundFile?: { file: string; key: string; fileMs: number | null };
  /** The video export dissolves into it over the clip before for this long; the editor gets a marker there. */
  dissolveMs?: number;
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
    if (p.clip.kind === "still") {
      if (!p.still) continue;
      items.push({ kind: "still", file: fileFor(p.still, `clip-${clip}-still`), key: p.still.file_key, atMs, lengthMs: to - from, inMs: 0, fileMs: null, hasSound: false, clip, ...sound });
      continue;
    }
    const x = p.active!;
    // where the video export fades this clip in over the one before: the same fade the player shows (joinFade)
    const fade = before?.kind === "video" && from === 0 ? joinFade(x, p.clip.joined === "continue") : null;
    items.push({
      kind: "video", file: fileFor(x.asset, `clip-${clip}-take`), key: x.asset.file_key, atMs, lengthMs: to - from,
      inMs: visible(x).start + from, fileMs: x.asset.duration_ms, hasSound: Boolean(x.asset.has_sound), clip, ...sound,
      ...(fade ? { dissolveMs: fade.ms } : {}),
    });
  }
  return { name, width: layout.frame.width, height: layout.frame.height, fps: layout.fps, totalMs: layout.totalMs, items, music: layout.music };
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
  const file = (path: string, fileMs: number | null, video: boolean, audio: boolean) => {
    const id = `file-${path}`;
    if (seen.has(id)) return `<file id="${esc(id)}"/>`;
    seen.add(id);
    const name = path.split("/").pop()!;
    return `<file id="${esc(id)}"><name>${esc(name)}</name><pathurl>${esc(path)}</pathurl>${rate}${fileMs !== null ? `<duration>${fr(fileMs)}</duration>` : ""}<media>${video ? `<video><samplecharacteristics><width>${plan.width}</width><height>${plan.height}</height></samplecharacteristics></video>` : ""}${audio ? "<audio><channelcount>2</channelcount></audio>" : ""}</media></file>`;
  };
  const level = (v: number) => (v === 1 ? "" : `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${v.toFixed(3)}</value></parameter></effect></filter>`);
  const item = (name: string, startMs: number, lengthMs: number, inMs: number, fileXml: string, extra = "") =>
    `<clipitem id="clipitem-${++n}"><name>${esc(name)}</name>${rate}<start>${fr(startMs)}</start><end>${fr(startMs + lengthMs)}</end><in>${fr(inMs)}</in><out>${fr(inMs + lengthMs)}</out>${fileXml}${extra}</clipitem>`;
  const video = plan.items.map((i) => item(`clip ${i.clip}`, i.atMs, i.lengthMs, i.inMs, file(i.file, i.fileMs, true, i.kind === "video" && i.hasSound)));
  const own = plan.items.filter((i) => i.kind === "video" && i.sound === "own" && i.hasSound && i.volume > 0)
    .map((i) => item(`clip ${i.clip} sound`, i.atMs, i.lengthMs, i.inMs, file(i.file, i.fileMs, true, true), `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>${level(i.volume)}`));
  const files = plan.items.filter((i) => i.sound === "file" && i.soundFile && i.volume > 0)
    .map((i) => item(`clip ${i.clip} sound file`, i.atMs, Math.min(i.lengthMs, i.soundFile!.fileMs ?? i.lengthMs), 0, file(i.soundFile!.file, i.soundFile!.fileMs, false, true), level(i.volume)));
  const music = plan.music ? [item("music", 0, plan.totalMs, 0, file("media/music.wav", plan.totalMs, false, true))] : [];
  const markers = plan.items.filter((i) => i.dissolveMs).map((i) => `<marker><name>${esc(`dissolve ${(i.dissolveMs! / 1000).toFixed(2)} s`)}</name><comment>${esc(`Afflatus's video export dissolves clip ${i.clip} in over the clip before here.`)}</comment><in>${fr(i.atMs)}</in><out>-1</out></marker>`);
  const track = (items: string[]) => `<track>${items.join("")}</track>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    `<sequence id="sequence-1"><name>${esc(plan.name)}</name><duration>${fr(plan.totalMs)}</duration>${rate}`,
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
  const rt = (ms: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: plan.fps, value: Math.round((ms * plan.fps) / 1000) });
  const range = (startMs: number, lengthMs: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(startMs), duration: rt(lengthMs) });
  const clip = (name: string, path: string, inMs: number, lengthMs: number, fileMs: number | null, metadata: Record<string, unknown> = {}) => ({
    OTIO_SCHEMA: "Clip.1", name, metadata, effects: [], markers: [], source_range: range(inMs, lengthMs),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", name: path.split("/").pop(), metadata: {}, target_url: path, available_range: fileMs !== null ? range(0, fileMs) : null },
  });
  const gap = (lengthMs: number) => ({ OTIO_SCHEMA: "Gap.1", name: "", metadata: {}, effects: [], markers: [], source_range: range(0, lengthMs) });
  // a track's clips in order, with gaps between them where it is silent
  const laidTrack = (name: string, kind: "Video" | "Audio", parts: Array<{ atMs: number; lengthMs: number; make: () => object }>) => {
    const children: object[] = [];
    let at = 0;
    for (const p of parts) {
      if (p.atMs > at) children.push(gap(p.atMs - at));
      children.push(p.make());
      at = p.atMs + p.lengthMs;
    }
    return { OTIO_SCHEMA: "Track.1", name, kind, metadata: {}, effects: [], markers: [], source_range: null, children };
  };
  const markers = plan.items.filter((i) => i.dissolveMs).map((i) => ({
    OTIO_SCHEMA: "Marker.2", name: `dissolve ${(i.dissolveMs! / 1000).toFixed(2)} s`, color: "ORANGE", metadata: { afflatus: { clip: i.clip } }, marked_range: range(i.atMs, 0), comment: `Afflatus's video export dissolves clip ${i.clip} in over the clip before here.`,
  }));
  const tracks = [
    laidTrack("V1", "Video", plan.items.map((i) => ({ atMs: i.atMs, lengthMs: i.lengthMs, make: () => clip(`clip ${i.clip}`, i.file, i.inMs, i.lengthMs, i.fileMs) }))),
    laidTrack("A1 clip sound", "Audio", plan.items.filter((i) => i.kind === "video" && i.sound === "own" && i.hasSound && i.volume > 0).map((i) => ({ atMs: i.atMs, lengthMs: i.lengthMs, make: () => clip(`clip ${i.clip} sound`, i.file, i.inMs, i.lengthMs, i.fileMs, { afflatus: { volume: i.volume } }) }))),
    laidTrack("A2 sound files", "Audio", plan.items.filter((i) => i.sound === "file" && i.soundFile && i.volume > 0).map((i) => {
      const lengthMs = Math.min(i.lengthMs, i.soundFile!.fileMs ?? i.lengthMs);
      return { atMs: i.atMs, lengthMs, make: () => clip(`clip ${i.clip} sound file`, i.soundFile!.file, 0, lengthMs, i.soundFile!.fileMs, { afflatus: { volume: i.volume } }) };
    })),
    ...(plan.music ? [laidTrack("A3 music", "Audio", [{ atMs: 0, lengthMs: plan.totalMs, make: () => clip("music", "media/music.wav", 0, plan.totalMs, plan.totalMs) }])] : []),
  ];
  const timeline = {
    OTIO_SCHEMA: "Timeline.1", name: plan.name, metadata: {}, global_start_time: null,
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", metadata: {}, effects: [], markers, source_range: null, children: tracks },
  };
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

/** What is in the zip and how to open it, as the zip's README. */
export function projectReadme(plan: ProjectPlan, version: string): string {
  const s = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;
  const dissolves = plan.items.filter((i) => i.dissolveMs);
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
    "",
  ].join("\n");
}
