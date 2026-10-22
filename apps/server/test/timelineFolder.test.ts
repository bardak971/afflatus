import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, sentView, withTakes, makeApp, referenceCatalog, until, type TestApp } from "./helpers";

/** What is made inside a timeline lands in its folder, and follows it when it moves. Skipped where ffmpeg is not installed. */

let three: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) three = await patternClip(3);
}, FFMPEG_TIMEOUT);

const H3_FILES = {
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  frame_interpolation: ["rife49.pth"],
  checkpoints: [],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const call = async (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return sentView(res.json());
};
const view = async (id: string) => withTakes((await get(t.app, `/api/timelines/${id}`)).json());
const folderOf = async (asset: string) => (await t.db.selectFrom("assets").select("folder_id").where("id", "=", asset).executeTakeFirstOrThrow()).folder_id;
const jobDone = (job: string, ms = 120_000) =>
  until(async () => {
    const row = await t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", job).executeTakeFirst();
    if (row?.status === "failed") throw new Error(row.error ?? "failed");
    return row?.status === "done";
  }, ms);

/** Let the pretend ComfyUI finish the latest prompt with this video. */
async function finish(bytes: Uint8Array, count: number) {
  await until(() => fake.prompts.size === count, 20_000);
  const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
  const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
  fake.files[`${promptId}.mp4`] = bytes;
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || fake.prompts.size > count, 20_000);
}

/** A rendered clip on a timeline: its id and its take's video. */
async function rendered(tl: string, count: number) {
  const clip = (await call("POST", `/api/timelines/${tl}/clips`, { recipe: "h3.video" })).clip as string;
  await call("PATCH", `/api/clips/${clip}`, { inputs: { description: "She walks to the window." }, joined: "cut" });
  await call("POST", `/api/timelines/${tl}/render`, { clips: [{ id: clip, input: { description: "She walks to the window." } }] });
  await finish(three!, count);
  const c = (await view(tl)).clips.find((x: { id: string }) => x.id === clip);
  return { clip, asset: c.take.asset.id as string };
}

describe.skipIf(!ffmpegThere)("the timeline folder rule", { timeout: FFMPEG_TIMEOUT }, () => {
  it("files what is made in a timeline in its folder, else its project's root: frames, cuts, slow motion, finishes, the export", async () => {
    const p = await call("POST", "/api/projects", { name: "Film" });
    const tl = (await call("POST", "/api/timelines", { name: "Evening", project: p.id })).id as string;
    // no folder of its own: its project's root
    await call("PATCH", `/api/timelines/${tl}`, { folder: null });
    const { asset } = await rendered(tl, 1);
    expect(await folderOf(asset)).toBe(p.folderId);
    // its video filed elsewhere: what is made out of it still lands with the timeline
    await t.db.updateTable("assets").set({ folder_id: null }).where("id", "=", asset).execute();

    const said = await call("POST", `/api/assets/${asset}/frame`, { atMs: 1000, timeline: tl });
    expect(said.folderId).toBe(p.folderId);
    // not said: the one timeline that plays it
    const guessed = await call("POST", `/api/assets/${asset}/frame`, { atMs: 1500 });
    expect(guessed.folderId).toBe(p.folderId);

    const cut = (await call("POST", `/api/assets/${asset}/range`, { startMs: 500, endMs: 1500, action: "copy", timeline: tl })).id as string;
    await jobDone(cut);
    const copy = await t.db.selectFrom("assets").select(["folder_id"]).where("origin", "=", "cut").where("source_id", "=", asset).executeTakeFirstOrThrow();
    expect(copy.folder_id).toBe(p.folderId);

    const slow = await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 2000, action: "slow", factor: 2 });
    await jobDone(slow.jobs[0]);
    const part = (await view(tl)).clips.find((c: { id: string }) => c.id === slow.clips[0]);
    expect(await folderOf(part.take.asset.id)).toBe(p.folderId);

    const range = (await call("POST", `/api/timelines/${tl}/range`, { inMs: 0, outMs: 900, action: "copy" })).job as string;
    await jobDone(range);
    const exported = await call("POST", `/api/timelines/${tl}/export`, {});
    await jobDone(exported.id);
    const v = await view(tl);
    expect(v.exported.folderId).toBe(p.folderId);
    const copies = await t.db.selectFrom("assets").select("folder_id").where("origin", "=", "exported").execute();
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.folder_id === p.folderId)).toBe(true);
  }, 240_000);

  it("files a finished take in the timeline's folder", async () => {
    const p = await call("POST", "/api/projects", { name: "Film" });
    const sub = await call("POST", "/api/folders", { name: "finals", parentId: p.folderId });
    const tl = (await call("POST", "/api/timelines", { name: "Evening", project: p.id })).id as string;
    const { clip, asset } = await rendered(tl, 1);
    await call("PATCH", `/api/timelines/${tl}`, { folder: sub.id });
    await t.db.updateTable("assets").set({ folder_id: null }).where("id", "=", asset).execute();
    const r = await call("POST", `/api/timelines/${tl}/finish`, { route: "model", factor: 2, upscaleModel: "RealESRGAN_x4plus.pth" });
    expect(r.jobs).toHaveLength(1);
    await finish(three!, 2);
    await jobDone(r.jobs[0]);
    const c = (await view(tl)).clips.find((x: { id: string }) => x.id === clip);
    expect(c.take.finishedFrom).toBeTruthy();
    expect(await folderOf(c.take.asset.id)).toBe(sub.id);
  }, 120_000);

  it("files a take in the timeline's folder as it is when the render finishes, not as it was when it was sent", async () => {
    const p = await call("POST", "/api/projects", { name: "Film" });
    const source = await call("POST", "/api/folders", { name: "source material", parentId: p.folderId });
    const finals = await call("POST", "/api/folders", { name: "finals", parentId: p.folderId });
    const tl = (await call("POST", "/api/timelines", { name: "Evening", project: p.id })).id as string;
    await call("PATCH", `/api/timelines/${tl}`, { folder: source.id });
    // sent while the timeline sits in one folder, the folder chosen while the render waits: the take lands in the new one
    const clip = (await call("POST", `/api/timelines/${tl}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${clip}`, { inputs: { description: "She walks to the window." }, joined: "cut" });
    await call("POST", "/api/queue/pause");
    await call("POST", `/api/timelines/${tl}/render`, { clips: [{ id: clip, input: { description: "She walks to the window." } }] });
    await call("PATCH", `/api/timelines/${tl}`, { folder: finals.id });
    await call("POST", "/api/queue/resume");
    await finish(three!, 1);
    const c = (await view(tl)).clips.find((x: { id: string }) => x.id === clip);
    expect(await folderOf(c.take.asset.id)).toBe(finals.id);
  }, 120_000);

  it("lives and renders in the folder it is made in, as a chosen folder; a folder of another project is refused", async () => {
    const p = await call("POST", "/api/projects", { name: "Film" });
    const other = await call("POST", "/api/projects", { name: "Other" });
    const scenes = await call("POST", "/api/folders", { name: "scenes", parentId: p.folderId });
    const made = await call("POST", "/api/timelines", { name: "Evening", project: p.id, folder: scenes.id });
    expect(made.folderId).toBe(scenes.id);
    expect((await view(made.id)).folderChosen).toBe(true);
    const { asset } = await rendered(made.id, 1);
    expect(await folderOf(asset)).toBe(scenes.id);
    const res = await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "Lost", project: other.id, folder: scenes.id } });
    expect(res.statusCode).toBe(400);
    // nothing named: the project's root, not chosen, as before
    const plain = await call("POST", "/api/timelines", { name: "Plain", project: p.id });
    expect(plain.folderId).toBe(p.folderId);
    expect((await view(plain.id)).folderChosen).toBe(false);
  }, 120_000);

  it("moves what a timeline made when it changes project or folder: not a video another timeline plays, a linked file, or one in the bin", async () => {
    const p = await call("POST", "/api/projects", { name: "From" });
    const q = await call("POST", "/api/projects", { name: "To" });
    const tl = (await call("POST", "/api/timelines", { name: "Evening", project: p.id })).id as string;
    const a = await rendered(tl, 1);
    const b = await rendered(tl, 2);
    const frame = (await call("POST", `/api/assets/${a.asset}/frame`, { atMs: 1000, timeline: tl })).id as string;
    const binned = (await call("POST", `/api/assets/${a.asset}/frame`, { atMs: 2000, timeline: tl })).id as string;
    const exported = await call("POST", `/api/timelines/${tl}/export`, {});
    await jobDone(exported.id);
    const out = (await view(tl)).exported.id as string;
    // b's video is played by another timeline too
    const other = (await call("POST", "/api/timelines", { name: "Other", project: p.id })).id as string;
    await call("POST", `/api/timelines/${other}/clips`, { asset: b.asset });
    // a file of a linked folder, on this timeline
    const upload = await t.app.inject({ method: "POST", url: `/api/assets?name=disk.mp4&project=${p.id}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(three!) });
    const linked = upload.json().id as string;
    await call("POST", `/api/timelines/${tl}/clips`, { asset: linked });
    await t.db.updateTable("assets").set({ file_key: "linked:C:/videos/disk.mp4" }).where("id", "=", linked).execute();
    await t.db.updateTable("assets").set({ deleted_at: new Date().toISOString() }).where("id", "=", binned).execute();
    for (const id of [a.asset, b.asset, frame, binned, out, linked]) expect(await folderOf(id)).toBe(p.folderId);

    let events = 0;
    const count = () => events++;
    t.services.queue.events.on("library", count);
    const moved = await call("PATCH", `/api/timelines/${tl}`, { project: q.id });
    t.services.queue.events.off("library", count);
    expect(events).toBeGreaterThan(0);
    // a folder of the project it left gives way to the new one's root
    expect(moved).toMatchObject({ projectId: q.id, folderId: q.folderId });
    for (const id of [a.asset, frame, out]) expect(await folderOf(id)).toBe(q.folderId);
    for (const id of [b.asset, binned, linked]) expect(await folderOf(id)).toBe(p.folderId);

    // to a folder of its own
    const sub = await call("POST", "/api/folders", { name: "shots", parentId: q.folderId });
    await call("PATCH", `/api/timelines/${tl}`, { folder: sub.id });
    for (const id of [a.asset, frame, out]) expect(await folderOf(id)).toBe(sub.id);
    expect(await folderOf(b.asset)).toBe(p.folderId);
    // to the Inbox
    await call("PATCH", `/api/timelines/${tl}`, { project: null });
    expect((await view(tl)).folderId).toBeNull();
    for (const id of [a.asset, frame, out]) expect(await folderOf(id)).toBeNull();
    const refused = await t.app.inject({ method: "PATCH", url: `/api/timelines/${tl}`, payload: { project: "nope" } });
    expect(refused.statusCode).toBe(404);
  }, 120_000);
});
