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
});
