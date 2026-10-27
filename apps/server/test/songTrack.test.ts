import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { now } from "../src/db";
import { cueStretches, laidSong, soundPartsOf } from "../src/timelineSong";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { ffmpegThere, silentMs, synthMade, waveShift } from "./framesKit";
import { get, makeApp, sentView, until, withTakes, type TestApp } from "./helpers";

/**
 * The song under Lip sync clips as one track (card #131): a take whose sound is its recording plays the recording itself, as
 * parts, in the export and the player alike. Each take's own copy ended short of its frames, started rough after a cut, and
 * the player skipped 56 ms of the song at Timeline 6's cut from clip 7 to 8 (2026-10-27).
 */
describe("a clip's sound as parts", () => {
  const lipSync = recipeById("h3.lipsync")!.inputs;
  // Timeline 6's clip 7: its part re-aimed to 30.665 s after a 917 ms run-up, sung up to it, the song going on into clip 8
  const seven = { recording: "rec", recordingStart: 30.665, recordingSeconds: 4.335, recordingGoesOn: true, recordingLeadIn: true, evenLoudness: true, speechAt: 0 };

  it("plays a take of a song from the recording itself, over all it shows", () => {
    const song = laidSong(lipSync, seven, 917)!;
    expect(song.at(917)).toBeCloseTo(30.665, 6);
    expect(soundPartsOf({ song, take: "t7", shown: { start: 896, end: 5875 }, gainDb: -2.1, cues: [] })).toEqual([
      { kind: "song", asset: "rec", fromMs: 0, toMs: 4979, atS: 30.644, gainDb: -2.1 },
    ]);
    // clip 8 after a cut: from its first frame, where clip 7's song stops (35.623 s)
    const eight = laidSong(lipSync, { ...seven, recordingStart: 35.623, recordingSeconds: 4.377, recordingLeadIn: false }, 0)!;
    expect(soundPartsOf({ song: eight, take: "t8", shown: { start: 0, end: 4458 }, gainDb: -2.1, cues: [] })[0]).toMatchObject({ kind: "song", fromMs: 0, toMs: 4458, atS: 35.623 });
  });

  it("keeps the take's own sound where its file is not the recording: before the words, after a last part, over a cue", () => {
    // the moment before the words (Speech starts at), not sung up to: the model's own sound there
    const lead = laidSong(lipSync, { ...seven, recordingLeadIn: false, speechAt: 0.5 }, 0)!;
    expect(soundPartsOf({ song: lead, take: "t", shown: { start: 0, end: 5000 }, gainDb: 0, cues: [] }).map((p) => [p.kind, p.fromMs, p.toMs])).toEqual([["own", 0, 500], ["song", 500, 5000]]);
    // the last clip of a run: its tail after the part is the recording's pause faded out, as it was laid
    const last = laidSong(lipSync, { ...seven, recordingGoesOn: false, recordingLeadIn: false, recordingSeconds: 4 }, 0)!;
    expect(soundPartsOf({ song: last, take: "t", shown: { start: 0, end: 4458 }, gainDb: 0, cues: [] }).map((p) => [p.kind, p.fromMs, p.toMs])).toEqual([["song", 0, 4000], ["own", 4000, 4458]]);
    // a cue at 2 s for half a second, mixed into the file at its frame: the file's own sound there, a frame wider
    const cue = cueStretches([{ asset: "clap", start: 0, seconds: 0.5, at: 2 }], 917, 24);
    expect(cue).toEqual([{ fromMs: 2917, toMs: 3417 }]);
    const song = laidSong(lipSync, seven, 917)!;
    const parts = soundPartsOf({ song, take: "t7", shown: { start: 896, end: 5875 }, gainDb: 0, cues: cue });
    expect(parts.map((p) => [p.kind, p.fromMs, p.toMs])).toEqual([["song", 0, 2001], ["own", 2001, 2541], ["song", 2541, 4979]]);
    // each part read from where it is: the recording at its moment, the take's file at its own time
    expect(parts[1]).toMatchObject({ asset: "t7", atS: 2.897, gainDb: 0 });
    expect(parts[2]!.atS).toBeCloseTo(song.at(896 + 2541), 6);
  });

  it("is none for a take whose sound is its own", () => {
    expect(laidSong(lipSync, { ...seven, recording: undefined }, 917)).toBeNull();
    expect(laidSong([], seven, 917)).toBeNull();
  });
});

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return sentView(res.json());
};
const view = async (id: string) => withTakes((await get(t.app, `/api/timelines/${id}`)).json());
const upload = async (bytes: Uint8Array, name: string, mime: string) => {
  const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": mime }, payload: Buffer.from(bytes) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json() as { id: string; durationMs: number };
};
function ffmpegTo(args: string[], out: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-song-"));
  try {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args.map((a) => a.replace("{dir}", dir)), join(dir, out)]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return new Uint8Array(readFileSync(join(dir, out)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** A file's sound cut to `seconds` and its first `roughMs` replaced by noise, its frames kept: a take's own copy, short and rough. */
function roughCopy(bytes: Uint8Array, seconds: number, roughMs: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-rough-"));
  try {
    writeFileSync(join(dir, "in.mp4"), bytes);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "in.mp4"), "-map", "0:v", "-map", "0:a", "-c:v", "copy",
      "-af", `atrim=end=${seconds},aeval='if(lt(t,${roughMs / 1000}),0.3*random(0)-0.15,val(0))':c=same`, "-c:a", "aac", "-b:a", "192k", join(dir, "out.mp4")]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return new Uint8Array(readFileSync(join(dir, "out.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function exportOf(id: string): Promise<Uint8Array> {
  await call("POST", `/api/timelines/${id}/export`, { match: false });
  await until(async () => (await view(id)).exporting === null, 60_000);
  const v = await view(id);
  if (v.exportFailed) throw new Error(v.exportFailed);
  const row = await t.db.selectFrom("assets").select("file_key").where("id", "=", v.exported.id).executeTakeFirstOrThrow();
  return t.services.storage.get(row.file_key);
}

describe.skipIf(!ffmpegThere)("the export of the song under Lip sync clips", { timeout: FFMPEG_TIMEOUT }, () => {
  // an H3 render interpolated to 48 a second: 124 frames of the model (5167 ms on its grid), 247 in the file
  const N = 124;
  const FILE = 2 * N - 1;
  const tones = (shift: number) => `0.3*sin(2*PI*440*(t+${shift}))+0.3*sin(2*PI*523*(t+${shift}))`;
  const START = 2;
  const heard = (s: number) => 0.3 * Math.sin(2 * Math.PI * 440 * (s + START)) + 0.3 * Math.sin(2 * Math.PI * 523 * (s + START));
  const GRID = Math.round((N * 1000) / 24);

  /**
   * Three Lip sync clips singing the song from 2 s: the first's own copy short of its frames (5116 of 5167 ms), the second
   * after a cut (or carrying on seamlessly from the first, `joined`) with a rough first 30 ms, the third muted.
   */
  async function timeline(joined: "cut" | "continue", muteThird = true) {
    const rec = await upload(ffmpegTo(["-f", "lavfi", "-i", `aevalsrc='${tones(0)}':s=48000:d=30`, "-c:a", "pcm_s16le"], "song.wav"), "zz-test song.wav", "audio/wav");
    const secondFrom = joined === "cut" ? GRID / 1000 : (GRID - 917) / 1000;
    const takes = [
      roughCopy(await synthMade(1, FILE, 48, undefined, tones(START)), 5.116, 0),
      roughCopy(await synthMade(2, FILE, 48, undefined, tones(START + secondFrom)), FILE / 48, 30),
      await synthMade(3, FILE, 48, undefined, tones(START + 2 * GRID / 1000)),
    ];
    const assets = [];
    for (const [k, b] of takes.entries()) assets.push(await upload(b, `zz-test c${k + 1}.mp4`, "video/mp4"));
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "in", assets.map((a) => a.id)).execute();
    const tl = await call("POST", "/api/timelines", { name: "zz-test song track" });
    for (const a of assets) await call("POST", `/api/timelines/${tl.id}/clips`, { asset: a.id });
    const clips = (await view(tl.id)).clips as Array<{ id: string; take: { id: string } }>;
    await t.db.updateTable("clips").set({ recipe_id: "h3.lipsync" }).where("id", "in", clips.map((c) => c.id)).execute();
    const made = (k: number, start: number, leadIn: boolean) => ({ id: `zz-song-${k}`, owner_id: "local", recipe_id: "h3.lipsync", recipe_version: 1, family: "h3", inputs: JSON.stringify({ recording: rec.id, recordingStart: start, recordingSeconds: 5, recordingGoesOn: true, recordingLeadIn: leadIn, evenLoudness: false }), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() });
    await t.db.insertInto("generations").values([made(0, START, false), made(1, START + GRID / 1000, joined === "continue"), made(2, START + 2 * GRID / 1000 - (joined === "continue" ? 0.917 : 0), false)] as never).execute();
    for (const [k, a] of assets.entries()) await t.db.updateTable("assets").set({ generation_id: `zz-song-${k}` }).where("id", "=", a.id).execute();
    if (joined === "continue") {
      await call("PATCH", `/api/clips/${clips[1]!.id}`, { joined: "continue" });
      await t.db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[0]!.take.id, prev_at_ms: GRID }).where("id", "=", clips[1]!.take.id).execute();
    }
    if (muteThird) await call("PATCH", `/api/clips/${clips[2]!.id}`, { sound: "muted" });
    return { id: tl.id as string, rec: rec.id };
  }

  it("plays the song on across a cut to the sample, where the takes' own copies were short and rough", async () => {
    const { id, rec } = await timeline("cut");
    const v = await view(id);
    expect(v.clips[0].soundParts).toEqual([{ kind: "song", asset: rec, fromMs: 0, toMs: v.clips[0].lengthMs, atS: START, gainDb: 0 }]);
    expect(v.clips[1].soundParts[0]).toMatchObject({ kind: "song", asset: rec, fromMs: 0 });
    expect(v.clips[2].soundParts).toBeUndefined();
    const out = await exportOf(id);
    const cut = v.clips[1].atMs;
    expect(silentMs(out, cut - 200, cut + 200), "silence at the cut").toBeLessThanOrEqual(0);
    // one song, to a sample: before the cut, where the first take's copy stopped, over the second's rough start, and on
    const before = waveShift(out, cut - 300, heard);
    for (const at of [cut - 30, cut + 5, cut + 300]) expect(Math.abs(waveShift(out, at, heard) - before), `at ${at} ms`).toBeLessThan(1000 / 48000 + 1e-9);
    // the muted clip after it stays silent
    expect(silentMs(out, v.clips[2].atMs + 100, v.clips[2].atMs + 1000)).toBeGreaterThan(800);
  });

  it("plays it on across a seamless join the same way, with no early hand-over", async () => {
    const { id } = await timeline("continue");
    const v = await view(id);
    expect(v.clips[1].take.seamless).toBe(true);
    const out = await exportOf(id);
    const join = v.clips[1].atMs;
    expect(silentMs(out, join - 200, join + 200)).toBeLessThanOrEqual(0);
    const before = waveShift(out, join - 300, heard);
    for (const at of [join - 60, join + 5, join + 300]) expect(Math.abs(waveShift(out, at, heard) - before), `at ${at} ms`).toBeLessThan(1000 / 48000 + 1e-9);
  });

  it("plays the song at the gain its render evened the recording out by", async () => {
    const { id, rec } = await timeline("cut", false);
    await t.db.updateTable("generations").set({ inputs: JSON.stringify({ recording: rec, recordingStart: START, recordingSeconds: 5, recordingGoesOn: true, evenLoudness: true }) }).where("id", "=", "zz-song-0").execute();
    const v = await view(id);
    // two tones at 0.3 each are louder than -16 LUFS: brought down, as each clip's part was
    expect(v.clips[0].soundParts[0].gainDb).toBeLessThan(-1);
    expect(v.clips[1].soundParts[0].gainDb).toBe(0);
  });
});
