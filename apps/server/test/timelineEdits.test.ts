import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { makePng } from "@afflatus/comfy/testing";
import { wan } from "../../../packages/workflows/test/fixtures";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, post, until, type TestApp } from "./helpers";
import { frames, nodes, timelineSteps, timelineSuite } from "./timelineKit";

/** A timeline worked on: what is put on it, exported, mixed, undone, moved and stopped (timelines.test.ts renders its clips). */

const s = timelineSuite();
const { call, view, finish, render, twoClips, exported } = timelineSteps(s);
// the tests read the app, the pretend ComfyUI and the clips by these names, as the suite's hooks set them
let fake: FakeComfy;
let t: TestApp;
let three: Uint8Array;
let tone: Uint8Array;
beforeAll(() => void ({ three, tone } = s.clips ?? {}));
beforeEach(() => void ({ fake, t } = s));

describe.skipIf(!ffmpegThere)("a timeline", { timeout: FFMPEG_TIMEOUT }, () => {
  it("puts a video from the library on the timeline as it is, and a picture as a clip that opens on it", async () => {
    const { id } = await twoClips();
    const first = (await view(id)).clips[1].take.asset.id;
    const tl = await call("POST", "/api/timelines", {});
    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: first })).timeline.clips[0];
    // it was made by afflatus: it comes with its form and the part of it that repeats another clip stays skipped
    expect(c).toMatchObject({ joined: "cut", recipe: "h3.video", inputs: { description: "She walks to the window." }, take: { headMs: 917 } });
    expect(c.inputs.previous).toBeUndefined();

    const frame = await call("POST", `/api/assets/${first}/frame`, { atMs: 1000 });
    expect(frame).toMatchObject({ kind: "image", origin: "frame", width: 192, height: 320, kept: true });
    // a box's working frame (Make the picture): out of the library, not kept, the same one for the same moment
    const working = await call("POST", `/api/assets/${first}/frame`, { atMs: 1000, once: true, scratch: true });
    expect(working).toMatchObject({ origin: "scratch", kept: false, folderId: null });
    expect((await call("POST", `/api/assets/${first}/frame`, { atMs: 1000, once: true, scratch: true })).id).toBe(working.id);
    expect(working.id).not.toBe(frame.id);
    const d = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: frame.id, as: "clip" })).timeline.clips[1];
    expect(d).toMatchObject({ kind: "video", joined: "cut", recipe: "h3.video", take: null, inputs: { start: frame.id } });
  });

  const upload = async (bytes: Uint8Array, type: string, name: string) => {
    const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": type }, payload: Buffer.from(bytes) });
    if (res.statusCode >= 400) throw new Error(res.body);
    return res.json();
  };

  it("is exported as one video: what plays of each clip, one after the other", async () => {
    const { id } = await twoClips();
    const out = await exported(id);
    expect(out).toMatchObject({ kind: "video", origin: "exported", name: "Evening", width: 192, height: 320, hasSound: true, kept: true });
    expect(Math.abs(out.durationMs - (6000 - 917))).toBeLessThan(120);
    // it went through the queue, where it shows as an export and needs no ComfyUI
    const recent = (await get(t.app, "/api/queue")).json().recent;
    expect(recent[0]).toMatchObject({ kind: "export", label: "Evening · export", status: "done" });
  });

  it("is exported larger when asked, and while the queue is paused: an export does not use the GPU", async () => {
    const { id } = await twoClips();
    await call("POST", "/api/queue/pause");
    const out = await exported(id, { scale: 2 });
    expect(out).toMatchObject({ width: 384, height: 640 });
  });

  it("is exported with smooth motion when asked: twice the pictures a second, worked out without the GPU", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Smooth" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const out = await exported(tl.id, { smooth: true });
    expect(out.fps).toBe(48);
    const bytes = new Uint8Array((await t.app.inject({ method: "GET", url: `/api/assets/${out.id}/file` })).rawPayload);
    // the filter gives up the last few pictures, which have nothing after them to work from
    expect(Math.abs(frames(bytes) - 144)).toBeLessThanOrEqual(4);
  });

  it("makes a clip pass through a picture at the moment it is pinned to", async () => {
    const { id } = await twoClips();
    const from = (await view(id)).clips[0].take.asset.id;
    const picture = (await call("POST", `/api/assets/${from}/frame`, { atMs: 1000 })).id as string;
    const tl = await call("POST", "/api/timelines", {});
    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: c, input: { description: "She turns around.", mid: picture, midAt: 1.5 } }] });
    const graph = await finish(three!, 3);
    const guides = nodes(graph, "MiniMaxH3AddGuide");
    expect(guides).toHaveLength(1);
    // 1.5 s at 24 pictures a second
    expect(guides[0]!.inputs.frame_idx).toBe(36);
    expect(nodes(graph, "LoadImage")).toHaveLength(1);
    // the picture is among what the take was made from
    const made = (await view(tl.id)).clips[0].take.asset.id;
    const detail = (await get(t.app, `/api/assets/${made}`)).json();
    expect(detail.sources.map((x: { asset: { id: string } }) => x.asset.id)).toContain(picture);
  });

  it("takes the folder of the first material dropped on it, until a folder is chosen", async () => {
    const holiday = (await call("POST", "/api/folders", { name: "Holiday" })).id as string;
    const other = (await call("POST", "/api/folders", { name: "Other" })).id as string;
    const beach = await upload(makePng(192, 320, [200, 120, 40], [40, 60, 160]), "image/png", "beach.png");
    const dune = await upload(makePng(192, 320, [10, 10, 10], [90, 90, 90]), "image/png", "dune.png");
    await call("POST", "/api/assets/move", { ids: [beach.id], folderId: holiday });
    await call("POST", "/api/assets/move", { ids: [dune.id], folderId: other });
    const tl = await call("POST", "/api/timelines", { name: "Holiday film" });
    expect(tl).toMatchObject({ folderId: null, folderChosen: false });
    // the first picture dropped: its folder becomes the timeline's; the next one from elsewhere does not change it
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: beach.id });
    expect(await view(tl.id)).toMatchObject({ folderId: holiday, folderChosen: false });
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: dune.id });
    expect((await view(tl.id)).folderId).toBe(holiday);
    // chosen by hand: back to the root, and nothing dropped later moves it
    await call("PATCH", `/api/timelines/${tl.id}`, { folder: null });
    expect(await view(tl.id)).toMatchObject({ folderId: null, folderChosen: true });
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: beach.id });
    expect((await view(tl.id)).folderId).toBeNull();
  });

  it("holds a picture on screen as a still, and a clip after it opens on that picture", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Stills" });
    const picture = await upload(makePng(192, 320, [200, 120, 40], [40, 60, 160]), "image/png", "terrace.png");
    const added = await call("POST", `/api/timelines/${tl.id}/clips`, { asset: picture.id });
    expect(added.timeline.clips[0]).toMatchObject({ kind: "still", lengthMs: 3000, still: { id: picture.id }, take: null, recipe: null });
    expect(added.timeline.durationMs).toBe(3000);
    await call("PATCH", `/api/clips/${added.clip}`, { stillMs: 1500 });
    expect((await view(tl.id)).clips[0].lengthMs).toBe(1500);

    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: c }]);
    const graph = await finish(three!, 1);
    // the clip opens on the picture: it is its first frame, no clip to join onto
    expect(nodes(graph, "LoadImage")).toHaveLength(1);
    expect(nodes(graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    const v = await view(tl.id);
    expect(v.clips[1]).toMatchObject({ join: "fresh", atMs: 1500 });
    // the picture is replaced: the clip no longer follows it
    const other = await upload(makePng(192, 320, [10, 10, 10], [90, 90, 90]), "image/png", "night.png");
    await call("DELETE", `/api/clips/${added.clip}`);
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: other.id, after: null });
    expect((await view(tl.id)).clips[1].join).toBe("stale");

    const out = await exported(tl.id);
    expect(Math.abs(out.durationMs - 6000)).toBeLessThan(150);
    // a still can become a clip to render, opening on its picture
    const still = (await view(tl.id)).clips[0].id;
    await call("PATCH", `/api/clips/${still}`, { animate: true });
    expect((await view(tl.id)).clips[0]).toMatchObject({ kind: "video", recipe: "h3.video", inputs: { start: other.id }, still: null });
  });

  it("mixes a clip's sound file and the music into the export, and mutes what is muted", async () => {
    const { id, a, b } = await twoClips();
    const sound = await upload(tone!, "audio/wav", "tone.wav");
    expect(sound).toMatchObject({ kind: "audio", mime: "audio/wav", hasSound: true, name: "tone.wav" });
    expect(sound.durationMs).toBeGreaterThan(3900);
    await call("PATCH", `/api/clips/${a}`, { soundAsset: sound.id, volume: 50 });
    await call("PATCH", `/api/clips/${b}`, { sound: "muted", fill: true });
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: sound.id, volume: 40, fadeInMs: 500, fadeOutMs: 500, duck: true } });
    const v = await view(id);
    expect(v.clips[0]).toMatchObject({ sound: "file", soundAsset: { id: sound.id }, volume: 50 });
    expect(v.clips[1]).toMatchObject({ sound: "muted", fill: true });
    expect(v.music).toMatchObject({ asset: { id: sound.id }, volume: 40, fadeInMs: 500, duck: true });
    // the music dips under the sound of the first clip (a tone in the voice band) by the depth asked, the curve the player follows
    await call("PATCH", `/api/timelines/${id}`, { music: { duckDb: 12 } });
    expect((await view(id)).music).toMatchObject({ duck: true, duckDb: 12 });
    const { curve } = (await get(t.app, `/api/timelines/${id}/duck`)).json() as { curve: { rate: number; gains: number[] } };
    expect(curve.rate).toBe(20);
    expect(Math.min(...curve.gains.slice(0, 20))).toBeCloseTo(10 ** (-12 / 20), 1);
    expect(curve.gains.at(-1)).toBeGreaterThan(0.9);
    const out = await exported(id);
    expect(out).toMatchObject({ hasSound: true });
    expect(Math.abs(out.durationMs - (6000 - 917))).toBeLessThan(120);
    // without the music, and with the music removed
    expect(await exported(id, { music: false })).toMatchObject({ hasSound: true });
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: null } });
    expect((await view(id)).music).toBeNull();
    // a picture is not a sound
    const picture = await upload(makePng(64, 64, [1, 2, 3], [4, 5, 6]), "image/png", "p.png");
    expect((await t.app.inject({ method: "PATCH", url: `/api/clips/${a}`, payload: { soundAsset: picture.id } })).statusCode).toBe(400);
  });

  it("plays the part of the song asked, from the clip asked, with each clip's own music under it, undone like any change", async () => {
    const { id, a, b } = await twoClips();
    const song = await upload(tone!, "audio/wav", "tone.wav");
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: song.id } });
    expect((await view(id)).music).toMatchObject({ fromMs: 0, startClip: null });
    // on tenths of a second, within the song; from the second clip on
    await call("PATCH", `/api/timelines/${id}`, { music: { fromMs: 1234, startClip: b } });
    let v = await view(id);
    expect(v.music).toMatchObject({ fromMs: 1200, startClip: b });
    expect(v.undo).toBe("the part of the song");
    await call("PATCH", `/api/timelines/${id}`, { music: { fromMs: 60_000 } });
    expect((await view(id)).music.fromMs).toBeLessThanOrEqual(song.durationMs);
    await call("PATCH", `/api/timelines/${id}`, { music: { fromMs: 500 } });
    expect((await t.app.inject({ method: "PATCH", url: `/api/timelines/${id}`, payload: { music: { startClip: "nope" } } })).statusCode).toBe(404);
    // what a clip asks of the music under it: only what differs from the rest is kept
    await call("PATCH", `/api/clips/${b}`, { music: { volume: 40, duck: "strong", fadeIn: true, muted: false } });
    await call("PATCH", `/api/clips/${a}`, { music: { volume: 100 } });
    v = await view(id);
    expect(v.clips[1].music).toEqual({ volume: 40, duck: "strong", fadeIn: true });
    expect(v.clips[0].music).toBeNull();
    expect(v.undo).toBe("the music under the clip");
    // the second clip ducks strong although the music does not duck elsewhere: a curve, at 0 dB where nothing ducks
    await call("PATCH", `/api/timelines/${id}`, { music: { duck: false } });
    const { curve } = (await get(t.app, `/api/timelines/${id}/duck`)).json() as { curve: { rate: number; gains: number[] } | null };
    expect(curve).not.toBeNull();
    expect(curve!.gains[0]).toBe(1);
    await call("PATCH", `/api/clips/${b}`, { music: { muted: true } });
    expect((await view(id)).clips[1].music).toEqual({ muted: true });
    expect(await exported(id)).toMatchObject({ hasSound: true });
    // back, one step at a time
    await call("POST", `/api/timelines/${id}/undo`);
    await call("POST", `/api/timelines/${id}/undo`);
    expect((await view(id)).clips[1].music).toEqual({ volume: 40, duck: "strong", fadeIn: true });
    for (let i = 0; i < 4; i++) await call("POST", `/api/timelines/${id}/undo`);
    v = await view(id);
    expect(v.clips[1].music).toBeNull();
    expect(v.music).toMatchObject({ fromMs: 1200, startClip: b });
  });

  it("takes changes back one at a time, without losing what was rendered since", async () => {
    const { id, a, b } = await twoClips();
    expect((await view(id)).undo).toBe("the clip added");
    await call("PATCH", `/api/clips/${a}`, { trimEndMs: 1000 });
    await call("PATCH", `/api/clips/${b}`, { after: null });
    await call("DELETE", `/api/clips/${a}`);
    let v = await view(id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([b]);
    expect(v.undo).toBe("the clip removed");

    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the clip removed");
    v = await view(id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([b, a]);
    // the clip is back with its take and its length
    expect(v.clips[1]).toMatchObject({ lengthMs: 2000, take: { trimEndMs: 1000 } });
    await call("POST", `/api/timelines/${id}/undo`);
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([a, b]);

    // a take rendered after a change survives undoing that change, and goes on playing
    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    await render(id, [{ id: b }]);
    await finish(three!, 3);
    const playing = (await view(id)).clips[1].take.id;
    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the cut");
    v = await view(id);
    expect(v.clips[1]).toMatchObject({ joined: "continue", take: { id: playing } });
    expect(v.clips[1].takes).toHaveLength(2);
    // what is written in a clip's form in one go is one step, however many times it was saved on the way
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "Something" } });
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "Something else." } });
    expect((await view(id)).undo).toBe("the parameters of clip 1");
    await call("POST", `/api/timelines/${id}/undo`);
    v = await view(id);
    // the form was empty before (the test renders with its own words)
    expect(v.clips[0].inputs.description).toBeUndefined();
    expect(v.undo).toBe("the new duration");
  });

  it("shows a clip's frames side by side for the track, and takes videos from the computer", async () => {
    const { id } = await twoClips();
    const video = (await view(id)).clips[0].take.asset.id;
    const strip = await get(t.app, `/api/assets/${video}/strip`);
    expect(strip.statusCode).toBe(200);
    expect(strip.headers["content-type"]).toBe("image/jpeg");
    expect(strip.rawPayload.length).toBeGreaterThan(500);
    const own = await upload(three!, "video/mp4", "holiday.mp4");
    expect(own).toMatchObject({ kind: "video", origin: "uploaded", mime: "video/mp4", width: 192, height: 320, hasSound: true, kept: true });
    const c = (await call("POST", `/api/timelines/${id}/clips`, { asset: own.id })).timeline.clips[2];
    expect(c).toMatchObject({ kind: "video", recipe: null, joined: "cut", lengthMs: 3000 });
    expect((await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "video/mp4" }, payload: Buffer.from([1, 2, 3, 4]) })).statusCode).toBe(400);
  });

  it("moves, removes and renames", async () => {
    const { id, a, b } = await twoClips();
    await call("PATCH", `/api/clips/${b}`, { after: null });
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([b, a]);
    const take = (await view(id)).clips[0].take.id;
    await call("DELETE", `/api/takes/${take}`);
    expect((await view(id)).clips[0].take).toBeNull();
    await call("DELETE", `/api/clips/${b}`);
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([a]);
    expect((await call("PATCH", `/api/timelines/${id}`, { name: "Night" })).name).toBe("Night");
    await call("DELETE", `/api/timelines/${id}`);
    expect((await get(t.app, `/api/timelines/${id}`)).statusCode).toBe(404);
    // the video of the take that was removed went to the bin with it; the one of the clip that was removed stays in the library
    expect((await get(t.app, "/api/assets?kind=video")).json().items).toHaveLength(1);
  });

  it("stops a clip's render from the timeline: nothing is added, the take it had still plays, and it is not called a failure", async () => {
    const { id, a } = await twoClips();
    const before = (await view(id)).clips[0].take.id as string;
    await render(id, [{ id: a }], "She turns round.");
    await until(() => fake.prompts.size === 3);
    const job = (await view(id)).clips[0].job as { id: string; status: string };
    expect(job.status).toBe("running");
    // ComfyUI started it: only then is it interrupted (an older ComfyUI's /interrupt stops whatever runs)
    const sent = [...fake.prompts.keys()].at(-1)!;
    fake.pending = fake.pending.filter((p) => p !== sent);
    fake.running = [sent];
    await call("POST", `/api/jobs/${job.id}/cancel`);
    await until(async () => (await view(id)).clips[0].job === null);
    const clip = (await view(id)).clips[0];
    expect(clip).toMatchObject({ job: null, failed: null });
    expect(clip.take.id).toBe(before);
    expect(clip.takes).toHaveLength(1);
    // ComfyUI was told to stop
    expect(fake.calls.some((c) => c.startsWith("POST /interrupt"))).toBe(true);
  });

  it("keeps a clip's conversation with the designer and what it is held with, without that being a change to undo", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Talk" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    const before = (await view(tl.id)).undo;
    await call("PATCH", `/api/clips/${clip}`, { designer: { llm: "big", instruction: "film" }, chat: [{ role: "user", content: "a walk" }] });
    expect((await view(tl.id)).clips[0]).toMatchObject({ designer: { llm: "big", instruction: "film" }, chat: [{ role: "user", content: "a walk" }] });
    // starting over empties the conversation and keeps what it is held with
    await call("PATCH", `/api/clips/${clip}`, { chat: [] });
    expect((await view(tl.id)).clips[0]).toMatchObject({ designer: { llm: "big", instruction: "film" }, chat: [] });
    expect((await view(tl.id)).undo).toBe(before);
  });

  it("sends the video of a removed take to the bin, brings both back with Undo, and leaves alone a video brought in from the library", async () => {
    const { id } = await twoClips();
    const videos = async () => ((await get(t.app, "/api/assets?kind=video")).json().items as Array<{ id: string }>).map((v) => v.id);
    const inBin = async (asset: string) => (await get(t.app, `/api/assets/${asset}`)).json().inBin as boolean;
    const take = (await view(id)).clips[1].take as { id: string; asset: { id: string } };
    expect(await videos()).toHaveLength(2);

    await call("DELETE", `/api/takes/${take.id}`);
    expect((await view(id)).clips[1].take).toBeNull();
    expect(await videos()).not.toContain(take.asset.id);
    expect(await inBin(take.asset.id)).toBe(true);

    // Undo: the take plays again, and its video is back in the library
    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the take removed");
    expect((await view(id)).clips[1].take.id).toBe(take.id);
    expect(await inBin(take.asset.id)).toBe(false);
    expect(await videos()).toContain(take.asset.id);

    // a video of one's own, put on the timeline: taking it off the timeline does not take it out of the library
    const own = await upload(three!, "video/mp4", "holiday.mp4");
    const mine = (await call("POST", `/api/timelines/${id}/clips`, { asset: own.id })).timeline.clips[2].take as { id: string };
    await call("DELETE", `/api/takes/${mine.id}`);
    expect(await inBin(own.id)).toBe(false);
    expect(await videos()).toContain(own.id);
  });

  it("lets a workflow that opens on a picture pick up from the last frame that plays", async () => {
    const found = (await post(t.app, "/api/workflows/inspect", wan)).json();
    const wf = (await post(t.app, "/api/workflows", { title: "Picture to video", model: "Wan 2.2", source: "wan.json", graph: found.graph, bindings: found.suggested })).json();
    const { id } = await twoClips();
    const c = (await call("POST", `/api/timelines/${id}/clips`, { recipe: wf.id })).clip;
    await call("POST", `/api/timelines/${id}/render`, { clips: [{ id: c, input: { prompt: "She waves." } }] });
    await finish(three!, 3);
    expect(fake.uploads.filter((u) => u.endsWith(".png"))).toHaveLength(1);
    const v = await view(id);
    expect(v.clips[2]).toMatchObject({ join: "fresh", take: { headMs: 0 } });
    const detail = (await get(t.app, `/api/assets/${v.clips[2].take.asset.id}`)).json();
    // made from the clip before, by way of its last frame, which is a picture of the library now
    const roles = Object.fromEntries(detail.sources.map((s: { role: string; asset: { id: string; origin: string } }) => [s.role, s.asset]));
    expect(roles.previous.id).toBe(v.clips[1].take.asset.id);
    expect(roles.start).toMatchObject({ kind: "image", origin: "frame", width: 192, height: 320 });

    // another take from the same frame does not add the picture again
    await call("POST", `/api/timelines/${id}/render`, { clips: [{ id: c, input: { prompt: "She waves." } }] });
    await finish(three!, 4);
    expect((await get(t.app, "/api/assets?kind=image")).json().items).toHaveLength(1);
  });
});
