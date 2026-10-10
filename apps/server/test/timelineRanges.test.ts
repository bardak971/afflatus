import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { makePng, startFakeComfy } from "@afflatus/comfy/testing";
import { referenceClip } from "../src/cut";
import { OWNER } from "../src/db";
import { readVideo } from "../src/video";
import { patternClip } from "./clipKit";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";
import { frames, H3_FILES, nodes, timelineSteps, timelineSuite } from "./timelineKit";

/** A clip outside a timeline, a reference video, a take trimmed on the timeline (its ranges), and how long a finish takes. */

const s = timelineSuite();
const { call, view, finish, render, twoClips } = timelineSteps(s);
// the tests read the app, the pretend ComfyUI and the clips by these names, as the suite's hooks set them
let fake: FakeComfy;
let t: TestApp;
let three: Uint8Array;
let smooth: Uint8Array;
let silent: Uint8Array;
let tone: Uint8Array;
beforeAll(() => void ({ three, smooth, silent, tone } = s.clips ?? {}));
beforeEach(() => void ({ fake, t } = s));

describe.skipIf(!ffmpegThere)("a clip made outside a timeline", { timeout: FFMPEG_TIMEOUT }, () => {
  it("can carry on from any moment of a video in the library", async () => {
    const { id } = await twoClips();
    const source = (await view(id)).clips[0].take.asset.id;
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "He turns around.", previous: { asset: source, at: 1500 } } });
    const graph = await finish(three!, 3);
    expect(nodes(graph, "MiniMaxH3AddGuide")[0]!.inputs.frame_idx).toBe(0);
    // no timeline: the frame is the one of the clip it carries on from
    expect(nodes(graph, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 192, height: 320 });
    const made = (await get(t.app, "/api/assets?kind=video")).json().items[0];
    expect((await get(t.app, `/api/assets/${made.id}`)).json().sources).toMatchObject([{ role: "previous", asset: { id: source } }]);
  });
});

describe.skipIf(!ffmpegThere)("a video of a person as a reference", { timeout: FFMPEG_TIMEOUT }, () => {
  /** A person filmed upright, larger than a reference is sent. */
  let big: Uint8Array;
  beforeAll(async () => void (big = await patternClip(5, { size: "640x1136" })), FFMPEG_TIMEOUT);

  it("is its first seconds, small, at the model's speed; a silent one is no voice", async () => {
    const clip = await referenceClip(big, "mp4", { seconds: 3, fps: 24, short: 384 });
    expect(clip).toMatchObject({ width: 384, frames: 72, hasSound: true });
    expect(clip.height).toBeGreaterThan(600);
    expect((await readVideo(clip.bytes, "mp4")).facts).toMatchObject({ fps: 24, hasSound: true });
    // already small: it is not enlarged
    expect(await referenceClip(three!, "mp4", { seconds: 3, fps: 24, short: 384 })).toMatchObject({ width: 192, height: 320 });
    expect((await referenceClip(silent!, "mp4", { seconds: 3, fps: 24, short: 384 })).hasSound).toBe(false);
  });

  it("goes up to ComfyUI as that short clip when a render names it, and is part of how the result was made", async () => {
    await t.close();
    await fake.close().catch(() => {});
    // the suite closes what it holds after the test: these, now
    s.fake = fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...H3_FILES, diffusion_models: [...H3_FILES.diffusion_models, "minimax_h3_ref2va_fp8.safetensors"] } });
    s.t = t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
    const video = (await t.app.inject({ method: "POST", url: "/api/assets?name=her.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(big) })).json();
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=p.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 64, [1, 2, 3], [4, 5, 6])) })).json();
    // a picture is not a video
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "She waves.", refVideos: [{ asset: picture.id, role: "person" }] } });
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "=", "failed").execute()).length === 1);
    expect((await t.db.selectFrom("jobs").select("error").where("status", "=", "failed").executeTakeFirstOrThrow()).error).toMatch(/reference video is no longer/);

    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "She waves.", refVideos: [{ asset: video.id, role: "person" }] } });
    const graph = await finish(three!, 1);
    const node = nodes(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(node.inputs)).toEqual(expect.arrayContaining(["ref_videos.ref_video_0", "ref_video_audios.ref_video_audio_0"]));
    expect(String(node.inputs.prompt)).toContain("<Subject 1> is the character in <Video 1>.");
    // it went up as a video of its own (the short clip that was cut from it)
    const sent = String(nodes(graph, "LoadVideo")[0]!.inputs.file).replace(" [temp]", "");
    expect(sent).toMatch(/\.mp4$/);
    expect(fake.uploads).toContain(sent);
    const made = (await get(t.app, "/api/assets?kind=video")).json().items.find((a: { id: string }) => a.id !== video.id);
    expect((await get(t.app, `/api/assets/${made.id}`)).json().sources).toMatchObject([{ role: "person", asset: { id: video.id } }]);
  });
});

describe.skipIf(!ffmpegThere)("a clip's take, trimmed on the timeline", { timeout: FFMPEG_TIMEOUT }, () => {
  it("splits into two clips at a moment, both playing from the same video", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Split" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const { clip: b } = await call("POST", `/api/clips/${a}/split`, { atMs: 1500 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([a, b]);
    const [first, second] = v.clips;
    expect(first.take.asset.id).toBe(second.take.asset.id);
    expect(first.take.endMs).toBeCloseTo(1500, -1);
    expect(second.take.startMs).toBeCloseTo(1500, -1);
    expect(first.lengthMs + second.lengthMs).toBeCloseTo(3000, -2);
    expect(second.recipe).toBe("h3.video");
    expect(second.joined).toBe("cut");
    // outside the part that plays: refused
    const bad = await t.app.inject({ method: "POST", url: `/api/clips/${a}/split`, payload: { atMs: 2900 } });
    expect(bad.statusCode).toBe(400);
    // undo takes the split back
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(1);
  });

  /** Two clips of three seconds, both rendered, as cuts. */
  async function twoRendered() {
    const tl = await call("POST", "/api/timelines", { name: "Range" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "She walks to the window." } });
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    await render(tl.id, [{ id: b }]);
    await finish(three!, 2);
    expect((await view(tl.id)).durationMs).toBeCloseTo(6000, -2);
    return { tl: tl.id as string, a, b };
  }

  it("a range across two clips: split at In and Out, remove it, Undo each", async () => {
    const { tl, a, b } = await twoRendered();
    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 4000, action: "split" });
    let v = await view(tl);
    expect(v.clips).toHaveLength(4);
    expect(v.clips.map((c: { lengthMs: number }) => Math.round(c.lengthMs / 100) * 100)).toEqual([1000, 2000, 1000, 2000]);
    expect(v.clips[0].id).toBe(a);
    expect(v.clips[2].id).toBe(b);
    expect(v.durationMs).toBeCloseTo(6000, -2);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(2);
    // both on cuts already: refused
    const bad = await t.app.inject({ method: "POST", url: `/api/timelines/${tl}/range`, payload: { inMs: 0, outMs: 3000, action: "split" } });
    expect(bad.statusCode).toBe(400);

    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 4000, action: "remove" });
    v = await view(tl);
    expect(v.clips).toHaveLength(2);
    expect(v.durationMs).toBeCloseTo(3000, -2);
    expect(v.clips[0].lengthMs).toBeCloseTo(1000, -2);
    // the second clip now starts a second in
    expect(v.clips[1].take.startMs).toBeCloseTo(1000, -2);
    expect(v.undo).toBe("the range removed");
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).durationMs).toBeCloseTo(6000, -2);

    // a range inside one clip: the rest of that clip stays, as a clip of its own
    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 2000, action: "remove" });
    v = await view(tl);
    expect(v.clips).toHaveLength(3);
    expect(v.clips.map((c: { lengthMs: number }) => Math.round(c.lengthMs / 100) * 100)).toEqual([1000, 1000, 3000]);
    expect(v.clips[0].take.asset.id).toBe(v.clips[1].take.asset.id);
  });

  it("regenerates a range: a new clip pinned to the frame before In and the frame at Out, in place of what played", async () => {
    const { tl, a, b } = await twoRendered();
    // between two H3 clips: the new clip takes their video as context, extending the one before and ending where the one after begins
    const { clip, context, widenedMs } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 2000, outMs: 4000, action: "regenerate" });
    expect(context).toEqual({ start: "clip", end: "clip" });
    // two seconds is shorter than H3 makes (4 s): the range takes in a second after Out and one before In, so that the
    // clip replaces exactly what it plays and nothing after it moves
    expect(widenedMs).toBe(2000);
    const v = await view(tl);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([a, clip, b]);
    const made = v.clips[1];
    expect(made.recipe).toBe("h3.video");
    expect(made.take).toBeNull();
    expect(made.joined).toBe("continue");
    expect(v.clips[2].joined).toBe("continue");
    expect(made.inputs.description).toBe("She walks to the window.");
    expect(made.inputs.seconds).toBe(4);
    expect(made.inputs.start).toBeUndefined();
    expect(made.inputs.end).toBeUndefined();
    // what played between went: the first clip stops at 1 s, the second starts two seconds in, a second of each left to join to
    expect(v.clips[0].lengthMs).toBeCloseTo(1000, -2);
    expect(v.clips[2].take.startMs).toBeCloseTo(2000, -2);
    expect(v.undo).toBe("the regenerated range");
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(2);

    // In = Out on the cut: a clip between the two, nothing removed
    const between = (await call("POST", `/api/timelines/${tl}/range`, { inMs: 3000, outMs: 3000, action: "regenerate" })).clip;
    const w = await view(tl);
    expect(w.clips.map((c: { id: string }) => c.id)).toEqual([a, between, b]);
    expect(w.durationMs).toBeCloseTo(6000, -2);
    expect(w.clips[1].joined).toBe("continue");
    expect(w.undo).toBe("the clip added between");
    await call("POST", `/api/timelines/${tl}/undo`);

    // after a still there is no motion to carry: the new clip opens on the picture itself
    const png = (await t.app.inject({ method: "POST", url: "/api/assets?name=card.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 64, [200, 120, 40], [40, 60, 160])) })).json();
    await call("POST", `/api/timelines/${tl}/clips`, { after: null, asset: png.id });
    const x = await view(tl);
    expect(x.clips[0].kind).toBe("still");
    const r2 = await call("POST", `/api/timelines/${tl}/range`, { inMs: 3000, outMs: 4000, action: "regenerate" });
    expect(r2.context).toEqual({ start: "frame", end: "clip" });
    const y = await view(tl);
    expect(y.clips[1].inputs.start).toBe(png.id);
    expect(y.clips[1].joined).toBe("cut");
  });

  it("loops a range: a short clip after Out that returns to the frame at In", async () => {
    const { tl, a, b } = await twoRendered();
    const { clip, context, arrive } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 4000, action: "loop" });
    expect(context).toEqual({ start: "clip", end: "frame" });
    expect(arrive).toBe(a);
    const v = await view(tl);
    // Out inside the second clip: it is split there; the loop clip follows the part in the range, the rest comes after as a cut
    expect(v.clips).toHaveLength(4);
    expect(v.clips[0].id).toBe(a);
    expect(v.clips[1].id).toBe(b);
    expect(v.clips[1].lengthMs).toBeCloseTo(1000, -2);
    const made = v.clips[2];
    expect(made.id).toBe(clip);
    expect(made.recipe).toBe("h3.video");
    expect(made.take).toBeNull();
    expect(made.joined).toBe("continue");
    expect(made.inputs.start).toBeUndefined();
    expect(typeof made.inputs.end).toBe("string");
    // a second and a half, or the least the model allows (H3: 4 s)
    expect(made.inputs.seconds).toBe(4);
    expect(v.clips[3].joined).toBe("cut");
    expect(v.undo).toBe("the loop clip");
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(2);
    // nothing to play round
    const bad = await t.app.inject({ method: "POST", url: `/api/timelines/${tl}/range`, payload: { inMs: 2000, outMs: 2000, action: "loop" } });
    expect(bad.statusCode).toBe(400);
  });

  it("finishes the clips: a job each on the take's video, the result a take marked as the finished version of the draft", async () => {
    const { tl, a, b } = await twoRendered();
    const r = await call("POST", `/api/timelines/${tl}/finish`, { route: "model", factor: 2, upscaleModel: "RealESRGAN_x4plus.pth" });
    expect(r.jobs).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    // the first job: the take's video up to ComfyUI, the upscale model on its frames, the sound passed through, the video back
    const graph = await finish(three!, 3);
    expect(nodes(graph, "LoadVideo")).toHaveLength(1);
    expect(nodes(graph, "ImageUpscaleWithModel")).toHaveLength(1);
    expect(nodes(graph, "UpscaleModelLoader")[0]!.inputs.model_name).toBe("RealESRGAN_x4plus.pth");
    expect(nodes(graph, "VHS_VideoCombine")[0]!.inputs.audio).toBeDefined();
    await finish(three!, 4);
    const v = await view(tl);
    for (const c of v.clips) {
      expect(c.takes).toHaveLength(2);
      const [draft, done] = c.takes;
      expect(done.finishedFrom).toBe(draft.id);
      expect(c.take.id).toBe(done.id);
      // named after the take it finishes, and how many times bigger
      expect(done.asset.name).toBe(`${draft.asset.name} · finished ×2`);
    }
    // the second clip was rendered as a cut (see twoRendered): finishing does not make it follow the first, and its takes know no join
    expect(v.clips[1].joined).toBe("cut");
    expect(v.clips[1].join).toBe("cut");
    // a take says how it joined the clip before (the finished one inherits it) and how long it took
    expect(v.clips[0].take.joinKind).toBeNull();
    expect(v.clips[1].take.joinKind).toBeNull();
    expect(v.clips[0].takes[0].renderMs === null || v.clips[0].takes[0].renderMs > 0).toBe(true);
    // the library says which clip each video is a take of
    const listed = (await get(t.app, "/api/assets?kind=video")).json().items as Array<{ id: string; clipOf: Record<string, unknown> | null }>;
    expect(listed.find((x) => x.id === v.clips[0].takes[0].asset.id)?.clipOf).toMatchObject({ timeline: tl, clip: 1, take: 1, takes: 2, playing: false, upscaledBy: null });
    expect(listed.find((x) => x.id === v.clips[1].take.asset.id)?.clipOf).toMatchObject({ clip: 2, take: 2, takes: 2, playing: true });
    expect(typeof listed.find((x) => x.id === v.clips[1].take.asset.id)?.clipOf?.upscaledBy).toBe("number");
    expect(v.undo).toBe("the finished take");
    // finished already: skipped, unless asked to redo; a clip whose render is on its way too
    const again = await call("POST", `/api/timelines/${tl}/finish`, { route: "model", factor: 2 });
    expect(again.jobs).toEqual([]);
    expect(again.skipped.map((x: { why: string }) => x.why)).toEqual(["finished already", "finished already"]);
    const redo = await call("POST", `/api/timelines/${tl}/finish`, { route: "model", factor: 1.5, upscaleModel: "RealESRGAN_x4plus.pth", redo: true, clips: [a] });
    expect(redo.jobs).toHaveLength(1);
    await finish(three!, 5);
    const w = await view(tl);
    // the redo is the finished version of the draft, not of the finished take
    expect(w.clips[0].takes).toHaveLength(3);
    expect(w.clips[0].takes[2].finishedFrom).toBe(w.clips[0].takes[0].id);
    // SeedVR2 without its files: the job says what is missing
    const sv = await call("POST", `/api/timelines/${tl}/finish`, { route: "seedvr", factor: 2, redo: true, clips: [a] });
    expect(sv.jobs).toHaveLength(1);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", sv.jobs[0]).executeTakeFirstOrThrow()).status === "failed");
    expect((await t.db.selectFrom("jobs").select("error").where("id", "=", sv.jobs[0]).executeTakeFirstOrThrow()).error).toMatch(/SeedVR2 needs its two files/);
    // H3's latent route re-samples the draft's own kept latent: without one, the clip is skipped with what to do instead
    const none = await call("POST", `/api/timelines/${tl}/finish`, { route: "latent", factor: 2, redo: true, clips: [a] });
    expect(none.jobs).toEqual([]);
    expect(none.skipped[0].why).toMatch(/latent was not kept/);
    // with one: a job of the clip's own recipe, its seed and form, the latent pass, the mark carried through the render
    await t.db.updateTable("assets").set({ latent_key: "assets/zz/kept.latent.safetensors" }).where("id", "=", w.clips[0].takes[0].asset.id).execute();
    const lat = await call("POST", `/api/timelines/${tl}/finish`, { route: "latent", factor: 2, redo: true, clips: [a] });
    expect(lat.jobs).toHaveLength(1);
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", lat.jobs[0]).executeTakeFirstOrThrow();
    expect(job.recipe_id).toBe("h3.video");
    expect(job.finished_from).toBe(w.clips[0].takes[0].id);
    const input = JSON.parse(job.inputs) as Record<string, unknown>;
    expect(input.upscale).toBe("Latent: re-sampled");
    expect(typeof input.seed).toBe("number");
    expect(input.seed).not.toBe(-1);
    // the render is not run here: taken out of the queue
    await call("POST", `/api/jobs/${lat.jobs[0]}/cancel`);
    // rendered again it makes its draft again only from the same start: the second clip was made as a cut, so once joined
    // to the first it is skipped (it would be rendered as a continuation, a new video), with what to do instead
    await call("PATCH", `/api/clips/${b}`, { joined: "continue" });
    const joined = await call("POST", `/api/timelines/${tl}/finish`, { route: "latent", factor: 2, redo: true, clips: [b] });
    expect(joined.jobs).toEqual([]);
    expect(joined.skipped[0].why).toMatch(/not made as a continuation.*SeedVR2, RTX or a model/);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0, 10_000);
  }, 90_000);

  it("scores how smoothly each take meets the clips around it", async () => {
    const { tl, a, b } = await twoRendered();
    const first = (await get(t.app, `/api/clips/${a}/joins`)).json().items as Array<{ take: string; in: number | null; out: number | null }>;
    expect(first).toHaveLength(1);
    expect(first[0]!.in).toBeNull();
    expect(typeof first[0]!.out).toBe("number");
    const second = (await get(t.app, `/api/clips/${b}/joins`)).json().items as Array<{ take: string; in: number | null; out: number | null }>;
    expect(typeof second[0]!.in).toBe("number");
    expect(second[0]!.out).toBeNull();
    expect((await view(tl)).clips).toHaveLength(2);
  });

  it("slows a range within a clip: the part becomes a clip of its own and gets the slowed video as a take", async () => {
    const { tl, a } = await twoRendered();
    const { clips: made, jobs, engine } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 2000, action: "slow", factor: 2 });
    const clip = made[0];
    const job = jobs[0];
    expect(engine).toBe("ffmpeg");
    let v = await view(tl);
    // split at 1 s and at 2 s: the first clip, the part, the rest, then the second clip
    expect(v.clips).toHaveLength(4);
    expect(v.clips[1].id).toBe(clip);
    expect(v.clips[0].id).toBe(a);
    expect(v.clips[1].lengthMs).toBeCloseTo(1000, -2);
    await until(async () => ((await get(t.app, "/api/jobs")).json().items as Array<{ id: string; status: string }>).some((j) => j.id === job && j.status === "done"), 120_000);
    v = await view(tl);
    const part = v.clips[1];
    expect(part.takes).toHaveLength(2);
    expect(part.lengthMs).toBeGreaterThan(1800);
    expect(part.lengthMs).toBeLessThan(2300);
    expect(v.undo).toBe("the slow-motion take");
    // a range across clips: each part on its own (the slowed part is 2 s now, so 2.5–4.5 s touches it, the rest of the first clip and the start of the second)
    const before = Object.fromEntries(v.clips.map((c: { id: string; takes: unknown[] }) => [c.id, c.takes.length]));
    const across = await call("POST", `/api/timelines/${tl}/range`, { inMs: 2500, outMs: 4500, action: "slow", factor: 2 });
    expect(across.clips).toHaveLength(3);
    expect(across.jobs).toHaveLength(3);
    await until(async () => { const items = (await get(t.app, "/api/jobs")).json().items as Array<{ id: string; status: string }>; return across.jobs.every((j: string) => items.some((x) => x.id === j && x.status === "done")); }, 240_000);
    const w = await view(tl);
    const slowed = w.clips.filter((c: { id: string }) => across.clips.includes(c.id));
    expect(slowed).toHaveLength(3);
    for (const c of slowed) expect(c.takes.length).toBe((before[c.id] ?? 1) + 1);
    // the second clip no longer carries on from the first: the join is a cut now
    expect(w.clips.slice(1).every((c: { joined: string }) => c.joined === "cut")).toBe(true);
  });

  it("copies a range to the library: one video of that part, through the export queue", async () => {
    const { tl } = await twoRendered();
    const { job } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 2000, outMs: 4000, action: "copy" });
    expect(job).toBeTruthy();
    await until(async () => ((await get(t.app, "/api/jobs")).json().items as Array<{ id: string; status: string }>).some((j) => j.id === job && j.status === "done"), 60_000);
    const items = (await get(t.app, "/api/assets?kind=video")).json().items as Array<{ name: string; durationMs: number }>;
    const copy = items.find((x) => /0:02–0:04/.test(x.name));
    expect(copy).toBeTruthy();
    expect(copy!.durationMs).toBeGreaterThan(1700);
    expect(copy!.durationMs).toBeLessThan(2400);
  });
});

describe.skipIf(!ffmpegThere)("how long a finish takes", { timeout: FFMPEG_TIMEOUT }, () => {
  /** A finish on record as the queue writes it: so many pixels × frames made in so long. */
  const finished = (id: string, work: number, totalMs: number) => t.db.insertInto("render_stats").values({
    id, owner_id: OWNER, recipe_id: "tool.finish.seedvr", family: "tools", model: "SeedVR2", model_file: "", time_key: "route=seedvr;by=2;frames=0",
    kind: "video", width: 384, height: 640, duration_ms: 3000, steps: 0, status: "done", whole: 1, cold: 0, waited_ms: 0,
    total_ms: totalMs, load_ms: 0, sample_ms: 0, refine_ms: totalMs, finish_ms: 0, step_ms: null, expected_ms: null, work,
    vram_peak: 60, heat_peak: 60, asset_id: null, created_at: new Date().toISOString(),
  }).execute();

  it("is one figure from the server: the dialog's total is what the waiting list says job by job, none before the route has run", async () => {
    const tl = await twoClips();
    const settings = { route: "seedvr", factor: 2 };
    // nothing learned for this route: no time, not a guess
    expect(await call("POST", `/api/timelines/${tl.id}/finish/forecast`, settings)).toEqual({ ms: null });

    // two past finishes at 1 ms per 1000 pixels × frames: the middle of them is the pace
    await finished("f1", 1_000_000, 1_000);
    await finished("f2", 2_000_000, 2_000);
    const v = await view(tl.id);
    const a = v.clips[0].take.asset;
    // the first clip: its size × 2, every frame (it has no hidden run-up)
    const first = Math.round(a.width * 2) * Math.round(a.height * 2) * Math.round((a.durationMs / 1000) * a.fps) / 1000;
    const { ms } = await call("POST", `/api/timelines/${tl.id}/finish/forecast`, settings);
    expect(ms).toBeGreaterThan(first);
    // a larger factor is more work
    expect((await call("POST", `/api/timelines/${tl.id}/finish/forecast`, { ...settings, factor: 3 })).ms).toBeGreaterThan(ms);

    // queued, held by a pause: each waiting finish shows its share, and they add up to what the dialog said
    await post(t.app, "/api/queue/pause");
    const { jobs } = await call("POST", `/api/timelines/${tl.id}/finish`, settings);
    expect(jobs).toHaveLength(2);
    const waiting = (await get(t.app, "/api/queue")).json().waiting as Array<{ id: string; estimateMs: number | null }>;
    const estimates = jobs.map((id: string) => waiting.find((w) => w.id === id)!.estimateMs);
    expect(Math.abs(estimates[0] - first)).toBeLessThanOrEqual(1);
    expect(estimates[0] + estimates[1]).toBe(ms);
  });
});
