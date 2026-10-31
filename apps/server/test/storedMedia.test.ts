import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countFrames, frameAt, soundSlice } from "../src/cut";
import { meansOf } from "../src/measure";
import { localInputs, readAs, READ_AS, tools, videoFacts } from "../src/video";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";

/**
 * Every run of ffmpeg and ffprobe on a kept file is held to the containers a kept file can be (video.ts localInputs, READ_AS
 * stored), not only the upload's probe: a ComfyUI or pod take, a linked folder's file, is never probed as a stranger's, and a
 * file named `.mp4` that is a DASH manifest or an ffconcat list had every other run read the file it names, elsewhere on the
 * disk. Afflatus's own lists and sources name their format (`-f concat`, `-f lavfi`) and are left as they are. Skipped where
 * ffmpeg is not installed.
 */
let dir: string;
let elsewhere: string;
let dash: string;
let list: string;
let hls: string;
const legit = new Map<string, string>();
beforeAll(async () => {
  if (!ffmpegThere) return;
  dir = await mkdtemp(join(tmpdir(), "afflatus-stored-"));
  elsewhere = join(dir, "elsewhere.ts");
  await writeFile(elsewhere, await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"], "ts"));
  const there = elsewhere.replace(/\\/g, "/");
  dash = join(dir, "take.mp4");
  await writeFile(dash, `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet mimeType="video/mp2t"><Representation id="1" bandwidth="1000"><BaseURL>file:${there}</BaseURL></Representation></AdaptationSet></Period></MPD>`);
  // the concat demuxer's own safety lets a name beside the list through
  list = join(dir, "clip.mp4");
  await writeFile(list, "ffconcat version 1.0\nfile elsewhere.ts\n");
  hls = join(dir, "clip.m3u8");
  await writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n${there}\n#EXT-X-ENDLIST\n`);
  const lavfi = (src: string) => ["-f", "lavfi", "-i", src];
  const picture = lavfi("testsrc2=size=64x64:rate=8:duration=1");
  const moving = lavfi("testsrc2=size=64x64:rate=8:duration=1");
  const tone = lavfi("sine=frequency=440:duration=1");
  const made: Array<[string, string[]]> = [
    ["png", [...picture, "-frames:v", "1"]],
    ["jpg", [...picture, "-frames:v", "1"]],
    ["webp", [...picture, "-frames:v", "1"]],
    ["gif", moving],
    ["apng", [...moving, "-f", "apng"]],
    ["anim.webp", [...moving, "-loop", "0"]],
    ["mp4", [...moving, "-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ["webm", [...moving, "-c:v", "libvpx-vp9"]],
    ["wav", tone],
    ["mp3", tone],
    ["flac", tone],
    ["ogg", [...tone, "-c:a", "libopus"]],
    ["m4a", [...tone, "-c:a", "aac"]],
  ];
  for (const [ext, args] of made) {
    const file = join(dir, `legit.${ext}`);
    await writeFile(file, await ffmpegMade(args, ext === "apng" ? "png" : ext.replace("anim.", "")));
    legit.set(ext, file);
  }
}, FFMPEG_TIMEOUT);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("readAs", () => {
  it("holds each input that names no format, before its -i, and ffprobe's one first", () => {
    const held = readAs("stored", ["-y", "-ss", "1", "-i", "a.mp4", "-f", "concat", "-safe", "0", "-i", "list.txt", "-f", "lavfi", "-i", "anullsrc", "-loop", "1", "-i", "b.png", "-f", "null", "-"]);
    expect(held).toEqual([
      "-y", "-ss", "1", "-format_whitelist", READ_AS.stored, "-i", "a.mp4",
      "-f", "concat", "-safe", "0", "-i", "list.txt",
      "-f", "lavfi", "-i", "anullsrc",
      "-loop", "1", "-format_whitelist", READ_AS.stored, "-i", "b.png", "-f", "null", "-",
    ]);
    expect(readAs("stored", ["-v", "error", "-of", "json", "a.mp4"])).toEqual(["-format_whitelist", READ_AS.stored, "-v", "error", "-of", "json", "a.mp4"]);
  });
  it("leaves an input already held to another origin's list as it is", () => {
    const stranger = readAs("stranger", ["-i", "a.mp4", "out.png"]);
    expect(localInputs(stranger)).toEqual(["-format_whitelist", READ_AS.stranger, "-protocol_whitelist", "file,pipe", "-i", "a.mp4", "out.png"]);
    expect(localInputs(["-v", "error", "a.mp4"])).toEqual(["-protocol_whitelist", "file,pipe", "-format_whitelist", READ_AS.stored, "-v", "error", "a.mp4"]);
  });
  it("refuses lists and lavfi in every origin's containers", () => {
    for (const formats of Object.values(READ_AS)) for (const list of ["hls", "dash", "concat", "lavfi", "imf", "ffmetadata"]) expect(formats.split(","), list).not.toContain(list);
  });
});

describe.skipIf(!ffmpegThere)("a kept file", () => {
  it("that is a DASH manifest or a concat list was read through to another file by a run held to files alone", async () => {
    // the gap itself, as every run but the upload's probe was: the other file's picture came out
    const probe = (file: string) =>
      new Promise<string>((done) => execFile(tools.ffprobe, ["-protocol_whitelist", "file,pipe", "-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", file], { windowsHide: true }, (_e, out) => done(String(out))));
    expect(await probe(dash)).toMatch(/64/);
    expect(await probe(list)).toMatch(/64/);
  }, FFMPEG_TIMEOUT);

  it("gives nothing of the file a manifest or a list names, at each kind of run", async () => {
    for (const file of [dash, list, hls]) {
      expect(await videoFacts(file), file).toBeNull();
      await expect(countFrames(file), file).rejects.toThrow();
      expect(await meansOf(file, 0, 0.5), file).toBeNull();
    }
    // the runs that copy the file into a folder of their own first (as a take is read): the DASH one, its path absolute
    const bytes = new Uint8Array(await readFile(dash));
    await expect(frameAt(bytes, "mp4", 0)).rejects.toThrow();
    await expect(soundSlice(bytes, "mp4", 0, 500)).rejects.toThrow();
  }, FFMPEG_TIMEOUT);

  it("still reads as itself: pictures, ComfyUI's moving takes, videos and sounds", async () => {
    for (const ext of ["png", "jpg", "webp", "gif", "apng", "anim.webp", "mp4", "webm"]) {
      expect((await videoFacts(legit.get(ext)!))?.width, ext).toBe(64);
      expect(await countFrames(legit.get(ext)!), ext).toBeGreaterThan(["png", "jpg", "webp"].includes(ext) ? 0 : 1);
    }
    for (const ext of ["png", "webp", "gif", "mp4"]) expect((await frameAt(legit.get(ext)!, ext, 0)).length, ext).toBeGreaterThan(0);
    for (const ext of ["wav", "mp3", "flac", "ogg", "m4a"]) expect((await soundSlice(legit.get(ext)!, ext, 0, 500)).length, ext).toBeGreaterThan(44);
  }, FFMPEG_TIMEOUT);
});
