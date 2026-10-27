import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, sentView, withTakes, makeApp, type TestApp } from "./helpers";

/**
 * A voice recording dropped on the track made into Lip sync clips, cut at its pauses (Timelines.makeFromRecording). The
 * recording is a tone with two pauses, made by ffmpeg; nothing is rendered.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw Object.assign(new Error(`${method} ${url}: ${res.statusCode} ${res.body}`), { statusCode: res.statusCode });
  return sentView(res.json());
};
const view = async (id: string) => withTakes((await get(t.app, `/api/timelines/${id}`)).json());

const tone = (s: number) => `sine=frequency=220:duration=${s}`;
const quiet = (s: number) => `anullsrc=r=48000:cl=mono,atrim=duration=${s}`;

/** A moment as an SRT file writes it: 00:00:04,200. */
const srtTime = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0").replace(".", ",")}`;

/**
 * 15 s by default: words to 4.5 s, a pause to 4.9, words to 10.0, a pause to 10.4, words to the end. `lyrics` (an SRT):
 * an m4a carrying them as a mov_text track, as Suno's songs do.
 */
async function recording(parts = [tone(4.5), quiet(0.4), tone(5.1), quiet(0.4), tone(4.6)], ms = 15000, lyrics?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-recording-"));
  try {
    const wav = join(dir, "talk.wav");
    const inputs = parts.flatMap((p) => ["-f", "lavfi", "-i", p]);
    const filter = `${parts.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`).join(";")};${parts.map((_, k) => `[a${k}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", wav]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    let out = wav;
    if (lyrics !== undefined) {
      writeFileSync(join(dir, "lyrics.srt"), lyrics);
      out = join(dir, "song.m4a");
      const m = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-i", join(dir, "lyrics.srt"), "-map", "0:a", "-map", "1:s", "-c:a", "aac", "-c:s", "mov_text", out]);
      if (m.status !== 0) throw new Error(String(m.stderr));
    }
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}`;
    await t.services.storage.put(key, new Uint8Array(readFileSync(out)));
    await t.db.insertInto("assets").values(newAssetRow({
      id, kind: "audio", origin: "uploaded", name: lyrics !== undefined ? "zz-test song.m4a" : "zz-test talking.wav", file_key: key, thumb_key: null, mime: lyrics !== undefined ? "audio/mp4" : "audio/wav", bytes: 1000,
      width: null, height: null, duration_ms: ms, fps: null, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
    })).execute();
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ffmpegThere)("a recording dropped on the track", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is made into Lip sync clips cut in its pauses, each carrying on from the one before", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    expect(clips).toHaveLength(3);
    const v = await view(tl.id);
    expect(v.clips.map((c: { recipe: string }) => c.recipe)).toEqual(["h3.lipsync", "h3.lipsync", "h3.lipsync"]);
    // cut at the middle of each pause (4.7 and 10.2 s), brought to the nearest moment a clip can end on: H3's frame counts
    // (17k + 5 at 24 a second) from the first, 17 frames (0.71 s) at a time after the run-up of the others, within half one
    const parts = v.clips.map((c: { inputs: Record<string, number> }) => [c.inputs.recordingStart, c.inputs.recordingSeconds]);
    expect(parts[0][0]).toBe(0);
    expect(Math.abs(parts[1][0] - 4.7)).toBeLessThan(0.36);
    expect(Math.abs(parts[2][0] - 10.2)).toBeLessThan(0.36);
    expect(Math.round(parts[0][1] * 24 - 5) % 17).toBe(0);
    expect(Math.round(parts[1][1] * 24) % 17).toBe(0);
    expect(parts.reduce((s: number, p: number[]) => s + p[1]!, 0)).toBeCloseTo(15, 1);
    for (const c of v.clips) expect(c.inputs.recording).toBe(sound);
    // the first starts on its own (nothing before it), the others carry on
    expect(v.clips.map((c: { joined: string }) => c.joined)).toEqual(["cut", "continue", "continue"]);
    // one step: Undo takes them all away
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(0);
  });

  it("dropped on an empty clip, goes in its place with what was written in it; after an H3 clip it carries on", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording on a clip" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" });
    const empty = await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.lipsync" });
    const emptyId = (empty.id ?? (await view(tl.id)).clips[1].id) as string;
    await call("PATCH", `/api/clips/${emptyId}`, { inputs: { description: "A woman talks to the camera in a kitchen." } });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: emptyId });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).not.toContain(emptyId);
    expect(v.clips).toHaveLength(4);
    expect(v.clips[0].recipe).toBe("h3.video");
    expect(v.clips[1].joined).toBe("continue");
    for (const c of v.clips.slice(1)) expect(c.inputs.description).toBe("A woman talks to the camera in a kitchen.");
  });

  it("trimmed: its end in sets the clips past it aside, a rendered one kept whole; out again brings them back, then adds clips at its pauses; its start moved makes them anew", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording trim" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    expect(clips).toHaveLength(3);
    const parts = (v: { clips: Array<{ inputs: Record<string, number> }> }) => v.clips.map((c) => [c.inputs.recordingStart, c.inputs.recordingSeconds]);
    // the end in to 9 s: the third clip goes, the second (empty) shortened to it, 4.3 s (a clip takes 4 at least: at 8 s
    // it would have gone too, the end back where the first ends)
    let r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 9000 });
    expect(r.toMs).toBe(9000);
    let v = await view(tl.id);
    expect(v.clips).toHaveLength(2);
    expect(parts(v)[1]![0]! + parts(v)[1]![1]!).toBeCloseTo(9, 2);
    expect(v.recordings).toEqual([expect.objectContaining({ parked: 1 })]);
    // out again to the end: the second as long as it was, the third back as it was (the same clip)
    r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    v = await view(tl.id);
    expect(v.clips).toHaveLength(3);
    expect(v.clips[2].id).toBe(clips[2]);
    expect(Math.abs(parts(v)[2]![0]! - 10.2)).toBeLessThan(0.1);
    expect(parts(v)[1]![0]! + parts(v)[1]![1]!).toBeCloseTo(parts(v)[2]![0]!, 2);
    expect(v.clips[2].joined).toBe("continue");
    expect(v.recordings[0].parked).toBe(0);
    // a rendered second clip: the end a little into it snaps back to where the first ends
    const take = newId();
    const video = newId();
    await t.db.insertInto("assets").values(newAssetRow({ id: video, kind: "video", origin: "uploaded", name: "t.mp4", file_key: `assets/zz/${video}`, thumb_key: null, mime: "video/mp4", bytes: 1, width: 480, height: 854, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now() })).execute();
    await t.db.insertInto("takes").values({ id: take, clip_id: v.clips[1].id, asset_id: video, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() }).execute();
    await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", v.clips[1].id).execute();
    const firstEnd = Math.round((parts(v)[0]![0]! + parts(v)[0]![1]!) * 1000);
    r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: firstEnd + 500 });
    expect(r.toMs).toBe(firstEnd);
    expect((await view(tl.id)).clips).toHaveLength(1);
    // out again: the rendered one back with its take, the third after it; then past where they end, a new clip
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    v = await view(tl.id);
    expect(v.clips).toHaveLength(3);
    expect(v.clips[1].take?.id).toBe(take);
    expect(v.clips[2].id).toBe(clips[2]);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(1);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips[1].take?.id).toBe(take);
    // its start moved: every clip made anew from there
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 2000, toMs: 15000 });
    v = await view(tl.id);
    expect(parts(v)[0]![0]).toBeCloseTo(2, 2);
    expect(v.clips.every((c: { take: unknown }) => !c.take)).toBe(true);
  });

  const queued = (clipId: string) =>
    t.db.insertInto("jobs").values({ id: newId(), owner_id: "local", recipe_id: "h3.lipsync", label: "x", inputs: "{}", status: "queued", priority: 0, clip_id: clipId, created_at: now(), updated_at: now() } as never).execute();
  const trim = (tl: string, sound: string, fromMs: number, toMs: number) => t.app.inject({ method: "POST", url: `/api/timelines/${tl}/recording/trim`, payload: { asset: sound, fromMs, toMs } });

  it("never sets aside, replaces or is dropped on a clip that waits in the queue: refused, with no step to undo", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording queued" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    await queued(clips[2]);
    const undo = (await view(tl.id)).undo;
    // its end in, past the queued clip; its start moved (every clip made anew)
    for (const res of [await trim(tl.id, sound, 0, 9000), await trim(tl.id, sound, 2000, 15000)]) {
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatch(/Clip 3 is rendering or in the queue/);
    }
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(clips);
    expect(v.undo).toBe(undo);
    // a recording dropped on an empty clip that waits: refused, the clip and its render left as they are
    const other = await recording();
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/recording`, payload: { asset: other, clip: clips[2] } });
    expect(res.statusCode).toBe(409);
    expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(clips);
  });

  it("keeps its first clip whatever the end asks: the recording stays on the track, and can be trimmed out again", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording first" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 1000 });
    // a Lip sync clip takes 4 s at the least
    expect(r.toMs).toBe(4000);
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(clips.slice(0, 1));
    expect(v.recordings).toEqual([expect.objectContaining({ parked: 2, parkedTakes: 0 })]);
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(clips);
  });

  it("made longer past the clips set aside: they come back and new clips follow, one step for Undo", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording longer" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 9000 });
    // the clip set aside made to end at 11 s (as if cut shorter), so that the end out at 15 s goes past it by a clip's least
    const row = await t.db.selectFrom("timelines").select("recordings").where("id", "=", tl.id).executeTakeFirstOrThrow();
    const parked = JSON.parse(row.recordings!) as Record<string, Array<{ clip: { inputs: string } }>>;
    const inputs = JSON.parse(parked[sound]![0]!.clip.inputs) as Record<string, number>;
    parked[sound]![0]!.clip.inputs = JSON.stringify({ ...inputs, recordingSeconds: Math.round((11 - inputs.recordingStart!) * 100) / 100 });
    await t.db.updateTable("timelines").set({ recordings: JSON.stringify(parked) }).where("id", "=", tl.id).execute();
    const r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    expect(r.clips).toHaveLength(1);
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([...clips, ...r.clips]);
    expect(v.undo).toBe("the recording made longer");
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(clips.slice(0, 2));
  });

  const parts = (v: { clips: Array<{ inputs: Record<string, number> }> }) => v.clips.map((c) => [c.inputs.recordingStart, c.inputs.recordingSeconds]);

  it("a little out past where a rendered clip set aside starts: the empty clip before made longer to meet it, it and its take kept aside", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording rendered aside" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const video = newId();
    const take = newId();
    await t.db.insertInto("assets").values(newAssetRow({ id: video, kind: "video", origin: "uploaded", name: "t.mp4", file_key: `assets/zz/${video}`, thumb_key: null, mime: "video/mp4", bytes: 1, width: 480, height: 854, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now() })).execute();
    await t.db.insertInto("takes").values({ id: take, clip_id: clips[2], asset_id: video, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() } as never).execute();
    await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clips[2]).execute();
    const whole = parts(await view(tl.id));
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 9000 });
    // out to 12 s: the rendered third clip (from about 10.2 s to 15) is not held yet, and no new clip goes over it
    const r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 12000 });
    let v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(clips.slice(0, 2));
    expect(parts(v)[1]).toEqual(whole[1]);
    expect(r.toMs).toBe(Math.round(whole[2]![0]! * 1000));
    expect(v.recordings).toEqual([expect.objectContaining({ parked: 1, parkedTakes: 1 })]);
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(clips);
    expect(v.clips[2].take?.id).toBe(take);
  });

  it("a little out past its last clip makes no clip shorter than the model takes: the empty last clip takes the rest", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording least" });
    const sound = await recording();
    const { clips } = await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const whole = parts(await view(tl.id));
    // the end in to 14.5 s: the last clip (empty) shortened to it, nothing set aside
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 14500 });
    expect((await view(tl.id)).recordings).toEqual([expect.objectContaining({ parked: 0 })]);
    const r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    expect(r).toEqual({ clips: [], toMs: 15000 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(clips);
    expect(parts(v)[2]).toEqual(whole[2]);
  });

  it("refuses a video with no sound, and a sound ffmpeg cannot read, keeping no pauses for it", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording unreadable" });
    const add = async (kind: "audio" | "video", hasSound: number) => {
      const id = newId();
      const key = `assets/${id.slice(0, 2)}/${id}`;
      await t.services.storage.put(key, new TextEncoder().encode("not a sound"));
      await t.db.insertInto("assets").values(newAssetRow({
        id, kind, origin: "uploaded", name: "zz-test broken", file_key: key, thumb_key: null, mime: kind === "audio" ? "audio/wav" : "video/mp4", bytes: 11,
        width: null, height: null, duration_ms: 15000, fps: null, has_sound: hasSound, folder_id: null, generation_id: null, kept_at: now(),
      })).execute();
      return id;
    };
    const mute = await add("video", 0);
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/recording`, payload: { asset: mute } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/has no sound/);
    const broken = await add("audio", 1);
    const bad = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/recording`, payload: { asset: broken } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/could not be read/);
    await expect(t.services.storage.get(`pauses/${broken.slice(0, 2)}/${broken}.json`)).rejects.toThrow();
    expect((await view(tl.id)).clips).toHaveLength(0);
  });
  it("cut again from its panel: at another length, in its pauses or not, kept for its trims; one step for Undo each", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording cut" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const parts = (v: { clips: Array<{ inputs: Record<string, number> }> }) => v.clips.map((c) => [c.inputs.recordingStart, c.inputs.recordingSeconds]);
    let v = await view(tl.id);
    expect(v.recordings).toEqual([expect.objectContaining({ seconds: 5, window: 1.5 })]);
    await call("PATCH", `/api/clips/${v.clips[0].id}`, { inputs: { ...v.clips[0].inputs, description: "zz-test a woman talks to the camera" } });
    // about 7 s ± 2.5, in its pauses (4.7 and 10.2): 4.7 is within it, on H3's nearest frame count (107 frames, 4.46 s), and
    // what is left after it fits one clip
    await call("POST", `/api/timelines/${tl.id}/recording/cut`, { asset: sound, seconds: 7, window: 2.5 });
    v = await view(tl.id);
    expect(parts(v).map(([a, b]) => [a, Math.round((a! + b!) * 100) / 100])).toEqual([[0, 4.46], [4.46, 15]]);
    expect(v.clips[0].inputs.description).toBe("zz-test a woman talks to the camera");
    expect(v.recordings[0]).toEqual(expect.objectContaining({ seconds: 7, window: 2.5 }));
    // 6 s ± 0, its pauses passed by
    await call("POST", `/api/timelines/${tl.id}/recording/cut`, { asset: sound, seconds: 6, window: 0 });
    v = await view(tl.id);
    // on H3's nearest frame count all the same (141 frames, 5.88 s): the clips meet there once rendered
    expect(parts(v)).toEqual([[0, 5.88], [5.88, 9.12]]);
    expect(v.recordings[0]).toEqual(expect.objectContaining({ seconds: 6, window: 0 }));
    // its start moved: made anew as it is cut now, not at its pauses
    await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 1000, toMs: 15000 });
    expect(parts(await view(tl.id))).toEqual([[1, 5.88], [6.88, 8.12]]);
    // each step undone: the cut before comes back with its clips
    await call("POST", `/api/timelines/${tl.id}/undo`);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    v = await view(tl.id);
    expect(v.clips).toHaveLength(2);
    expect(v.recordings[0]).toEqual(expect.objectContaining({ seconds: 7, window: 2.5 }));
  });

  it("cut ± 1.5 s passes by a pause outside the window, and ends at the length asked on a level sound", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording window" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    // 7 s ± 1.5: the pauses (4.7, 10.2) are outside 5.5 to 8.5, and the tone is level there: 7 s, on H3's nearest frame
    // count (175 frames, 7.29 s), then the rest
    await call("POST", `/api/timelines/${tl.id}/recording/cut`, { asset: sound, seconds: 7, window: 1.5 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { inputs: Record<string, number> }) => [c.inputs.recordingStart, c.inputs.recordingSeconds])).toEqual([[0, 7.29], [7.29, 7.71]]);
    // past the widest window the panel takes: refused
    const wide = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/recording/cut`, payload: { asset: sound, seconds: 7, window: 6 } });
    expect(wide.statusCode).toBe(400);
  });

  it("reads a cut kept before the window: Snap to pauses on as ± 1.5 s, off as ± 0", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording old cut" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    for (const [snap, window] of [[true, 1.5], [false, 0]] as const) {
      await t.db.updateTable("timelines").set({ recordings: JSON.stringify({ cut: { [sound]: { seconds: 6, snap, form: "h3.lipsync" } } }) }).where("id", "=", tl.id).execute();
      expect((await view(tl.id)).recordings[0]).toEqual(expect.objectContaining({ seconds: 6, window, form: "h3.lipsync" }));
    }
  });

  it("that never pauses but carries timed lyrics (Suno's m4a): each clip ends at the end of the line nearest the length asked", async () => {
    // a level tone of 30 s, its lines ending at 4.2, 9.6, 14.1, 20 and 25.5 s; a section's name between them, of no length
    const srt = [[0, 4.2, "line one"], [4.2, 4.2, "[Chorus]"], [4.2, 9.6, "line two"], [9.6, 14.1, "line three"], [14.1, 20, "line four"], [20, 25.5, "line five"], [25.5, 29, "line six"]]
      .map(([a, b, text], k) => `${k + 1}\n${srtTime(Number(a))} --> ${srtTime(Number(b))}\n${text}\n`).join("\n");
    const sound = await recording([tone(30)], 30000, srt);
    const marks = (await get(t.app, `/api/assets/${sound}/pauses`)).json() as { pauses: unknown[]; lines: Array<{ start: number; end: number }> };
    expect(marks.pauses).toEqual([]);
    expect(marks.lines.map((l) => l.end)).toEqual([4.2, 4.2, 9.6, 14.1, 20, 25.5, 29]);
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording lyrics" });
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const v = await view(tl.id);
    // each line's end brought to the nearest moment a clip can end on (H3: 17k + 5 frames from the first, then 0.71 s steps),
    // the drift of one never carried into the next: within half a step of every line
    const ends = v.clips.map((c: { inputs: Record<string, number> }) => [c.inputs.recordingStart, Math.round((c.inputs.recordingStart! + c.inputs.recordingSeconds!) * 100) / 100]);
    expect(ends).toEqual([[0, 4.46], [4.46, 9.42], [9.42, 14.38], [14.38, 20.04], [20.04, 25.71], [25.71, 30]]);
    for (const [k, line] of [4.2, 9.6, 14.1, 20, 25.5].entries()) expect(Math.abs(ends[k]![1]! - line)).toBeLessThan(0.36);
  });

  it("gives what its clips share to all of them at once, one step for Undo; never their parts of it", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test recording shared" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const before = await view(tl.id);
    const given = await call("POST", `/api/timelines/${tl.id}/recording/form`, { asset: sound, inputs: { description: "zz-test a man at a desk, talking", recordingStart: 3 } });
    const v = await view(tl.id);
    // the forms as written, for the editor's edits over those clips to become them
    expect(given.clips).toEqual(v.clips.map((c: { id: string; inputs: Record<string, unknown> }) => ({ id: c.id, inputs: c.inputs })));
    expect(v.clips.map((c: { inputs: Record<string, unknown> }) => c.inputs.description)).toEqual(Array(3).fill("zz-test a man at a desk, talking"));
    expect(v.clips.map((c: { inputs: Record<string, unknown> }) => c.inputs.recordingStart)).toEqual(before.clips.map((c: { inputs: Record<string, unknown> }) => c.inputs.recordingStart));
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips.map((c: { inputs: Record<string, unknown> }) => c.inputs.description)).toEqual(before.clips.map((c: { inputs: Record<string, unknown> }) => c.inputs.description));
    // nothing it can share: refused
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/recording/form`, payload: { asset: sound, inputs: { recordingSeconds: 3 } } });
    expect(res.statusCode).toBe(400);
  });

  it("that never pauses (a song): each clip hands the recording on to the next, which starts where the clip before stops playing", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test song" });
    const sound = await recording([tone(24)], 24000);
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    await call("POST", `/api/timelines/${tl.id}/recording/cut`, { asset: sound, seconds: 8, window: 1.5 });
    const v = await view(tl.id);
    const clips = v.clips as Array<{ id: string; inputs: Record<string, unknown> }>;
    // on H3's frame counts: the first 192 frames (8 s, on the grid as it is), the second 11 steps of 17 after its run-up
    expect(clips.map((c) => [c.inputs.recordingStart, c.inputs.recordingSeconds])).toEqual([[0, 8], [8, 7.79], [15.79, 8.21]]);
    const recipe = t.services.registry.recipe("h3.lipsync")!;
    const planOf = (k: number) => t.services.timelines.plan(clips[k]!.id, recipe, clips[k]!.inputs, false, null, true);
    // the recording goes on in the next clip for the first two, not for the last
    expect((await planOf(0)).input.recordingGoesOn).toBe(true);
    expect((await planOf(1)).input.recordingGoesOn).toBe(true);
    expect((await planOf(2)).input.recordingGoesOn).toBe(false);

    // clip 1 rendered 8.687 s long (its pad and the frame grid), first without the recording going on: clip 2 as it was cut
    const made = { recording: sound, recordingStart: 0, recordingSeconds: 8, speechAt: 0 };
    await t.db.insertInto("generations").values({ id: "zz-g1", owner_id: OWNER, recipe_id: "h3.lipsync", recipe_version: 1, family: "h3", inputs: JSON.stringify(made), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    await t.db.insertInto("assets").values(newAssetRow({
      id: "zz-v1", kind: "video", origin: "generated", name: "zz-test song c1", file_key: "assets/zz/zz-v1", thumb_key: null, mime: "video/mp4", bytes: 1000,
      width: 576, height: 1024, duration_ms: 8687, fps: 24, has_sound: 1, folder_id: null, generation_id: "zz-g1", kept_at: now(),
    })).execute();
    const asset = await t.db.selectFrom("assets").selectAll().where("id", "=", "zz-v1").executeTakeFirstOrThrow();
    await t.services.timelines.takes.add(clips[0]!.id, asset, { headMs: 0, tailMs: 0 }, {});
    let second = await planOf(1);
    expect([second.input.recordingStart, second.input.recordingSeconds]).toEqual([8, 7.79]);
    expect(second.input.recordingLeadIn).toBe(false);
    // made with the recording going on: its tail sang 8 to 8.687, so clip 2 starts there and still ends at 15.79
    await t.db.updateTable("generations").set({ inputs: JSON.stringify({ ...made, recordingGoesOn: true }) }).where("id", "=", "zz-g1").execute();
    second = await planOf(1);
    expect(second.input.recordingStart).toBeCloseTo(8.687, 3);
    expect(Number(second.input.recordingStart) + Number(second.input.recordingSeconds)).toBeCloseTo(15.79, 3);
    // its head (the frames it shares with clip 1) filed with what clip 1 sang there, handed over before its part
    expect(second.input.recordingLeadIn).toBe(true);
    // an H3 render interpolated to 48 a second: 209 model frames (8.708 s on its grid), its file a frame shorter (8.688 s).
    // The track plays it on the grid: the next part starts at 8.708, where the song stops playing, not at the file's end
    await t.db.updateTable("assets").set({ duration_ms: 8688, fps: 48, latent_frames: 209 }).where("id", "=", "zz-v1").execute();
    second = await planOf(1);
    expect(second.input.recordingStart).toBeCloseTo(8.708, 3);
    // a take that lasts its part (192 frames, rendered with no pad as its recording goes on): clip 2 as it was cut, the
    // clips meeting at 8 s, where the cut put them
    await t.db.updateTable("assets").set({ duration_ms: 7979, fps: 48, latent_frames: 192 }).where("id", "=", "zz-v1").execute();
    second = await planOf(1);
    expect([second.input.recordingStart, second.input.recordingSeconds]).toEqual([8, 7.79]);
    // one that stops short of its part (a part cut before the grid, rounded down): clip 2 sings on from there, nothing skipped
    await t.db.updateTable("assets").set({ duration_ms: 7271, fps: 48, latent_frames: 175 }).where("id", "=", "zz-v1").execute();
    second = await planOf(1);
    expect(second.input.recordingStart).toBeCloseTo(7.292, 3);
    expect(Number(second.input.recordingStart) + Number(second.input.recordingSeconds)).toBeCloseTo(15.79, 3);
    // the clip's own form is left as the cut made it
    expect((await view(tl.id)).clips[1].inputs).toMatchObject({ recordingStart: 8, recordingSeconds: 7.79 });
  });

  it("of a song, planned for a finish, a lone clip, the moment before the words: what a clip is told of the run is its own", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test song run" });
    const sound = await recording([tone(24)], 24000);
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    await call("POST", `/api/timelines/${tl.id}/recording/cut`, { asset: sound, seconds: 8, window: 1.5 });
    const clips = (await view(tl.id)).clips as Array<{ id: string; inputs: Record<string, unknown> }>;
    const recipe = t.services.registry.recipe("h3.lipsync")!;
    const planOf = (k: number, raw: Record<string, unknown> = clips[k]!.inputs, finishedFrom: string | null = null) => t.services.timelines.plan(clips[k]!.id, recipe, raw, false, finishedFrom, true);

    // a form reused from a clip of the song (its render's inputs, whole) on the last clip: neither true is kept
    const last = await planOf(2, { ...clips[2]!.inputs, recordingGoesOn: true, recordingLeadIn: true });
    expect([last.input.recordingGoesOn, last.input.recordingLeadIn]).toEqual([false, false]);

    // clip 1's draft rendered with the song going on, then finished by a cut (SeedVR2, RTX, a model: no render of its own)
    const made = { recording: sound, recordingStart: 0, recordingSeconds: 8, speechAt: 0, recordingGoesOn: true };
    await t.db.insertInto("generations").values({ id: "zz-g-run", owner_id: OWNER, recipe_id: "h3.lipsync", recipe_version: 1, family: "h3", inputs: JSON.stringify(made), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    const video = (id: string, generation: string | null, source: string | null) => t.db.insertInto("assets").values(newAssetRow({
      id, kind: "video", origin: generation ? "generated" : "edited", name: `zz-test song ${id}`, file_key: `assets/zz/${id}`, thumb_key: null, mime: "video/mp4", bytes: 1000,
      width: 576, height: 1024, duration_ms: 8687, fps: 24, has_sound: 1, folder_id: null, generation_id: generation, kept_at: now(), source_id: source,
    })).execute();
    await video("zz-v-draft", "zz-g-run", null);
    await video("zz-v-big", null, "zz-v-draft");
    const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    await t.services.timelines.takes.add(clips[0]!.id, await row("zz-v-draft"), { headMs: 0, tailMs: 0 }, {}, null, t.db, "zz-t-draft");
    await t.services.timelines.takes.add(clips[0]!.id, await row("zz-v-big"), { headMs: 0, tailMs: 0 }, {}, "zz-t-draft", t.db, "zz-t-big");
    // the next clip still starts where the draft's song stops, its head sung: read off the finish, it sang 8 to 8.687 again
    const second = await planOf(1);
    expect(second.input.recordingStart).toBeCloseTo(8.687, 3);
    expect(second.input.recordingLeadIn).toBe(true);

    // its words set a moment in (Speech starts at 1.5 s): inside the run that moment does not apply (card #75, review S4). The
    // clip before sang the song up to the part, and those 1.5 s, filed with the recording before it, sang its words twice
    const later = await planOf(1, { ...clips[1]!.inputs, speechAt: 1.5 });
    expect(later.input.recordingStart).toBeCloseTo(8.687, 3);
    expect(later.input.speechAt).toBe(0);
    expect(later.input.recordingLeadIn).toBe(true);
    // the first clip of the song, carrying on from nothing of it, keeps its own
    expect((await planOf(0, { ...clips[0]!.inputs, speechAt: 1.5 })).input.speechAt).toBe(1.5);

    // a finish of clip 2's draft, re-sampled from its latent: the draft's part as it was sent, not planned again (its sound and
    // length are the draft's; planned again from the part it was sent, it no longer met clip 1's and lost its sung head)
    const drafted = { ...clips[1]!.inputs, recordingStart: 8.687, recordingSeconds: 7.313, recordingGoesOn: true, recordingLeadIn: true };
    const finish = await planOf(1, drafted, "zz-some-draft-take");
    expect([finish.input.recordingStart, finish.input.recordingSeconds, finish.input.recordingGoesOn, finish.input.recordingLeadIn]).toEqual([8.687, 7.313, true, true]);
  });

  it("says its pauses, as it is cut at them, and no lines for a file that carries none", async () => {
    const sound = await recording();
    const { pauses, lines } = (await get(t.app, `/api/assets/${sound}/pauses`)).json() as { pauses: Array<{ start: number; end: number }>; lines: unknown[] };
    expect(pauses.map((p) => Math.round(((p.start + p.end) / 2) * 10) / 10)).toEqual([4.7, 10.2]);
    expect(lines).toEqual([]);
  });
});

describe.skipIf(!ffmpegThere)("a voice given to a Lip sync clip by its form", { timeout: FFMPEG_TIMEOUT }, () => {
  // what its Audio cell's drop, its menu's Choose a recording / Open an audio file and its Recording field all send: the
  // clip's form with the recording in it, saved as it is typed
  const lipSync = async (name: string) => {
    const tl = await call("POST", "/api/timelines", { name });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.lipsync" });
    const clip = (await view(tl.id)).clips[0] as { id: string; inputs: Record<string, unknown> };
    return { tl, clip };
  };
  const partOf = async (tl: { id: string }) => {
    const c = (await view(tl.id)).clips[0] as { inputs: Record<string, number> };
    return [c.inputs.recordingStart, c.inputs.recordingSeconds];
  };

  it("takes the whole recording from its start, and the save answers with the form as kept", async () => {
    const { tl, clip } = await lipSync("zz-test voice whole");
    const sound = await recording([tone(7)], 7000);
    const r = await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, description: "A woman talks to the camera.", recording: sound } });
    expect(await partOf(tl)).toEqual([0, 7]);
    expect(r.inputs).toMatchObject({ recording: sound, recordingStart: 0, recordingSeconds: 7, description: "A woman talks to the camera." });
    // the clip lasts as long as its part
    expect((await t.services.timelines.leaves()).find((x) => x.id === tl.id)?.plannedMs).toBe(7000);
  });

  it("takes no more than one clip holds, ended in the pause nearest that (as a recording dropped past the clips is cut)", async () => {
    const { tl, clip } = await lipSync("zz-test voice capped");
    const sound = await recording();
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, recording: sound } });
    const [start, seconds] = await partOf(tl);
    expect(start).toBe(0);
    // 15 s is past the 14.8 one clip holds: cut in the pause at 10.2, not mid-word at 14.8
    expect(Math.abs(seconds! - 10.2)).toBeLessThan(0.1);
  });

  it("changed for another recording, takes that one's part; the form saved again keeps the part as it is", async () => {
    const { tl, clip } = await lipSync("zz-test voice changed");
    const long = await recording();
    const short = await recording([tone(6)], 6000);
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, recording: long } });
    const kept = (await view(tl.id)).clips[0].inputs as Record<string, unknown>;
    // its part set by hand, then the scene typed: left as it is
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...kept, recordingStart: 4.7, recordingSeconds: 5.5 } });
    const r = await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...kept, recordingStart: 4.7, recordingSeconds: 5.5, description: "A man talks." } });
    expect(r.inputs).toBeUndefined();
    expect(await partOf(tl)).toEqual([4.7, 5.5]);
    // another recording, its form sent with the part of the one before: its own part, from 0
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...kept, recordingStart: 4.7, recordingSeconds: 5.5, recording: short } });
    expect(await partOf(tl)).toEqual([0, 6]);
  });

  it("given before its part was worked out (a voice with no length), takes it on its next save, from the start it has", async () => {
    const { tl, clip } = await lipSync("zz-test voice old");
    const sound = await recording([tone(7)], 7000);
    await t.db.updateTable("clips").set({ inputs: JSON.stringify({ ...clip.inputs, recording: sound, recordingStart: 1 }) }).where("id", "=", clip.id).execute();
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, recording: sound, recordingStart: 1, description: "A woman talks." } });
    expect(await partOf(tl)).toEqual([1, 6]);
  });

  it("a little longer than one clip holds, takes as much as it holds: not half of it", async () => {
    const { tl, clip } = await lipSync("zz-test voice a little long");
    // 17 s without a pause: the even share of a row of clips gave this one clip 8.5 s
    const sound = await recording([tone(17)], 17000);
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, recording: sound } });
    const [start, seconds] = await partOf(tl);
    expect(start).toBe(0);
    expect(seconds).toBeCloseTo(14.83, 1);
  });

  it("on a clip in the queue, is refused, with no step to undo; on a clip with a take, keeps the take's part", async () => {
    const { tl, clip } = await lipSync("zz-test voice busy");
    const first = await recording([tone(7)], 7000);
    const other = await recording([tone(6)], 6000);
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...clip.inputs, recording: first } });
    const kept = (await view(tl.id)).clips[0].inputs as Record<string, unknown>;
    const job = newId();
    await t.db.insertInto("jobs").values({ id: job, owner_id: "local", recipe_id: "h3.lipsync", label: "x", inputs: "{}", status: "running", priority: 0, clip_id: clip.id, created_at: now(), updated_at: now() } as never).execute();
    const steps = async () => (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", tl.id).execute()).length;
    const before = await steps();
    // another voice, then its part typed by hand: both refused while it renders
    for (const inputs of [{ ...kept, recording: other }, { ...kept, recordingSeconds: 5 }]) {
      const r = await t.app.inject({ method: "PATCH", url: `/api/clips/${clip.id}`, payload: { inputs } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/rendering or in the queue/);
    }
    expect(await steps()).toBe(before);
    expect(await partOf(tl)).toEqual([0, 7]);
    // the scene typed meanwhile is kept
    await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...kept, description: "A woman talks." } });
    // the render done, with a take: the new voice is set, the take's part kept
    await t.db.updateTable("jobs").set({ status: "done" }).where("id", "=", job).execute();
    const take = newId();
    const video = newId();
    await t.db.insertInto("assets").values(newAssetRow({ id: video, kind: "video", origin: "uploaded", name: "t.mp4", file_key: `assets/zz/${video}`, thumb_key: null, mime: "video/mp4", bytes: 1, width: 480, height: 854, duration_ms: 7000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now() })).execute();
    await t.db.insertInto("takes").values({ id: take, clip_id: clip.id, asset_id: video, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() } as never).execute();
    await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clip.id).execute();
    const r = await call("PATCH", `/api/clips/${clip.id}`, { inputs: { ...kept, description: "A woman talks.", recording: other } });
    expect(r.inputs).toBeUndefined();
    const c = (await view(tl.id)).clips[0] as { inputs: Record<string, unknown> };
    expect(c.inputs).toMatchObject({ recording: other, recordingStart: 0, recordingSeconds: 7 });
  });
});

describe.skipIf(!ffmpegThere)("a clip under a recording, in any H3 form (card #72)", { timeout: FFMPEG_TIMEOUT }, () => {
  type ViewClip = { id: string; recipe: string; inputs: Record<string, unknown> };
  const dropped = async (name: string, parts?: string[], ms?: number) => {
    const tl = await call("POST", "/api/timelines", { name });
    const sound = await recording(parts, ms);
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    return { id: tl.id as string, sound, clips: (await view(tl.id)).clips as ViewClip[] };
  };
  const forms = async (id: string) => ((await view(id)).clips as ViewClip[]).map((c) => c.recipe);

  it("stays one of the recording's when its model changes to Video with audio: its part, its trims, its removal", async () => {
    const { id, sound, clips } = await dropped("zz-test any form");
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { recipe: "h3.video" });
    let v = await view(id);
    expect(v.clips[1].inputs).toMatchObject({ recording: sound, recordingStart: clips[1]!.inputs.recordingStart, recordingSeconds: clips[1]!.inputs.recordingSeconds });
    expect(v.recordings).toEqual([expect.objectContaining({ asset: expect.objectContaining({ id: sound }) })]);
    // the recording's trim reaches it: its end in to 9 s sets the third clip aside and shortens the Video with audio one
    await call("POST", `/api/timelines/${id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 9000 });
    v = await view(id);
    expect(v.clips).toHaveLength(2);
    expect(Number(v.clips[1].inputs.recordingStart) + Number(v.clips[1].inputs.recordingSeconds)).toBeCloseTo(9, 2);
    await call("POST", `/api/timelines/${id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    expect(await forms(id)).toEqual(["h3.lipsync", "h3.video", "h3.lipsync"]);
    // removed from the middle, its part is cut out (set aside, a cut join), as a Lip sync clip's is
    await call("POST", `/api/timelines/${id}/clips/remove`, { ids: [clips[1]!.id] });
    v = await view(id);
    expect(v.clips.map((c: ViewClip) => c.id)).toEqual([clips[0]!.id, clips[2]!.id]);
    expect(v.recordings[0].removed).toHaveLength(1);
  });

  it("refuses a model no clip under a recording takes, with what to do; a clip under none changes freely", async () => {
    const { id, clips } = await dropped("zz-test any form refused");
    const steps = async () => (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", id).execute()).length;
    const before = await steps();
    const res = await t.app.inject({ method: "PATCH", url: `/api/clips/${clips[0]!.id}`, payload: { recipe: "scail.motion" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/under a recording: MiniMax H3 · Lip sync, LTX 2\.3 · Lip sync, LTX 2\.5 · Lip sync, MiniMax H3 · Video with audio, Wan 2\.2 · Video, LTX 2\.3 · Video with audio and LTX 2\.5 · Video with audio go there\. To use another model, remove it from the recording first/);
    expect(await steps()).toBe(before);
    expect(await forms(id)).toEqual(["h3.lipsync", "h3.lipsync", "h3.lipsync"]);
    await call("POST", `/api/timelines/${id}/clips`, { recipe: "h3.video" });
    const free = ((await view(id)).clips as ViewClip[]).at(-1)!;
    await call("PATCH", `/api/clips/${free.id}`, { recipe: "scail.motion" });
    expect((await forms(id)).at(-1)).toBe("scail.motion");
  });

  it("refuses a split of one of its clips, at the playhead or by a range inside it: both halves would keep its whole part (B10)", async () => {
    const { id, clips } = await dropped("zz-test split refused");
    await t.db.insertInto("assets").values(newAssetRow({
      id: "zz-split-v", kind: "video", origin: "generated", name: "zz-test split", file_key: "assets/zz/zz-split-v", thumb_key: null, mime: "video/mp4", bytes: 1000,
      width: 576, height: 1024, duration_ms: 4000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
    })).execute();
    const asset = await t.db.selectFrom("assets").selectAll().where("id", "=", "zz-split-v").executeTakeFirstOrThrow();
    await t.services.timelines.takes.add(clips[0]!.id, asset, { headMs: 0, tailMs: 0 }, {});
    const steps = async () => (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", id).execute()).length;
    const before = await steps();
    const split = await t.app.inject({ method: "POST", url: `/api/clips/${clips[0]!.id}/split`, payload: { atMs: 2000 } });
    expect(split.statusCode).toBe(400);
    expect(split.json().error).toMatch(/one of a recording's: its part of it cannot be split in two/);
    for (const action of ["split", "remove"]) {
      const res = await t.app.inject({ method: "POST", url: `/api/timelines/${id}/range`, payload: { inMs: 1000, outMs: 2000, action } });
      expect(res.statusCode).toBe(400);
    }
    expect(((await view(id)).clips as ViewClip[]).map((c) => c.id)).toEqual(clips.map((c) => c.id));
    expect(await steps()).toBe(before);
  });

  it("keeps its clips in its order: a move past another of them is refused, another clip may go between them (B9)", async () => {
    const { id, clips } = await dropped("zz-test order kept");
    const ids = () => view(id).then((v) => (v.clips as ViewClip[]).map((c) => c.id));
    const steps = async () => (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", id).execute()).length;
    const before = await steps();
    for (const [moved, after] of [[clips[2]!.id, null], [clips[0]!.id, clips[2]!.id], [clips[1]!.id, clips[2]!.id]] as const) {
      const res = await t.app.inject({ method: "PATCH", url: `/api/clips/${moved}`, payload: { after } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/clips of a recording play in its order/);
    }
    expect(await ids()).toEqual(clips.map((c) => c.id));
    expect(await steps()).toBe(before);
    // a clip of its own goes between two of them, and back out
    await call("POST", `/api/timelines/${id}/clips`, { recipe: "h3.video" });
    const free = (await ids()).at(-1)!;
    await call("PATCH", `/api/clips/${free}`, { after: clips[0]!.id });
    expect(await ids()).toEqual([clips[0]!.id, free, clips[1]!.id, clips[2]!.id]);
    await call("PATCH", `/api/clips/${free}`, { after: null });
    expect(await ids()).toEqual([free, ...clips.map((c) => c.id)]);
    // one of them moved where it keeps its place among them goes: the first before the clip of its own
    await call("PATCH", `/api/clips/${clips[0]!.id}`, { after: null });
    expect(await ids()).toEqual([clips[0]!.id, free, clips[1]!.id, clips[2]!.id]);
  });

  it("re-cut, keeps each clip's form where its part survives; a part no clip had takes the recording's New clips form", async () => {
    const { id, sound, clips } = await dropped("zz-test any form re-cut");
    await call("PATCH", `/api/clips/${clips[0]!.id}`, { recipe: "h3.video" });
    await call("PATCH", `/api/clips/${clips[0]!.id}`, { inputs: { ...clips[0]!.inputs, description: "zz-test she listens, her mouth closed" } });
    // about 7 s ± 2.5, in its pauses: [0, 4.7] is clip 1's part (Video with audio), [4.7, 15] clips 2 and 3's (Lip sync)
    await call("POST", `/api/timelines/${id}/recording/cut`, { asset: sound, seconds: 7, window: 2.5 });
    let v = await view(id);
    expect(v.clips.map((c: ViewClip) => c.recipe)).toEqual(["h3.video", "h3.lipsync"]);
    expect(v.clips[0].inputs.description).toBe("zz-test she listens, her mouth closed");
    // New clips set to Video with audio: kept with the cut, and refused for a model none of them is
    await call("POST", `/api/timelines/${id}/recording/new-clips`, { asset: sound, recipe: "h3.video" });
    expect((await view(id)).recordings[0]).toEqual(expect.objectContaining({ seconds: 7, window: 2.5, form: "h3.video" }));
    const wrong = await t.app.inject({ method: "POST", url: `/api/timelines/${id}/recording/new-clips`, payload: { asset: sound, recipe: "scail.motion" } });
    expect(wrong.statusCode).toBe(400);
    // its start moved in to 4.7 s, then back to 0: the part before 4.7 s is new, no clip had it, made in New clips' form
    await call("POST", `/api/timelines/${id}/recording/trim`, { asset: sound, fromMs: 4700, toMs: 15000 });
    expect(await forms(id)).toEqual(["h3.lipsync"]);
    await call("POST", `/api/timelines/${id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    v = await view(id);
    expect(v.clips[0].recipe).toBe("h3.video");
    expect(v.clips.slice(1).every((c: ViewClip) => c.recipe === "h3.lipsync")).toBe(true);
    // a cut again keeps New clips' form; Undo takes the form back with the step that set it
    await call("POST", `/api/timelines/${id}/recording/cut`, { asset: sound, seconds: 6, window: 0 });
    expect((await view(id)).recordings[0]).toEqual(expect.objectContaining({ seconds: 6, window: 0, form: "h3.video" }));
  });

  it("gives what its clips share to each clip whose form has it: Speech starts at to Lip sync only, Even out the loudness to all", async () => {
    const { id, sound, clips } = await dropped("zz-test any form shared");
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { recipe: "h3.video" });
    await call("POST", `/api/timelines/${id}/recording/form`, { asset: sound, inputs: { description: "zz-test a room with a piano", speechAt: 0.5, evenLoudness: false } });
    const v = (await view(id)).clips as ViewClip[];
    expect(v.map((c) => c.inputs.description)).toEqual(Array(3).fill("zz-test a room with a piano"));
    expect(v.map((c) => c.inputs.speechAt)).toEqual([0.5, undefined, 0.5]);
    expect(v.map((c) => c.inputs.evenLoudness)).toEqual([false, false, false]);
  });

  it("hands a song on across a Video with audio clip: its tail is the recording, and the clip after starts where it stops playing", async () => {
    const { id, sound } = await dropped("zz-test any form song", [tone(24)], 24000);
    await call("POST", `/api/timelines/${id}/recording/cut`, { asset: sound, seconds: 8, window: 1.5 });
    const clips = (await view(id)).clips as ViewClip[];
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { recipe: "h3.video" });
    const recipeOf = (k: number) => t.services.registry.recipe(k === 1 ? "h3.video" : "h3.lipsync")!;
    const planOf = (k: number) => t.services.timelines.plan(clips[k]!.id, recipeOf(k), clips[k]!.inputs, false, null, true);
    // the recording goes on into the Video with audio clip, and out of it into the third
    expect((await planOf(0)).input.recordingGoesOn).toBe(true);
    const middle = await planOf(1);
    // its part 8 s on, 7.79 s long: after its run-up, a whole number of H3's 17-frame steps (11 of them)
    expect(middle.input).toMatchObject({ recording: sound, recordingStart: 8, recordingSeconds: 7.79, recordingGoesOn: true, recordingLeadIn: false });
    // it is never sent a moment before the words: its form has none
    expect(middle.input).not.toHaveProperty("speechAt");

    // the Video with audio clip rendered with the song going on, 8.687 s long: the third starts where it stops, still ending at 24
    const made = { recording: sound, recordingStart: 8, recordingSeconds: 8, recordingGoesOn: true };
    await t.db.insertInto("generations").values({ id: "zz-g-over", owner_id: OWNER, recipe_id: "h3.video", recipe_version: 2, family: "h3", inputs: JSON.stringify(made), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    await t.db.insertInto("assets").values(newAssetRow({
      id: "zz-v-over", kind: "video", origin: "generated", name: "zz-test song over", file_key: "assets/zz/zz-v-over", thumb_key: null, mime: "video/mp4", bytes: 1000,
      width: 576, height: 1024, duration_ms: 8687, fps: 24, has_sound: 1, folder_id: null, generation_id: "zz-g-over", kept_at: now(),
    })).execute();
    const asset = await t.db.selectFrom("assets").selectAll().where("id", "=", "zz-v-over").executeTakeFirstOrThrow();
    await t.services.timelines.takes.add(clips[1]!.id, asset, { headMs: 0, tailMs: 0 }, {});
    const third = await planOf(2);
    expect(third.input.recordingStart).toBeCloseTo(16.687, 3);
    expect(Number(third.input.recordingStart) + Number(third.input.recordingSeconds)).toBeCloseTo(24, 3);
    expect(third.input.recordingLeadIn).toBe(true);
    // its take says its sound is the recording laid after its head, as a Lip sync take's
    expect((await view(id)).clips[1].take).toMatchObject({ laidSound: true });
  });

  it("takes Wan as a form the recording plays over (card #82): its part, a re-cut keeping it, the song handed on across it", async () => {
    const { id, sound } = await dropped("zz-test any form wan", [tone(24)], 24000);
    await call("POST", `/api/timelines/${id}/recording/cut`, { asset: sound, seconds: 8, window: 1.5 });
    let clips = (await view(id)).clips as ViewClip[];
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { recipe: "wan.video" });
    clips = (await view(id)).clips as ViewClip[];
    expect(clips.map((c) => c.recipe)).toEqual(["h3.lipsync", "wan.video", "h3.lipsync"]);
    expect(clips[1]!.inputs).toMatchObject({ recording: sound, recordingStart: 8, recordingSeconds: 7.79 });
    // the recording goes on into the Wan clip and out of it into the third
    const recipeOf = (k: number) => t.services.registry.recipe(k === 1 ? "wan.video" : "h3.lipsync")!;
    const planOf = (k: number) => t.services.timelines.plan(clips[k]!.id, recipeOf(k), clips[k]!.inputs, false, null, true);
    expect((await planOf(0)).input.recordingGoesOn).toBe(true);
    expect((await planOf(1)).input).toMatchObject({ recording: sound, recordingStart: 8, recordingSeconds: 7.79, recordingGoesOn: true });
    // a re-cut keeps it where its part survives
    await call("POST", `/api/timelines/${id}/recording/cut`, { asset: sound, seconds: 8, window: 0 });
    expect(((await view(id)).clips as ViewClip[]).map((c) => c.recipe)).toEqual(["h3.lipsync", "wan.video", "h3.lipsync"]);
    // and New clips can be made in it
    await call("POST", `/api/timelines/${id}/recording/new-clips`, { asset: sound, recipe: "wan.video" });
    expect((await view(id)).recordings[0]).toEqual(expect.objectContaining({ form: "wan.video" }));
  });
});

describe.skipIf(!ffmpegThere)("LTX under a recording (card #2)", { timeout: FFMPEG_TIMEOUT }, () => {
  type ViewClip = { id: string; recipe: string; joined: string; inputs: Record<string, number | string> };
  const clipsOf = async (id: string) => (await view(id)).clips as ViewClip[];

  it("a recording dropped on an LTX clip is cut into LTX Lip sync clips, its New clips form, each carrying on from the one before", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test ltx lip sync" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx.video" });
    const [empty] = await clipsOf(tl.id);
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: empty!.id });
    let clips = await clipsOf(tl.id);
    expect(clips.map((c) => c.recipe)).toEqual(["ltx.lipsync", "ltx.lipsync", "ltx.lipsync"]);
    expect(clips.map((c) => c.joined)).toEqual(["cut", "continue", "continue"]);
    for (const c of clips) expect(c.inputs.recording).toBe(sound);
    // kept as its New clips form: its panel says it, and a re-cut makes new parts in it
    expect((await view(tl.id)).recordings[0]).toEqual(expect.objectContaining({ form: "ltx.lipsync" }));
    // one played over by LTX's Video with audio stays the recording's, and H3 can be picked under it too
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { recipe: "ltx.video" });
    await call("PATCH", `/api/clips/${clips[2]!.id}`, { recipe: "h3.lipsync" });
    clips = await clipsOf(tl.id);
    expect(clips.map((c) => c.recipe)).toEqual(["ltx.lipsync", "ltx.video", "h3.lipsync"]);
    expect(clips[1]!.inputs).toMatchObject({ recording: sound, recordingStart: clips[1]!.inputs.recordingStart });
    // the song's way through them: the plan hands the recording on from the Lip sync clip into the one it plays over
    const recipeOf = (r: string) => t.services.registry.recipe(r)!;
    const planOf = (k: number) => t.services.timelines.plan(clips[k]!.id, recipeOf(clips[k]!.recipe), clips[k]!.inputs, false, null, true);
    expect((await planOf(1)).input).toMatchObject({ recording: sound, recordingSeconds: clips[1]!.inputs.recordingSeconds });
  });

  it("cuts by what one clip of the New clips form holds; a recording dropped after an H3 clip still makes H3's", async () => {
    // one stretch of words 16 s long, no pause: H3's clip holds 14.83 s of it, LTX 2.3's 14.76 s
    const tl = await call("POST", "/api/timelines", { name: "zz-test ltx cut" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx.video" });
    const [empty] = await clipsOf(tl.id);
    const sound = await recording([tone(16)], 16000);
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: empty!.id, seconds: 15 });
    const first = (await clipsOf(tl.id))[0]!;
    expect(first.recipe).toBe("ltx.lipsync");
    expect(Number(first.inputs.recordingSeconds)).toBeLessThanOrEqual(377 / 25 - 0.32 + 1e-9);
    const h3 = await call("POST", "/api/timelines", { name: "zz-test h3 cut" });
    await call("POST", `/api/timelines/${h3.id}/clips`, { recipe: "h3.video" });
    await call("POST", `/api/timelines/${h3.id}/recording`, { asset: sound });
    const made = (await clipsOf(h3.id)).map((c) => c.recipe);
    expect(made[0]).toBe("h3.video");
    expect(new Set(made.slice(1))).toEqual(new Set(["h3.lipsync"]));
  });
});

describe.skipIf(!ffmpegThere)("a recording dropped on an empty clip of another form (card #2)", { timeout: FFMPEG_TIMEOUT }, () => {
  type ViewClip = { id: string; recipe: string; inputs: Record<string, unknown> };
  const clipsOf = async (id: string) => (await view(id)).clips as ViewClip[];

  // Video with audio becomes Lip sync under the recording: what was written in the clip goes with it
  it.each([
    ["h3.video", "h3.lipsync", "description"],
    ["ltx.video", "ltx.lipsync", "prompt"],
    ["ltx25.video", "ltx25.lipsync", "prompt"],
  ])("%s becomes %s with its scene, model, LoRAs and settings, the first part its seed", async (was, becomes, scene) => {
    const tl = await call("POST", "/api/timelines", { name: `zz-test drop on ${was}` });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: was });
    const [empty] = await clipsOf(tl.id);
    const written = { [scene]: "A woman talks to the camera in a kitchen.", model: "zz-test-model.safetensors", loras: [{ file: "zz-test-lora.safetensors", weight: 0.6 }], seed: 4242, steps: 12 };
    await call("PATCH", `/api/clips/${empty!.id}`, { inputs: written });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: empty!.id });
    const clips = await clipsOf(tl.id);
    expect(clips.map((c) => c.recipe)).toEqual([becomes, becomes, becomes]);
    const { seed, ...shared } = written;
    for (const c of clips) expect(c.inputs).toMatchObject({ ...shared, recording: sound });
    expect(clips[0]!.inputs.seed).toBe(seed);
    for (const c of clips.slice(1)) expect(c.inputs.seed).not.toBe(seed);
  });

  it("dropped on another family's clip keeps only its words: the model and LoRAs are of no use there", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test drop across families" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx.video" });
    const [first] = await clipsOf(tl.id);
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: first!.id });
    // its New clips form is now LTX's Lip sync: a drop on an empty H3 clip after them makes LTX clips
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" });
    const h3 = (await clipsOf(tl.id)).at(-1)!;
    await call("PATCH", `/api/clips/${h3.id}`, { inputs: { description: "A man waves from a boat.", model: "zz-test-h3.safetensors", seed: 7 } });
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: h3.id });
    const made = (await clipsOf(tl.id)).slice(3);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((c) => c.recipe === "ltx.lipsync")).toBe(true);
    expect(made[0]!.inputs.model).not.toBe("zz-test-h3.safetensors");
  });
});

describe.skipIf(!ffmpegThere)("a clip added past a recording's end (card #88)", { timeout: FFMPEG_TIMEOUT }, () => {
  type ViewClip = { id: string; recipe: string; joined: string; inputs: Record<string, unknown> };
  const clipsOf = async (id: string) => (await view(id)).clips as ViewClip[];
  const PLACE = ["recording", "recordingStart", "recordingSeconds", "recordingGoesOn", "recordingLeadIn"];
  const placeOf = (c: ViewClip) => Object.fromEntries(PLACE.filter((k) => k in c.inputs).map((k) => [k, c.inputs[k]]));

  it("after the recording's last clip is a plain clip of its family: not under the recording, the Lip sync clip's settings kept", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test past the end" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    const before = await clipsOf(tl.id);
    await call("PATCH", `/api/clips/${before[2]!.id}`, { inputs: { ...before[2]!.inputs, steps: 13 } });
    await call("POST", `/api/timelines/${tl.id}/clips`, {});
    const clips = await clipsOf(tl.id);
    expect(clips).toHaveLength(4);
    const added = clips[3]!;
    expect(added.recipe).toBe("h3.video");
    expect(placeOf(added)).toEqual({});
    expect(added.inputs.steps).toBe(13);
    expect(added.joined).toBe("continue");
    // the recording's clips are the three it was cut into, and the new one plans no part of it
    const v = await view(tl.id);
    expect(v.clips.filter((c: ViewClip) => c.inputs.recording === sound)).toHaveLength(3);
    const planned = await t.services.timelines.plan(added.id, t.services.registry.recipe(added.recipe)!, added.inputs, false, null, true);
    expect(planned.input.recording).toBeUndefined();
  });

  it("asked for in Lip sync by name, is Lip sync with no recording yet", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test past the end, lip sync" });
    const sound = await recording();
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.lipsync" });
    const added = (await clipsOf(tl.id))[3]!;
    expect(added.recipe).toBe("h3.lipsync");
    expect(placeOf(added)).toEqual({});
  });

  it("after an LTX 2.5 Lip sync clip (Timeline 10's case) is LTX 2.5's Video with audio, the cast's pictures kept, no recording", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test ltx 2.5 past the end" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx25.video" });
    const [empty] = await clipsOf(tl.id);
    const sound = await recording([tone(7)], 7000);
    await call("POST", `/api/timelines/${tl.id}/recording`, { asset: sound, clip: empty!.id });
    const [lip] = await clipsOf(tl.id);
    expect(lip!.recipe).toBe("ltx25.lipsync");
    const references = [{ asset: "zz-test-person", role: "person" }];
    await call("PATCH", `/api/clips/${lip!.id}`, { inputs: { ...lip!.inputs, references } });
    // "Extend from this frame" and the end column's + both add a clip after it
    await call("POST", `/api/timelines/${tl.id}/clips`, { after: lip!.id });
    const added = (await clipsOf(tl.id))[1]!;
    expect(added.recipe).toBe("ltx25.video");
    expect(placeOf(added)).toEqual({});
    expect(added.inputs.references).toEqual(references);
    expect((await view(tl.id)).recordings[0].asset.id).toBe(sound);
  });

  it("a voice sample taken off an LTX 2.5 Video with audio clip is gone from its next job", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test voice off" });
    await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx25.video" });
    const [clip] = await clipsOf(tl.id);
    const voice = await recording([tone(5)], 5000);
    await call("PATCH", `/api/clips/${clip!.id}`, { inputs: { ...clip!.inputs, prompt: "zz-test a woman talks", voice } });
    const recipe = t.services.registry.recipe("ltx25.video")!;
    let c = (await clipsOf(tl.id))[0]!;
    expect((await t.services.timelines.plan(c.id, recipe, c.inputs, false, null, true)).input.voice).toBe(voice);
    // the form's slot emptied, as its × sends it: the key left out
    const { voice: _gone, ...rest } = c.inputs;
    await call("PATCH", `/api/clips/${c.id}`, { inputs: rest });
    c = (await clipsOf(tl.id))[0]!;
    expect(c.inputs.voice).toBeUndefined();
    const planned = await t.services.timelines.plan(c.id, recipe, c.inputs, false, null, true);
    expect(planned.input.voice).toBeUndefined();
    expect(planned.input.recording).toBeUndefined();
  });
});
