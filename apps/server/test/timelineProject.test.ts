import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import type { TestApp } from "./helpers";
import { timelineSteps, timelineSuite } from "./timelineKit";

/** A timeline for a video editor: the zip of its clips' files, the music as heard, and the project files (timelineProject.ts). */

const s = timelineSuite();
const { call, view, twoClips } = timelineSteps(s);
let t: TestApp;
let tone: Uint8Array;
beforeAll(() => void ({ tone } = s.clips ?? {}));
beforeEach(() => void ({ t } = s));

/** The zip stores its files as they are: a text file is read straight out of it, from its first line to the next file's header. */
const textIn = (zip: Buffer, starts: string) => {
  const at = zip.indexOf(starts);
  if (at < 0) return null;
  const end = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), at);
  return zip.subarray(at, end < 0 ? undefined : end).toString("utf8");
};
const names = (zip: Buffer) => [...zip.toString("latin1").matchAll(/(README\.txt|project\.xml|project\.otio|media\/[\w-]+\.(?:mp4|mov|webm|wav|m4a|mp3|png|jpe?g|webp))/g)].map((m) => m[1]);

describe.skipIf(!ffmpegThere)("a timeline for a video editor", { timeout: FFMPEG_TIMEOUT }, () => {
  const download = async (id: string, query = "") => t.app.inject({ method: "GET", url: `/api/timelines/${id}/project.zip${query}` });

  it("is a zip of every clip's whole file and the project files, each clip placed where it plays and from where in its file", async () => {
    const { id } = await twoClips();
    const v = await view(id);
    const res = await download(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain("Evening for an editor.zip");
    const zip = res.rawPayload;
    expect(new Set(names(zip))).toEqual(new Set(["README.txt", "project.xml", "project.otio", "media/01-clip-1-take.mp4", "media/02-clip-2-take.mp4"]));

    const xml = textIn(zip, "<?xml")!;
    // the second clip carries on from the first: it plays from after the frames they share, 917 ms in (22 frames at 24 a second)
    const ins = [...xml.matchAll(/<clipitem id="clipitem-\d+"><name>clip (\d)<\/name>.*?<start>(\d+)<\/start><end>(\d+)<\/end><in>(\d+)<\/in>/g)].map((m) => ({ clip: Number(m[1]), start: Number(m[2]), end: Number(m[3]), in: Number(m[4]) }));
    expect(ins).toHaveLength(2);
    expect(ins[0]).toMatchObject({ clip: 1, start: 0, in: 0 });
    expect(ins[1]!.start).toBe(ins[0]!.end);
    expect(ins[1]!.in).toBe(Math.round((v.clips[1].take.headMs * 24) / 1000));
    expect(xml).toContain("<width>192</width><height>320</height>");
    // the clips' own sound on the first audio track, from the same files
    expect(xml).toContain("<name>clip 1 sound</name>");
    // where the video export dissolves the continuation in, a marker at the cut (not a transition the files may not allow)
    expect(xml).toMatch(new RegExp(`<marker><name>dissolve 0\\.\\d+ s</name>.*?<in>${ins[1]!.start}</in>`));

    const otio = JSON.parse(textIn(zip, "{\n  \"OTIO_SCHEMA\": \"Timeline.1\"")!);
    expect(otio).toMatchObject({ OTIO_SCHEMA: "Timeline.1", name: "Evening" });
    const [video, audio] = otio.tracks.children;
    expect(video).toMatchObject({ kind: "Video", children: [{ name: "clip 1", media_reference: { target_url: "media/01-clip-1-take.mp4" } }, { name: "clip 2" }] });
    expect(audio.kind).toBe("Audio");
    // each file is whole: the editor has the frames around a cut
    expect(video.children[1].media_reference.available_range.duration.value).toBeGreaterThan(video.children[1].source_range.duration.value);

    expect(textIn(zip, "Evening: a timeline")).toContain("DaVinci Resolve");
  });

  it("takes the music as it is heard, and only the range when one is asked (without the music, as the video export)", async () => {
    const { id } = await twoClips();
    const upload = await t.app.inject({ method: "POST", url: "/api/assets?name=tone.wav", headers: { "content-type": "audio/wav" }, payload: Buffer.from(tone!) });
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: upload.json().id, volume: 40, duck: true } });
    const all = (await download(id)).rawPayload;
    expect(names(all)).toContain("media/music.wav");
    expect(textIn(all, "<?xml")).toContain("<name>music</name>");
    expect(textIn(all, "{\n  \"OTIO_SCHEMA\": \"Timeline.1\"")).toContain("\"A3 music\"");
    // the music left out on request
    expect(names((await download(id, "?music=0")).rawPayload)).not.toContain("media/music.wav");
    // a range: two seconds of the timeline, no music
    const part = (await download(id, "?in=1000&out=3000")).rawPayload;
    expect(names(part)).not.toContain("media/music.wav");
    expect(textIn(part, "<?xml")).toContain("<duration>48</duration><rate>");
  });

  it("is refused, readably, when there is nothing to play yet or the range is empty", async () => {
    const empty = await call("POST", "/api/timelines", { name: "Empty" });
    const res = await download(empty.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/nothing to export/);
    const { id } = await twoClips();
    expect((await download(id, "?in=1000&out=1000")).statusCode).toBe(400);
  });
});

describe("a clip in frames", () => {
  it("keeps the clips end to end, never past a file's end, and a seamless start where it is", async () => {
    const { framesOf, fileFrames } = await import("../src/timelineProject");
    // a take of 5854 ms at 48 fps holds 281 frames; the library keeps 5850 ms of it, which must still say 281
    expect(fileFrames(5850, 48)).toBe(281);
    // clip 4 of a real export: in 896 ms, 4979 ms long; rounded apart it ended on 282, past the file
    const tail = framesOf(48, { atMs: 15062, lengthMs: 4979, inMs: 896, fileMs: 5850 }, true);
    // the last clip keeps its in point (a seamless join starts where it should) and ends a frame sooner
    expect(tail).toMatchObject({ in: 43, out: 281 });
    expect(tail.out - tail.in).toBe(tail.end - tail.start);
    // the same clip with another after it cannot end sooner (a black frame): its in point steps back instead
    const middle = framesOf(48, { atMs: 15062, lengthMs: 4979, inMs: 896, fileMs: 5850 });
    expect(middle).toMatchObject({ in: 42, out: 281 });
    // the clip before ends where this one starts, each end rounded on its own
    expect(framesOf(48, { atMs: 10104, lengthMs: 4958, inMs: 896, fileMs: 5850 }).end).toBe(middle.start);
    // a picture has no end to keep to
    expect(framesOf(24, { atMs: 0, lengthMs: 2000, inMs: 0, fileMs: null })).toEqual({ start: 0, end: 48, in: 0, out: 48 });
  });
});
