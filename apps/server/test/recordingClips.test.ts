import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, makeApp, type TestApp } from "./helpers";

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
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();

/** 15 s: words to 4.5 s, a pause to 4.9, words to 10.0, a pause to 10.4, words to the end. */
async function recording(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zz-test-recording-"));
  try {
    const out = join(dir, "talk.wav");
    const tone = (s: number) => `sine=frequency=220:duration=${s}`;
    const quiet = (s: number) => `anullsrc=r=48000:cl=mono,atrim=duration=${s}`;
    const parts = [tone(4.5), quiet(0.4), tone(5.1), quiet(0.4), tone(4.6)];
    const inputs = parts.flatMap((p) => ["-f", "lavfi", "-i", p]);
    const filter = `${parts.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`).join(";")};${parts.map((_, k) => `[a${k}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", out]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}`;
    await t.services.storage.put(key, new Uint8Array(readFileSync(out)));
    await t.db.insertInto("assets").values(newAssetRow({
      id, kind: "audio", origin: "uploaded", name: "zz-test talking.wav", file_key: key, thumb_key: null, mime: "audio/wav", bytes: 1000,
      width: null, height: null, duration_ms: 15000, fps: null, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
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
    // cut in the middle of each pause (4.7 and 10.2 s), within a tenth
    const parts = v.clips.map((c: { inputs: Record<string, number> }) => [c.inputs.recordingStart, c.inputs.recordingSeconds]);
    expect(parts[0][0]).toBe(0);
    expect(Math.abs(parts[1][0] - 4.7)).toBeLessThan(0.1);
    expect(Math.abs(parts[2][0] - 10.2)).toBeLessThan(0.1);
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
    // the clip set aside made to end at 13 s (as if cut shorter), so that the end out at 15 s goes past it
    const row = await t.db.selectFrom("timelines").select("recordings").where("id", "=", tl.id).executeTakeFirstOrThrow();
    const parked = JSON.parse(row.recordings!) as Record<string, Array<{ clip: { inputs: string } }>>;
    const inputs = JSON.parse(parked[sound]![0]!.clip.inputs) as Record<string, number>;
    parked[sound]![0]!.clip.inputs = JSON.stringify({ ...inputs, recordingSeconds: Math.round((13 - inputs.recordingStart!) * 100) / 100 });
    await t.db.updateTable("timelines").set({ recordings: JSON.stringify(parked) }).where("id", "=", tl.id).execute();
    const r = await call("POST", `/api/timelines/${tl.id}/recording/trim`, { asset: sound, fromMs: 0, toMs: 15000 });
    expect(r.clips).toHaveLength(1);
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([...clips, ...r.clips]);
    expect(v.undo).toBe("the recording made longer");
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips.map((c: { id: string }) => c.id)).toEqual(clips.slice(0, 2));
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
});
