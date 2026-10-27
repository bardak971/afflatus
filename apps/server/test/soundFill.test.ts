import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { now } from "../src/db";
import { carriesOn, laidSong, soundFillOf } from "../src/timelineSoundFill";
import { recipeById } from "@afflatus/recipes";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { ffmpegThere, silentMs, synthMade, waveShift } from "./framesKit";
import { get, makeApp, sentView, until, withTakes, type TestApp } from "./helpers";

/**
 * A take under a recording whose own sound stops short of its frames, before a cut: the rest is filled from the recording
 * itself, at the take's level, where a cut after it played silence (30 ms in the middle of a sung line on Timeline 6's clip
 * 7, 2026-10-27). A join that carries on is never filled: its sound stays as it was.
 */
describe("a take's sound filled from its recording before a cut", () => {
  // Timeline 6's clip 7: its part re-aimed to 30.665 s, after a 917 ms run-up; its sound track 5845 ms, its frames 5875
  const lipSync = recipeById("h3.lipsync")!.inputs;
  const made = { recording: "rec", recordingStart: 30.665, recordingSeconds: 4.335, recordingGoesOn: true, recordingLeadIn: true, speechAt: 0 };
  const song = laidSong(lipSync, made, 917);

  it("reads the moment of the recording at a time of the take's file", () => {
    expect(song?.asset).toBe("rec");
    expect(song!.at(917)).toBeCloseTo(30.665, 6);
    // where its sound stops: 35.593 s of the song, as measured on the file (35.595)
    expect(song!.at(5845)).toBeCloseTo(35.593, 6);
    // the moment before the words (Speech starts at) is played before the part, as the run-up is
    expect(laidSong(lipSync, { ...made, speechAt: 0.5 }, 917)!.at(5845)).toBeCloseTo(35.093, 6);
    // a take whose sound is its own (no recording sent), or of no form made around one: none
    expect(laidSong(lipSync, { ...made, recording: undefined }, 917)).toBeNull();
    expect(laidSong([], made, 917)).toBeNull();
  });

  it("fills the 30 ms to the cut, and nothing where the clip after carries on, plays over the join, or the gap is not one", () => {
    const fill = (o: Partial<Parameters<typeof soundFillOf>[0]> = {}) => soundFillOf({ sound: "own", hasSound: true, song, endMs: 5875, nextCarriesOn: false, tail: { soundMs: 5845, gainDb: -1.5 }, ...o });
    expect(fill()).toEqual({ asset: "rec", fromMs: 5845, ms: 30, songS: 35.593, gainDb: -1.5 });
    expect(fill({ nextCarriesOn: true })).toBeNull();
    expect(fill({ sound: "muted" })).toBeNull();
    expect(fill({ sound: "file" })).toBeNull();
    expect(fill({ tail: null })).toBeNull();
    // under 2 ms nothing is heard missing; past 250 ms it is something else (a sound cut off), left as it is
    expect(fill({ tail: { soundMs: 5874, gainDb: 0 } })).toBeNull();
    expect(fill({ tail: { soundMs: 5500, gainDb: 0 } })).toBeNull();
    // a seamless join, a landing, a transition into it (a cut's crossfade): carried on, never filled
    expect(carriesOn({ kind: "video", joined: "continue", transition: null })).toBe(true);
    expect(carriesOn({ kind: "video", joined: "cut", transition: { kind: "fade" } })).toBe(true);
    expect(carriesOn({ kind: "still", joined: "cut", transition: { kind: "fade" } })).toBe(true);
    // a cut, a still after it, the timeline's end: filled
    expect(carriesOn({ kind: "video", joined: "cut", transition: null })).toBe(false);
    expect(carriesOn({ kind: "still", joined: "continue", transition: null })).toBe(false);
    expect(carriesOn(undefined)).toBe(false);
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

/** A file's sound cut to `seconds`, its frames kept: a take whose sound track ends before its last frame. */
function soundCut(bytes: Uint8Array, seconds: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-fill-"));
  try {
    writeFileSync(join(dir, "in.mp4"), bytes);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "in.mp4"), "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `atrim=end=${seconds}`, "-c:a", "aac", "-b:a", "192k", join(dir, "out.mp4")]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return new Uint8Array(readFileSync(join(dir, "out.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A sound file of `expr` (in t, seconds) for `seconds`. */
function wav(expr: string, seconds: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-song-"));
  try {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${seconds}`, "-c:a", "pcm_s16le", join(dir, "song.wav")]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return new Uint8Array(readFileSync(join(dir, "song.wav")));
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

describe.skipIf(!ffmpegThere)("the export of a take whose sound stops short before a cut", { timeout: FFMPEG_TIMEOUT }, () => {
  // an H3 render interpolated to 48 a second: 124 frames of the model (5167 ms on its grid), 247 in the file (5146 ms)
  const N = 124;
  const FILE = 2 * N - 1;
  // the song: two tones no shift lines up but the right one, so where the export is in it is read back to the sample
  const tones = (shift: number) => `0.3*sin(2*PI*440*(t+${shift}))+0.3*sin(2*PI*523*(t+${shift}))`;
  const START = 2;
  const heard = (s: number) => 0.3 * Math.sin(2 * Math.PI * 440 * (s + START)) + 0.3 * Math.sin(2 * Math.PI * 523 * (s + START));

  /** A timeline: clip 1 a Lip sync take singing the song from 2 s, its sound track ending at `soundS`; clip 2 a take of its own, joined as `joined`. */
  async function timeline(soundS: number, joined: "cut" | "continue") {
    const rec = await upload(wav(tones(0), 20), "zz-test song.wav", "audio/wav");
    const first = await upload(soundCut(await synthMade(1, FILE, 48, undefined, tones(START)), soundS), "zz-test c1.mp4", "video/mp4");
    const second = await upload(await synthMade(2, FILE, 48, undefined, "0.3*sin(2*PI*880*t)"), "zz-test c2.mp4", "video/mp4");
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "in", [first.id, second.id]).execute();
    const tl = await call("POST", "/api/timelines", { name: "zz-test sound fill" });
    for (const a of [first, second]) await call("POST", `/api/timelines/${tl.id}/clips`, { asset: a.id });
    const clips = (await view(tl.id)).clips as Array<{ id: string; take: { id: string } }>;
    await t.db.updateTable("clips").set({ recipe_id: "h3.lipsync" }).where("id", "=", clips[0]!.id).execute();
    await t.db.insertInto("generations").values({ id: "zz-fill", owner_id: "local", recipe_id: "h3.lipsync", recipe_version: 1, family: "h3", inputs: JSON.stringify({ recording: rec.id, recordingStart: START, recordingSeconds: 5, recordingGoesOn: true }), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    await t.db.updateTable("assets").set({ generation_id: "zz-fill" }).where("id", "=", first.id).execute();
    if (joined === "continue") {
      await call("PATCH", `/api/clips/${clips[1]!.id}`, { joined: "continue" });
      await t.db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[0]!.take.id, prev_at_ms: Math.round((N * 1000) / 24) }).where("id", "=", clips[1]!.take.id).execute();
    }
    return { id: tl.id as string, rec: rec.id };
  }

  it("plays the song on to the cut from the recording, at the take's level, where it was silent", async () => {
    // its sound 51 ms short of where it stops playing (5116 against 5167 ms)
    const { id, rec } = await timeline(5.116, "cut");
    const v = await view(id);
    const fill = v.clips[0].soundFill;
    expect(fill).toMatchObject({ asset: rec });
    expect(fill.fromMs).toBeGreaterThan(5100);
    expect(fill.fromMs + fill.ms).toBeCloseTo(v.clips[0].take.endMs, 0);
    expect(fill.songS).toBeCloseTo(START + fill.fromMs / 1000, 3);
    // the take is the recording as it was laid: no gain to make up
    expect(Math.abs(fill.gainDb)).toBeLessThan(0.5);
    expect(v.clips[1].soundFill).toBeUndefined();
    const out = await exportOf(id);
    const join = v.clips[1].atMs;
    expect(silentMs(out, join - 200, join - 2), "silence before the cut").toBeLessThanOrEqual(1);
    // where the export is in the song, before the take's sound stops and in the fill: the same, to a sample
    const before = waveShift(out, join - 150, heard);
    expect(Math.abs(waveShift(out, join - 40, heard) - before)).toBeLessThan(1000 / 48000 + 1e-9);
  });

  it("leaves a join that carries on as it was: no fill, its sound handed over as before", async () => {
    const { id } = await timeline(5.116, "continue");
    const v = await view(id);
    expect(v.clips[1].take.seamless).toBe(true);
    // the view and the export ask the same (Timelines.soundFillFor): none, so the export's sound chain is the one it was
    expect(v.clips[0].soundFill).toBeUndefined();
  });
});
