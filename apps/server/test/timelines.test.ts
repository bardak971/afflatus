import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { cutFrames, frameAt } from "../src/cut";
import { colourNudge, MATCH } from "../src/measure";
import { OWNER } from "../src/db";
import { pngSize } from "../src/media";
import { EXPORT_JOB } from "../src/timelineModel";
import { readVideo } from "../src/video";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { get, post, until, type TestApp } from "./helpers";
import { frames, nodes, timelineSteps, timelineSuite } from "./timelineKit";

/** A timeline's clips: the frames one joins onto, its renders, and how a clip carries on from the one before. */

const run = promisify(execFile);

const s = timelineSuite();
const { call, view, prompts, finish, render, twoClips, exported } = timelineSteps(s);
// the tests read the app, the pretend ComfyUI and the clips by these names, as the suite's hooks set them
let fake: FakeComfy;
let t: TestApp;
let three: Uint8Array;
let smooth: Uint8Array;
let silent: Uint8Array;
beforeAll(() => void ({ three, smooth, silent } = s.clips ?? {}));
beforeEach(() => void ({ fake, t } = s));

describe.skipIf(!ffmpegThere)("the frames a clip joins onto", { timeout: FFMPEG_TIMEOUT }, () => {
  it("are the last ones before a moment, or the first ones after it, with their sound", async () => {
    const facts = { durationMs: 3000, hasSound: true };
    const end = await cutFrames(three!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before" });
    expect(end.frames).toBe(22);
    expect(frames(end.bytes)).toBe(22);
    expect((await readVideo(end.bytes, "mp4")).facts).toMatchObject({ width: 192, height: 320, fps: 24, hasSound: true });
    const start = await cutFrames(three!, "mp4", facts, { counts: [22, 5], fps: 24, side: "after", at: 1000 });
    expect(frames(start.bytes)).toBe(22);
  });

  it("are every other frame of a clip that was smoothed to twice the speed", async () => {
    const cut = await cutFrames(smooth!, "mp4", { durationMs: 3000, hasSound: true }, { counts: [22, 5], fps: 24, side: "before", at: 2000 });
    expect(frames(cut.bytes)).toBe(22);
    expect((await readVideo(cut.bytes, "mp4")).facts).toMatchObject({ fps: 24 });
  });

  it("are fewer when the moment is close to the start, and refused when there is no room at all", async () => {
    const facts = { durationMs: 2000, hasSound: false };
    const cut = await cutFrames(silent!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before", at: 500 });
    expect(cut.frames).toBe(5);
    expect((await readVideo(cut.bytes, "mp4")).facts).toMatchObject({ hasSound: false });
    await expect(cutFrames(silent!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before", at: 100 })).rejects.toThrow(/too short/);
  });

  it("after a moment, start there even when the file's last frame is missing: fewer are cut, never earlier ones", async () => {
    // 48 frames, each a step brighter, and a sound a frame and a half longer: the file's length promises a 49th frame
    const dir = await mkdtemp(join(tmpdir(), "afflatus-after-"));
    try {
      const file = join(dir, "steps.mkv");
      await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=64x36:r=24:d=2,geq=lum='N*5':cb=128:cr=128", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.06", "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", file]);
      const bytes = new Uint8Array(await readFile(file));
      const facts = (await readVideo(bytes, "mkv")).facts!;
      expect(Math.floor((facts.durationMs / 1000) * 24 + 0.01)).toBe(49);
      // from frame 27 the file says 22 are left, there are 21: the shorter count is cut, from frame 27 still
      const cut = await cutFrames(bytes, "mkv", facts, { counts: [22, 5], fps: 24, side: "after", at: 1125 });
      expect(cut.frames).toBe(5);
      expect(frames(cut.bytes)).toBe(5);
      // its first frame is frame 27 of the file, read the same way (frame 26 is a step darker)
      await writeFile(join(dir, "cut.mp4"), cut.bytes);
      const luma = async (input: string, frame: number) =>
        (await run("ffmpeg", ["-loglevel", "error", "-i", input, "-vf", `trim=start_frame=${frame},scale=1:1:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer" })).stdout[0]!;
      expect(Math.abs((await luma(join(dir, "cut.mp4"), 0)) - (await luma(file, 27)))).toBeLessThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("one frame comes out as a picture, the last one when the moment is past the end", async () => {
    expect(pngSize(await frameAt(three!, "mp4", 1500))).toEqual({ width: 192, height: 320 });
    expect(pngSize(await frameAt(three!, "mp4", 9000, 3000))).toEqual({ width: 192, height: 320 });
  });
});

describe("a timeline, without rendering anything", () => {
  it("reads its export state from its own export jobs, however many the other timelines ran since", async () => {
    const mine = await call("POST", "/api/timelines", { name: "Mine" });
    const other = await call("POST", "/api/timelines", { name: "Other" });
    const exportJob = (id: string, timeline: string, status: "done" | "failed", error: string | null, agoMs: number) => {
      const at = new Date(Date.now() - agoMs).toISOString();
      return t.db
        .insertInto("jobs")
        .values({
          id, owner_id: OWNER, recipe_id: EXPORT_JOB, label: "export", inputs: JSON.stringify({ timeline, scale: 1, music: true }), status, warm: 0, look: null, priority: 20, depends_on: null,
          attempts: 1, resume: null, error, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: timeline, draft_id: null, folder_id: null, finished_from: null,
          created_at: at, started_at: at, finished_at: at, updated_at: at,
        })
        .execute();
    };
    // mine failed an hour ago; the other timeline exported forty times since, the last one failing too
    await exportJob("mine-1", mine.id, "failed", "ffmpeg was not found", 3_600_000);
    for (let i = 0; i < 40; i++) await exportJob(`other-${i}`, other.id, i === 39 ? "failed" : "done", i === 39 ? "the disk is full" : null, 3_600_000 - (i + 1) * 60_000);
    expect(await view(mine.id)).toMatchObject({ exporting: null, exportFailed: "ffmpeg was not found" });
    expect(await view(other.id)).toMatchObject({ exporting: null, exportFailed: "the disk is full" });
    // an export of mine that went through since: nothing to say any more
    await exportJob("mine-2", mine.id, "done", null, 0);
    expect((await view(mine.id)).exportFailed).toBeNull();
  });

  it("takes its frame as one thing: a width without a height is refused", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Frame" });
    const half = await t.app.inject({ method: "PATCH", url: `/api/timelines/${tl.id}`, payload: { width: 512 } });
    expect(half.statusCode).toBe(400);
    expect((await view(tl.id)).width).toBeNull();
    expect(await call("PATCH", `/api/timelines/${tl.id}`, { width: 512, height: 768 })).toMatchObject({ width: 512, height: 768 });
    expect(await call("PATCH", `/api/timelines/${tl.id}`, { width: null, height: null })).toMatchObject({ width: null, height: null });
  });

  it("answers a render with the jobs it queued, in the order the clips play, which the queue can then put first", async () => {
    await post(t.app, "/api/queue/pause");
    const before = await call("POST", "/api/timelines", { name: "Before" });
    const early = (await call("POST", `/api/timelines/${before.id}/clips`, { recipe: "h3.video" })).clip as string;
    const [waitingFirst] = (await render(before.id, [{ id: early }])).ids as string[];
    const tl = await call("POST", "/api/timelines", { name: "Harbor walk" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    const { ids } = await render(tl.id, [{ id: b }, { id: a }]);
    expect(ids).toHaveLength(2);
    const queued = async () => (await get(t.app, "/api/queue")).json().waiting as Array<{ id: string; clipId: string | null }>;
    expect((await queued()).map((w) => [w.id, w.clipId])).toEqual([[waitingFirst, early], [ids[0], a], [ids[1], b]]);
    // to the top, in their own order: what the command bar's Ctrl+Enter does with them
    const ordered = (await post(t.app, "/api/queue/order", { ids })).json();
    expect(ordered.waiting.map((w: { id: string }) => w.id)).toEqual([...ids, waitingFirst]);
  });

  it("takes what Redo remembered with it when it goes", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Gone" });
    await call("PATCH", `/api/timelines/${tl.id}`, { name: "Renamed" });
    await call("POST", `/api/timelines/${tl.id}/undo`);
    const future = () => t.db.selectFrom("timeline_future").select("id").where("timeline_id", "=", tl.id).execute();
    expect(await future()).toHaveLength(1);
    await call("DELETE", `/api/timelines/${tl.id}`);
    expect(await future()).toHaveLength(0);
    expect((await get(t.app, `/api/timelines/${tl.id}`)).statusCode).toBe(404);
  });
});

describe.skipIf(!ffmpegThere)("a timeline", { timeout: FFMPEG_TIMEOUT }, () => {
  it("renders a clip, makes its video a take that plays, and takes its frame from it", async () => {
    const tl = await call("POST", "/api/timelines", {});
    expect(tl).toMatchObject({ name: "Timeline 1", width: null, clips: [] });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: a }]);
    await until(async () => (await view(tl.id)).clips[0].job !== null);
    const graph = await finish(three!, 1);
    // on its own: nothing to join onto, the shape it was asked for
    expect(nodes(graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    expect(nodes(graph, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024, length: 124 });

    const v = await view(tl.id);
    expect(v).toMatchObject({ width: 192, height: 320, durationMs: 3000 });
    expect(v.clips[0]).toMatchObject({ job: null, join: null, lengthMs: 3000, take: { headMs: 0, tailMs: 0, asset: { kind: "video", kept: true } } });
    expect(v.clips[0].takes).toHaveLength(1);
    expect((await get(t.app, "/api/timelines")).json().items[0]).toMatchObject({ clips: 1, durationMs: 3000, cover: v.clips[0].take.asset.id });
  });

  it("gives a clip that carries on the last frames of the clip before it, and skips them when it plays", async () => {
    const { id, second } = await twoClips();
    // the join: 22 frames of the first clip pinned at the start, the clip that much longer, in the timeline's frame
    const guide = nodes(second, "MiniMaxH3AddGuide");
    expect(guide).toHaveLength(1);
    expect(guide[0]!.inputs.frame_idx).toBe(0);
    expect(nodes(second, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 192, height: 320, length: 141 });
    expect(fake.uploads.filter((u) => u.endsWith(".mp4"))).toHaveLength(1);

    const v = await view(id);
    expect(v.clips[1]).toMatchObject({ joined: "continue", join: "fresh", atMs: 3000, lengthMs: 3000 - 917, take: { headMs: 917, startMs: 917, endMs: 3000 } });
    expect(v.durationMs).toBe(6000 - 917);
    // the lineage: the second clip was made from the first
    const detail = (await get(t.app, `/api/assets/${v.clips[1].take.asset.id}`)).json();
    expect(detail.sources).toMatchObject([{ role: "previous", asset: { id: v.clips[0].take.asset.id } }]);
    expect(detail.generation.resolved.overlap).toEqual({ headMs: 917, tailMs: 0 });
  });

  it("makes a new take of a clip end where the next one begins, so the join holds", async () => {
    const { id, a } = await twoClips();
    await render(id, [{ id: a }]);
    const graph = await finish(three!, 3);
    const guide = nodes(graph, "MiniMaxH3AddGuide");
    expect(guide).toHaveLength(1);
    expect(guide[0]!.inputs.frame_idx).toBe(-22);
    const v = await view(id);
    expect(v.clips[0].takes).toHaveLength(2);
    // it lands on the clip after: it plays on four frames into its tail (guided by that clip's frames), and the clip after starts as much later
    expect(v.clips[0]).toMatchObject({ lengthMs: 3000 - 917 + 167, take: { tailMs: 917 } });
    expect(v.clips[1].take.landedMs).toBe(167);
    expect(v.clips[1].join).toBe("fresh");
  });

  it("marks the join stale when the clip before changes without fitting, until it is redone or kept as a cut", async () => {
    const { id, a, b } = await twoClips();
    await render(id, [{ id: a, fit: false }]);
    await finish(three!, 3);
    expect((await view(id)).clips[1].join).toBe("stale");

    // the take that the second clip was made from plays again: the join is good again
    const old = (await view(id)).clips[0].takes[0].id;
    await call("PATCH", `/api/clips/${a}`, { take: old });
    expect((await view(id)).clips[1].join).toBe("fresh");
    // shortening the end of the first clip breaks it too
    await call("PATCH", `/api/clips/${a}`, { trimEndMs: 500 });
    expect((await view(id)).clips[1].join).toBe("stale");
    expect((await view(id)).clips[0].lengthMs).toBe(2500);

    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    expect((await view(id)).clips[1].join).toBe("cut");
    // redone, it follows the clip before from where that one now stops
    await call("PATCH", `/api/clips/${b}`, { joined: "continue" });
    await render(id, [{ id: b }]);
    await finish(three!, 4);
    expect((await view(id)).clips[1].join).toBe("fresh");
  });

  it("renders several clips in order, each waiting for the one it carries on from", async () => {
    const { id, a, b } = await twoClips();
    await render(id, [{ id: a }, { id: b }]);
    await until(() => fake.prompts.size === 3);
    // the second waits: its join is cut from the take the first one is about to give
    const line = await t.db.selectFrom("jobs").select(["id", "status", "depends_on"]).where("status", "in", ["queued", "running"]).execute();
    expect(line).toHaveLength(2);
    expect(line.find((j) => j.status === "queued")!.depends_on).toBe(line.find((j) => j.status === "running")!.id);
    expect(fake.prompts.size).toBe(3);
    const firstGraph = await finish(three!, 3);
    // rendered together, the first has nothing to fit
    expect(nodes(firstGraph, "MiniMaxH3AddGuide")).toHaveLength(0);
    await finish(three!, 4);
    const v = await view(id);
    expect(v.clips.map((c: { takes: unknown[] }) => c.takes.length)).toEqual([2, 2]);
    expect(v.clips[1].join).toBe("fresh");
  });

  /** A saved H3 latent as the node pack writes it: the header says how many frames it holds; the values are zeros. */
  function latentFile(frames: number): Uint8Array {
    const shape = [1, 24, ((frames - 5) / 17) * 5 + 2, 2, 2];
    const bytes = shape.reduce((p, x) => p * x, 1) * 4;
    const header = new TextEncoder().encode(JSON.stringify({ __metadata__: { format: "afflatus-h3-av-latent/1", frames: String(frames) }, video: { dtype: "F32", shape, data_offsets: [0, bytes] }, audio: { dtype: "F32", shape: [1, 32, 2, 1], data_offsets: [bytes, bytes + 256] } }));
    const out = new Uint8Array(8 + header.length + bytes + 256);
    new DataView(out.buffer).setBigUint64(0, BigInt(header.length), true);
    out.set(header, 8);
    return out;
  }
  /** Like finish, with the clip's own latent among the outputs, as the node pack saves it. */
  async function finishWithLatent(bytes: Uint8Array, count: number, frames: number) {
    await until(() => fake.prompts.size === count, 20_000);
    const [promptId, graph] = prompts().at(-1)!;
    const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
    const save = Object.entries(graph).find(([, n]) => n.class_type === "AfflatusSaveH3Latent")?.[0];
    fake.files[`${promptId}.mp4`] = bytes;
    fake.files[`${promptId}.safetensors`] = latentFile(frames);
    fake.pending = fake.pending.filter((p) => p !== promptId);
    fake.history[promptId] = {
      status: { completed: true },
      outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] }, ...(save ? { [save]: { latents: [{ filename: `${promptId}.safetensors`, subfolder: "", type: "output" }] } } : {}) },
    };
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || fake.prompts.size > count, 20_000);
    return graph;
  }

  it("a clip continued in the latent starts at its first own frame, the clip before plays to its end, and the export dissolves it in", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Parrot" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await render(tl.id, [{ id: a }]);
    const first = await finishWithLatent(three!, 1, 73);
    expect(Object.values(first).some((n) => n.class_type === "AfflatusSaveH3Latent")).toBe(true);
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await render(tl.id, [{ id: b }]);
    const second = await finishWithLatent(three!, 2, 141);
    // the second continued the first's exact latent, decoded as one piece with it (the seam)
    expect(Object.values(second).some((n) => n.class_type === "MiniMaxH3LatentTailGuide")).toBe(true);
    expect(Object.values(second).some((n) => n.class_type === "AfflatusH3SeamLatent")).toBe(true);
    const v = await view(tl.id);
    const [one, two] = v.clips;
    expect(two.take.joinKind).toBe("seamless");
    expect(two.take.headMs).toBe(917);
    // no take-over point: it plays from its first own frame (a cut four frames earlier still stepped, see leadOf)
    expect(two.take.leadMs).toBeUndefined();
    expect(two.take.startMs).toBe(917);
    // ...and the clip before plays all of its own part
    const own = one.take.asset.durationMs - one.take.tailMs - one.take.trimEndMs - (one.take.headMs + one.take.trimStartMs);
    expect(Math.abs(one.lengthMs - own)).toBeLessThanOrEqual(21);
    expect(two.atMs).toBe(one.lengthMs);
    expect(v.durationMs).toBe(one.lengthMs + two.lengthMs);
    // exported: the clip before held on its last frame while this one dissolves in, the sound straight on; as long as the timeline says
    const out = await exported(tl.id);
    expect(out).toMatchObject({ kind: "video", hasSound: true });
    expect(Math.abs(out.durationMs - v.durationMs)).toBeLessThan(120);
  });

  it("a clip continued in the latent on the machine that saved it names the latent there, and sends it when that ComfyUI no longer has it", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test kept latent" });
    const latentOf = (graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>) => Object.values(graph).find((n) => n.class_type === "AfflatusLoadH3Latent")?.inputs.latent;
    const sentLatents = () => fake.uploads.filter((u) => u.endsWith(".safetensors"));
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await render(tl.id, [{ id: a }]);
    await finishWithLatent(three!, 1, 73);
    const [firstPrompt] = prompts().at(-1)!;
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await render(tl.id, [{ id: b }]);
    const second = await finishWithLatent(three!, 2, 141);
    // the clip before's latent, named where this ComfyUI saved it: nothing went back up
    expect(latentOf(second)).toBe(`${firstPrompt}.safetensors [output]`);
    expect(sentLatents()).toHaveLength(0);
    // that ComfyUI started again unseen (its temp folder emptied): the name is refused once, the latent goes up, the prompt
    // goes again naming it as sent
    const [secondPrompt] = prompts().at(-1)!;
    fake.rejectNext.push({
      error: { message: "Prompt outputs failed validation" },
      node_errors: { "7": { class_type: "AfflatusLoadH3Latent", errors: [{ message: "Custom validation failed for node", details: `latent - H3 latent file not found: '${secondPrompt}.safetensors [output]'` }] } },
    });
    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await render(tl.id, [{ id: c }]);
    const third = await finishWithLatent(three!, 3, 209);
    expect(sentLatents()).toHaveLength(1);
    expect(latentOf(third)).toBe(`${sentLatents()[0]} [temp]`);
    expect(fake.rejectNext).toHaveLength(0);
    expect((await view(tl.id)).clips[2].take.joinKind).toBe("seamless");
  });

  it("gives the player the export's colour matching: a nudge per clip toward the clip before at the join, within a few steps, zero for the first", async () => {
    const { id } = await twoClips();
    const { items } = (await get(t.app, `/api/timelines/${id}/match`)).json();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ y: 0, u: 0, v: 0 });
    for (const k of ["y", "u", "v"] as const) {
      expect(Number.isFinite(items[1][k])).toBe(true);
      expect(Math.abs(items[1][k])).toBeLessThanOrEqual(MATCH.mostSteps);
    }
    // the same nudge the export works out: toward the clip before as it will look, clamped
    expect(colourNudge({ y: 120, u: 128, v: 130 }, { y: 100, u: 128, v: 131 }, { y: 0, u: 0, v: 0 })).toEqual({ y: 14, u: 0, v: -1 });
    expect(colourNudge({ y: 120, u: 128, v: 128 }, { y: 118, u: 128, v: 128 }, { y: 5, u: 0, v: 0 })).toEqual({ y: 7, u: 0, v: 0 });
  });

});
