import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkAtOrAfter, joinFade, latentFrameAtOrBefore, near } from "@afflatus/core";
import { colourNudge, meansAlong, meansOf, meansWithin } from "../src/measure";
import { joinVideosInto } from "../src/exportJoin";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { markJoins, trimsOf, LEAST_PLAY_MS, type AssetRow, type ClipRow, type Placed, type TakeRow } from "../src/timelineModel";
import { handoverOnGrid } from "../src/timelinePlan";
import { tools } from "../src/video";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * The timeline's fixes of the 2026-10-07 review, each on rows put in the database by hand: a landed or seamless clip split
 * and trimmed where it is seen, a landing on a finished take, Undo of an added take, of a project and of a folder, refused
 * edits, the queue's tools placed twice, and the rest. Nothing is rendered; the ffmpeg parts are skipped without it.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw Object.assign(new Error(`${method} ${url}: ${res.statusCode} ${res.body}`), { statusCode: res.statusCode });
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();

/** A video of the library, its file never read (nothing here asks ffmpeg). */
async function video(over: Partial<AssetRow> = {}): Promise<AssetRow> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: "generated", name: "v.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: now(), ...over,
  })).execute();
  return t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
async function clip(timeline: string, position: number, over: Partial<ClipRow> = {}): Promise<string> {
  const id = newId();
  const at = now();
  await t.db.insertInto("clips").values({
    id, timeline_id: timeline, position, take_id: null, joined: "continue", recipe_id: "h3.video", inputs: "{}", kind: "video", still_asset_id: null, still_ms: 3000,
    sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: at, updated_at: at, ...over,
  }).execute();
  return id;
}
/** A take of a clip, playing unless said. */
async function take(clipId: string, asset: AssetRow, over: Partial<TakeRow> = {}, plays = true): Promise<string> {
  const id = over.id ?? newId();
  await t.db.insertInto("takes").values({
    id, clip_id: clipId, asset_id: asset.id, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null,
    finished_from: null, join_kind: null, created_at: now(), ...over,
  }).execute();
  if (plays) await t.db.updateTable("clips").set({ take_id: id }).where("id", "=", clipId).execute();
  return id;
}

/**
 * Two clips, the first landing on the second: its tail (917 ms) was guided by the second take's frames from 917 ms on, where
 * that take starts to play. The first plays on four frames into its tail, the second starts as much later.
 */
async function landing(opts: { finishedAfter?: boolean } = {}) {
  const tl = (await t.services.timelines.create("Landing")).id;
  const a = await clip(tl, 0, { joined: "cut" });
  const b = await clip(tl, 1);
  const draftB = newId();
  const ta = await take(a, await video(), { tail_ms: 917, next_take_id: draftB, next_at_ms: 917 });
  await take(b, await video(), { id: draftB, head_ms: 917, prev_take_id: null, join_kind: "pixels" });
  // the clip after finished since: a take of its own that stands for the draft the landing was made against
  const finished = opts.finishedAfter ? await take(b, await video({ width: 1152, height: 2048 }), { head_ms: 917, finished_from: draftB, join_kind: "pixels" }) : null;
  return { tl, a, b, ta, draftB, finished };
}

describe("a landing", () => {
  it("still lands once the clip after is finished: the finished take stands for its draft (HIGH 9)", async () => {
    const { tl, finished } = await landing({ finishedAfter: true });
    const v = await view(tl);
    expect(v.clips[1].take.id).toBe(finished);
    expect(v.clips[1].take.landedMs).toBe(167);
    expect(v.clips[1].join).toBe("fresh");
    // the clip before plays on into its guided tail: four frames past what it plays
    expect(v.clips[0].lengthMs).toBe(5000 - 917 + 167);
    expect(v.clips[1].take.startMs).toBe(917 + 167);
  });

  it("splits a landed clip at the frame seen there, not 167 ms later (HIGH 8)", async () => {
    const { tl, b } = await landing();
    const before = (await view(tl)).clips[1];
    const at = before.take.startMs + 1000;
    const { clip: second } = await call("POST", `/api/clips/${b}/split`, { atMs: at });
    const v = await view(tl);
    const [first, after] = [v.clips[1], v.clips.find((c: { id: string }) => c.id === second)];
    expect(first.take.endMs).toBe(at);
    expect(after.take.startMs).toBe(at);
    expect(first.lengthMs).toBe(1000);
    // a moment that is not seen (inside the landing's 167 ms) is refused
    await expect(call("POST", `/api/clips/${b}/split`, { atMs: 917 + 100 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("splits a seamless ×2 take at the frame seen, one frame before where it plays", async () => {
    const tl = (await t.services.timelines.create("Seam")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1);
    const ta = await take(a, await video({ fps: 48 }));
    await take(b, await video({ fps: 48 }), { head_ms: 917, join_kind: "seamless", prev_take_id: ta, prev_at_ms: 5000 });
    const shown = (await view(tl)).clips[1].take;
    expect(shown.seamless).toBe(true);
    expect(shown.startMs).toBe(917 - 21);
    const { clip: second } = await call("POST", `/api/clips/${b}/split`, { atMs: shown.startMs + 1000 });
    const v = await view(tl);
    expect(v.clips[1].take.endMs).toBe(shown.startMs + 1000);
    expect(v.clips.find((c: { id: string }) => c.id === second).take.startMs).toBe(shown.startMs + 1000);
  });

  it("is trimmed where it is seen, the server working out the trims (T-3), and keeps a tenth of a second at least (T-9)", async () => {
    const { tl, a, b } = await landing();
    let v = await view(tl);
    // the clip after: seen from 1084 ms; to be seen from 1584 ms
    await call("PATCH", `/api/clips/${b}`, { shownFromMs: v.clips[1].take.startMs + 500 });
    v = await view(tl);
    expect(v.clips[1].take.startMs).toBe(917 + 167 + 500);
    // the clip before: seen up to 4250 ms (into its tail); to stop at 3000 ms, as seen
    await call("PATCH", `/api/clips/${a}`, { shownToMs: 3000 });
    v = await view(tl);
    expect(v.clips[0].take.endMs).toBe(3000);
    expect(v.clips[0].lengthMs).toBe(3000);
    // trimmed to nothing: a tenth of a second still plays, and it is still a clip with a take
    await call("PATCH", `/api/clips/${a}`, { trimEndMs: 999_999 });
    v = await view(tl);
    expect(v.clips[0].lengthMs).toBe(LEAST_PLAY_MS);
    expect(v.clips[0].take).not.toBeNull();
  });

  it("says how much a take can play on its model's grid (T-4)", async () => {
    const tl = (await t.services.timelines.create("Room")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    // a ×2 render: 247 frames at 48 a second, 124 frames on the model's grid
    await take(a, await video({ duration_ms: 5146, fps: 48, latent_frames: 124 }), { head_ms: 917 });
    expect((await view(tl)).clips[0].take.roomMs).toBe(5167 - 917);
  });
});

describe("undo", () => {
  it("takes back the finished take it undoes, and Redo brings it back (HIGH 10)", async () => {
    const tl = (await t.services.timelines.create("Finish")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const draft = await take(a, await video());
    const done = await video({ width: 1152, height: 2048 });
    await t.services.timelines.takes.takeFrom(a, done, "the finished take", draft);
    expect((await view(tl)).clips[0].take.finishedFrom).toBe(draft);
    expect((await call("POST", `/api/timelines/${tl}/undo`)).undone).toBe("the finished take");
    let v = await view(tl);
    expect(v.clips[0].take.id).toBe(draft);
    expect(v.clips[0].takes).toHaveLength(1);
    await call("POST", `/api/timelines/${tl}/redo`);
    v = await view(tl);
    expect(v.clips[0].take.finishedFrom).toBe(draft);
    // undone again after the redo: gone again
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips[0].takes).toHaveLength(1);
  });

  it("puts the project and the folder back (HIGH 11)", async () => {
    const project = await call("POST", "/api/projects", { name: "Holiday" });
    const folder = await call("POST", "/api/folders", { name: "Rushes" });
    const tl = (await t.services.timelines.create("Moving")).id;
    await call("PATCH", `/api/timelines/${tl}`, { folder: folder.id });
    expect(await view(tl)).toMatchObject({ folderId: folder.id, folderChosen: true });
    await call("PATCH", `/api/timelines/${tl}`, { project: project.id });
    expect((await view(tl)).projectId).toBe(project.id);
    expect((await call("POST", `/api/timelines/${tl}/undo`)).undone).toBe("the project");
    expect((await view(tl)).projectId).toBeNull();
    expect((await call("POST", `/api/timelines/${tl}/undo`)).undone).toBe("the folder");
    expect(await view(tl)).toMatchObject({ folderId: null, folderChosen: false });
    await call("POST", `/api/timelines/${tl}/redo`);
    expect(await view(tl)).toMatchObject({ folderId: folder.id, folderChosen: true });
  });

  it("takes back one step per request, however many come at once (T-1)", async () => {
    const tl = (await t.services.timelines.create("One")).id;
    for (const name of ["Two", "Three", "Four"]) await call("PATCH", `/api/timelines/${tl}`, { name });
    const undone = await Promise.all([1, 2, 3].map(() => call("POST", `/api/timelines/${tl}/undo`)));
    expect(undone.map((u) => u.undone)).toEqual(["the new name", "the new name", "the new name"]);
    expect((await view(tl)).name).toBe("One");
    // steps kept at once each have their own number
    await Promise.all(["A", "B", "C"].map((name) => call("PATCH", `/api/timelines/${tl}`, { name })));
    const seqs = (await t.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", tl).execute()).map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("puts back a step kept while takes still had lead_ms (dropped in 0042)", async () => {
    const tl = (await t.services.timelines.create("Old step")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const ta = await take(a, await video());
    await call("PATCH", `/api/timelines/${tl}`, { name: "New" });
    const step = await t.db.selectFrom("timeline_history").selectAll().where("timeline_id", "=", tl).executeTakeFirstOrThrow();
    const kept = JSON.parse(step.snapshot) as { takes: Array<Record<string, unknown>> };
    expect(kept.takes).toHaveLength(1);
    for (const x of kept.takes) x.lead_ms = 167;
    await t.db.updateTable("timeline_history").set({ snapshot: JSON.stringify(kept) }).where("id", "=", step.id).execute();
    expect((await call("POST", `/api/timelines/${tl}/undo`)).undone).toBe("the new name");
    const v = await view(tl);
    expect(v.name).toBe("Old step");
    expect(v.clips[0].take.id).toBe(ta);
  });

  it("keeps no step for an edit it refuses, and writes none of it (T-5)", async () => {
    const tl = (await t.services.timelines.create("Refused")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    await take(a, await video());
    await call("PATCH", `/api/timelines/${tl}`, { name: "Kept" });
    const before = (await view(tl)).undo;
    // a move after a clip that is not there, with a trim: refused whole
    await expect(call("PATCH", `/api/clips/${a}`, { after: "nowhere", trimEndMs: 500 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call("PATCH", `/api/clips/${a}`, { take: "nothing", volume: 10 })).rejects.toMatchObject({ statusCode: 404 });
    const v = await view(tl);
    expect(v.undo).toBe(before);
    expect(v.clips[0]).toMatchObject({ volume: 100, take: { trimEndMs: 0 } });
    // a clip added after one that is not there is refused too (it went first before)
    await expect(call("POST", `/api/timelines/${tl}/clips`, { after: "nowhere", recipe: "h3.video" })).rejects.toMatchObject({ statusCode: 404 });
    expect((await view(tl)).clips).toHaveLength(1);
  });

  it("gives a new clip the cast of the clip before when that one has its own", async () => {
    const tl = (await t.services.timelines.create("Cast")).id;
    const him = await call("POST", "/api/entities", { kind: "person", name: "Him" });
    const a = (await call("POST", `/api/timelines/${tl}/clips`, { recipe: "h3.video" })).clip;
    // the first clip follows the timeline's cast (none here); a new clip after it does too
    const b = (await call("POST", `/api/timelines/${tl}/clips`, { after: a })).clip;
    expect((await view(tl)).clips[1].look).toBeNull();
    // set for one clip only: the clip added after it carries it, the timeline's stays as it was
    const look = { cast: [{ id: him.id }], style: null };
    await call("PATCH", `/api/clips/${b}`, { look });
    await call("POST", `/api/timelines/${tl}/clips`, { after: b });
    const v = await view(tl);
    expect(v.clips[2].look).toMatchObject(look);
    expect(v.look ?? null).toBeNull();
  });

  it("makes one step of a planned scene (LOW) and of Extend from this frame", async () => {
    const tl = (await t.services.timelines.create("Plan")).id;
    const made = await call("POST", `/api/timelines/${tl}/plan`, { recipe: "h3.video", clips: [{ description: "One." }, { description: "Two." }, { description: "Three." }] });
    expect(made.clips).toHaveLength(3);
    expect(made.timeline.clips.map((c: { inputs: { description: string } }) => c.inputs.description)).toEqual(["One.", "Two.", "Three."]);
    expect(await t.db.selectFrom("timeline_history").select("id").where("timeline_id", "=", tl).execute()).toHaveLength(1);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(0);

    const a = await clip(tl, 0, { joined: "cut" });
    await take(a, await video());
    const steps = (await t.db.selectFrom("timeline_history").select("id").where("timeline_id", "=", tl).execute()).length;
    await call("POST", `/api/timelines/${tl}/clips`, { after: a, stopAtMs: 2000 });
    const v = await view(tl);
    expect(v.clips).toHaveLength(2);
    expect(v.clips[0].lengthMs).toBe(2000);
    expect(await t.db.selectFrom("timeline_history").select("id").where("timeline_id", "=", tl).execute()).toHaveLength(steps + 1);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips[0].lengthMs).toBe(5000);
  });
});

describe("takes", () => {
  it("a duplicate's finished take is the finished version of the duplicate's own draft; a split keeps the mark (T-2)", async () => {
    const tl = (await t.services.timelines.create("Copies")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const draft = await take(a, await video(), {}, false);
    await take(a, await video({ width: 1152, height: 2048 }), { finished_from: draft });
    const { clip: copy } = await call("POST", `/api/clips/${a}/duplicate`);
    const c = (await view(tl)).clips.find((x: { id: string }) => x.id === copy);
    const [copyDraft, copyDone] = c.takes;
    expect(copyDone.finishedFrom).toBe(copyDraft.id);
    expect(copyDraft.id).not.toBe(draft);
    const { clip: second } = await call("POST", `/api/clips/${a}/split`, { atMs: 2500 });
    // the second half is as finished as the clip was, the finish of a draft of its own (a copy of the first's, B-2)
    const half = (await view(tl)).clips.find((x: { id: string }) => x.id === second);
    const ownDraft = half.takes.find((x: { id: string }) => x.id === half.take.finishedFrom);
    expect(ownDraft).toBeDefined();
    expect(ownDraft.id).not.toBe(draft);
    expect(ownDraft.asset.id).toBe((await t.db.selectFrom("takes").select("asset_id").where("id", "=", draft).executeTakeFirstOrThrow()).asset_id);
  });

  it("a split of a mirrored clip finished by an upscale keeps both halves the clip as it stands: no re-render asked (B-2)", async () => {
    const tl = (await t.services.timelines.create("zz-test split mirror")).id;
    const pin = await video({ kind: "image", mime: "image/png", name: "zz-test pin.png" });
    const a = await clip(tl, 0, { joined: "cut", inputs: JSON.stringify({ description: "A lighthouse.", start: pin.id }), pin_mirror: JSON.stringify({ start: true }) });
    // the draft was rendered with the start frame flipped; the finish (an upscale model, SeedVR2, RTX) is a render of no flips
    const generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: JSON.stringify({ mirror: ["start"] }), gen_ms: 1, draft_id: null, created_at: now() }).execute();
    const draft = await take(a, await video({ generation_id: generation }), {}, false);
    await take(a, await video({ width: 1152, height: 2048 }), { finished_from: draft });
    expect((await view(tl)).clips[0].mirrorChanged).toBe(false);
    await call("POST", `/api/clips/${a}/split`, { atMs: 2500 });
    const v = await view(tl);
    expect(v.clips.map((c: { mirrorChanged: boolean }) => c.mirrorChanged)).toEqual([false, false]);
    // the first half's draft can still go once its own finish has: the second half's finish leans on a draft of its own
    await call("DELETE", `/api/takes/${v.clips[0].take.id}`);
    await call("DELETE", `/api/takes/${draft}`);
    expect((await view(tl)).clips[1].mirrorChanged).toBe(false);
  });

  it("places a tool's video once, however many times it is handed back (T-6)", async () => {
    const tl = (await t.services.timelines.create("Twice")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    await take(a, await video());
    const slowed = await video();
    await t.services.timelines.takes.takeFrom(a, slowed);
    await t.services.timelines.takes.takeFrom(a, slowed);
    expect((await view(tl)).clips[0].takes).toHaveLength(2);
  });

  it("a finish whose draft was removed plays what its draft played, not its hidden run-up (LOW)", async () => {
    const tl = (await t.services.timelines.create("Gone")).id;
    const a = await clip(tl, 0);
    const generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: JSON.stringify({ overlap: { headMs: 917, tailMs: 0 } }), gen_ms: 1, draft_id: null, created_at: now() }).execute();
    const drafted = await video({ generation_id: generation });
    const finished = await video({ source_id: drafted.id, width: 1152, height: 2048 });
    await t.services.timelines.takes.takeFrom(a, finished, "the finished take", "a-removed-draft");
    expect((await view(tl)).clips[0].take).toMatchObject({ headMs: 917, startMs: 917 });
  });

  it("reads a take's measure from its own column, filled from resolved for the renders before it (T-8)", async () => {
    const tl = (await t.services.timelines.create("Measured")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1, { joined: "cut" });
    const measure = { luma: 101.5, sharp: 3.25, handover: 1.5 };
    const gen = (id: string, resolved: object) =>
      t.db.insertInto("generations").values({ id, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: JSON.stringify(resolved), gen_ms: 1, draft_id: null, created_at: now() }).execute();
    await gen("measured", { seed: 1, measure });
    await gen("plain", { seed: 2 });
    await take(a, await video({ generation_id: "measured" }));
    await take(b, await video({ generation_id: "plain" }));
    // rows written before 0041 have it in resolved only: the migration takes it out, the other rows left null
    const m0041 = (await import("../src/migrations/0041-generation-measure")).default;
    await m0041.down!(t.db as never);
    await m0041.up(t.db as never);
    const rows = await t.db.selectFrom("generations").select(["id", "measure"]).where("id", "in", ["measured", "plain"]).orderBy("id").execute();
    expect(rows.map((r) => [r.id, r.measure && JSON.parse(r.measure)])).toEqual([["measured", measure], ["plain", null]]);
    const v = await view(tl);
    expect(v.clips[0].take.measure).toEqual(measure);
    expect(v.clips[1].take.measure).toBeNull();
    // read anew each time: nothing kept in memory
    await t.db.updateTable("generations").set({ measure: JSON.stringify({ ...measure, luma: 90 }) }).where("id", "=", "measured").execute();
    expect((await view(tl)).clips[0].take.measure.luma).toBe(90);
  });

  it("gives a finished take the figures of the take it was finished from, and none when that take is gone", async () => {
    const tl = (await t.services.timelines.create("Finished figures")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1, { joined: "cut" });
    const measure = { luma: 88, sharp: 2.5, handover: 1.2 };
    await t.db.insertInto("generations").values({ id: "source", owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: "{}", measure: JSON.stringify(measure), gen_ms: 1, draft_id: null, created_at: now() }).execute();
    const source = await take(a, await video({ generation_id: "source" }), {}, false);
    // the upscale is a cut's video: no generation, no measure of its own
    await take(a, await video({ width: 1152, height: 2048 }), { finished_from: source });
    await take(b, await video({ width: 1152, height: 2048 }), { finished_from: "a-take-since-removed" });
    const v = await view(tl);
    expect(v.clips[0].take.measure).toEqual(measure);
    expect(v.clips[0].takes.map((x: { measure: unknown }) => x.measure)).toEqual([measure, measure]);
    expect(v.clips[1].take.measure).toBeNull();
  });

  it("reads the failure of a clip's last job only, whatever ran before (T-8)", async () => {
    const tl = (await t.services.timelines.create("Jobs")).id;
    const a = await clip(tl, 0);
    const job = (id: string, status: "done" | "failed", error: string | null, agoMs: number) => {
      const at = new Date(Date.now() - agoMs).toISOString();
      return t.db.insertInto("jobs").values({
        id, owner_id: OWNER, recipe_id: "h3.video", label: "clip", inputs: "{}", status, warm: 0, look: null, priority: 10, depends_on: null, attempts: 1, resume: null, error,
        generation_id: null, clip_id: a, clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null, finished_from: null, created_at: at, started_at: at, finished_at: at, updated_at: at,
      }).execute();
    };
    for (let i = 0; i < 30; i++) await job(`old-${i}`, "failed", "out of memory", 100_000 - i);
    expect((await view(tl)).clips[0].failed).toBe("out of memory");
    await job("last", "done", null, 0);
    expect((await view(tl)).clips[0]).toMatchObject({ failed: null, job: null });
  });
});

describe("where a clip ends (A10)", () => {
  it("keeps the choice to end where the next clip begins on the clip, and every render goes by it", async () => {
    const tl = (await t.services.timelines.create("Fit")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1);
    const fitOf = async () => {
      const jobs = await t.db.selectFrom("jobs").select(["clip_fit"]).where("clip_id", "=", a).execute();
      return jobs.length === 1 ? jobs[0]!.clip_fit : jobs.length;
    };
    const render = (fit?: boolean) => call("POST", `/api/timelines/${tl}/render`, { clips: [{ id: a, input: { description: "She waves." }, ...(fit === undefined ? {} : { fit }) }] });
    // on unless turned off
    expect((await view(tl)).clips.map((c: { fitNext: boolean }) => c.fitNext)).toEqual([true, true]);
    await render();
    expect(await fitOf()).toBe(1);
    await call("PATCH", `/api/clips/${a}`, { fitNext: false });
    expect((await view(tl)).clips[0].fitNext).toBe(false);
    // a render that does not say (Ctrl+Enter, the track, Render all) takes the clip's own choice
    await t.db.deleteFrom("jobs").where("clip_id", "=", a).execute();
    await render();
    expect(await fitOf()).toBe(0);
    // one that says wins
    await t.db.deleteFrom("jobs").where("clip_id", "=", a).execute();
    await render(true);
    expect(await fitOf()).toBe(1);
    // rendered together with the clip after it, there is nothing to land on, whatever the clip says
    await call("PATCH", `/api/clips/${a}`, { fitNext: true });
    await t.db.deleteFrom("jobs").where("clip_id", "in", [a, b]).execute();
    await call("POST", `/api/timelines/${tl}/render`, { clips: [{ id: a, input: { description: "She waves." } }, { id: b, input: { description: "She sits." } }] });
    expect(await fitOf()).toBe(0);
  });
});

describe("a range", () => {
  it("removed takes the clips with nothing to play that stand inside it (LOW)", async () => {
    const tl = (await t.services.timelines.create("Range")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    await take(a, await video());
    const empty = await clip(tl, 1);
    const b = await clip(tl, 2, { joined: "cut" });
    await take(b, await video());
    const at = await clip(tl, 3);
    // the empty clip stands at 5 s, inside 4–6 s; the one at the end, at 10 s, does not
    await call("POST", `/api/timelines/${tl}/range`, { inMs: 4000, outMs: 6000, action: "remove" });
    const ids = (await view(tl)).clips.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(empty);
    expect(ids).toContain(at);
  });
});

describe("the export", () => {
  it("is queued once when two tabs ask at the same moment (LOW)", async () => {
    const tl = (await t.services.timelines.create("Twice")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    await take(a, await video());
    const [one, two] = await Promise.all([call("POST", `/api/timelines/${tl}/export`, {}), call("POST", `/api/timelines/${tl}/export`, {})]);
    expect(one.id).toBe(two.id);
  });
});

describe("what is worked out of a video", () => {
  it("is kept by the browser for good only when its address names the file's version (LOW)", async () => {
    const asset = await video();
    await t.services.storage.put(`motion/${asset.id.slice(0, 2)}/${asset.id}.json`, new TextEncoder().encode(JSON.stringify({ rate: 10, values: [1, 2], sound: null })));
    expect((await get(t.app, `/api/assets/${asset.id}/motion`)).headers["cache-control"]).toBe("private, no-cache");
    expect((await get(t.app, `/api/assets/${asset.id}/motion?v=1000-1`)).headers["cache-control"]).toMatch(/immutable/);
  });

  it("gives the player the export's colour carry past a clip with nothing to play (LOW)", async () => {
    const tl = (await t.services.timelines.create("Carry")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const va = await video();
    await take(a, va);
    await clip(tl, 1);
    const b = await clip(tl, 2, { joined: "cut" });
    const vb = await video();
    await take(b, vb);
    // their colour along them, as worked out once and kept: every frame the same
    const along = (y: number) => ({ t: Array.from({ length: 120 }, (_, i) => Math.round((i * 1000) / 24)), y: Array(120).fill(y), u: Array(120).fill(128), v: Array(120).fill(128) });
    for (const [asset, y] of [[va, 120], [vb, 110]] as const) await t.services.storage.put(`means/${asset.id.slice(0, 2)}/${asset.id}.json`, new TextEncoder().encode(JSON.stringify(along(y))));
    const { items } = await call("GET", `/api/timelines/${tl}/match`);
    expect(items.map((m: { y: number }) => m.y)).toEqual([0, 0, colourNudge({ y: 120, u: 128, v: 128 }, { y: 110, u: 128, v: 128 }, { y: 0, u: 0, v: 0 }).y]);
    expect(items[2].y).toBe(10);
  });

  it("does not land a clip whose own last frame is pinned on the clip after", async () => {
    const tl = (await t.services.timelines.create("Harbor walk")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1);
    await take(b, await video());
    const pinned = await video({ kind: "image", mime: "image/png", name: "end.png", duration_ms: null });
    const recipe = t.services.registry.recipe("h3.video")!;
    const free = await t.services.timelines.plan(a, recipe, {}, true);
    expect(free.links.next).toBeDefined();
    expect(free.input.next).toBeDefined();
    const ends = await t.services.timelines.plan(a, recipe, { end: pinned.id }, true);
    expect(ends.links.next).toBeUndefined();
    expect(ends.input.next).toBeUndefined();
    expect(ends.input.end).toBe(pinned.id);
  });

  it("says that ffmpeg is missing rather than taking it for a clip that moves to its end (LOW)", async () => {
    const tl = (await t.services.timelines.create("No ffmpeg")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const before = await video();
    await take(a, before);
    // a file there to be read, by a tool that is not
    await t.services.storage.put(before.file_key, new Uint8Array([0, 0, 0, 1]));
    const b = await clip(tl, 1);
    const was = { ...tools };
    tools.ffmpeg = "afflatus-no-such-ffmpeg";
    tools.ffprobe = "afflatus-no-such-ffprobe";
    try {
      await expect(t.services.timelines.plan(b, t.services.registry.recipe("h3.video")!, {}, false)).rejects.toThrow(/ffmpeg/);
    } finally {
      Object.assign(tools, was);
    }
  });
});

describe("the join sums shared by the server and the player", () => {
  it("two moments are the same within about a frame", () => {
    expect(near(1000, 1040)).toBe(true);
    expect(near(1000, 1050)).toBe(false);
    expect(near(null, 0)).toBe(false);
  });
  it("fades as the export and the player both do", () => {
    expect(joinFade({ landedMs: 167, joined: true, seamless: false, sharedMs: 917 })).toEqual({ ms: 167, mode: "overlap" });
    expect(joinFade({ landedMs: 40, joined: true, seamless: false, sharedMs: 917 })).toBeNull();
    expect(joinFade({ joined: true, seamless: false, sharedMs: 917 })).toEqual({ ms: 170, mode: "hold" });
    expect(joinFade({ joined: true, seamless: true, sharedMs: 917 })).toBeNull();
    expect(joinFade({ joined: false, seamless: false, sharedMs: 917 })).toBeNull();
    expect(joinFade({ joined: true, seamless: false, sharedMs: 60 })).toBeNull();
  });
  it("puts joins on H3's latent grid", () => {
    expect(latentFrameAtOrBefore(73)).toBe(73);
    expect(latentFrameAtOrBefore(80)).toBe(73);
    expect(latentFrameAtOrBefore(22)).toBe(22);
    expect(chunkAtOrAfter(23)).toBe(34);
    expect(chunkAtOrAfter(34)).toBe(34);
  });
  it("picks up a clip trimmed by hand on its latent's grid, so the join stays in the latent", () => {
    const before = { durationMs: 5167, latentFrames: 124 };
    // 4.1 s is frame 98, 4.958 s frame 119: both off the grid, back to frame 90 and 107
    expect(handoverOnGrid(4100, before, 39)).toBe(3750);
    expect(handoverOnGrid(4958, before, 39)).toBe(4458);
    // on the grid already, or the very end (the whole latent): as asked
    expect(handoverOnGrid(4458, before, 39)).toBe(4458);
    expect(handoverOnGrid(5150, before, 39)).toBe(5150);
    // a grid frame shorter than the run-up asked for, or no latent kept: as asked, joined on frames
    expect(handoverOnGrid(1500, before, 39)).toBe(1500);
    expect(handoverOnGrid(4100, { durationMs: 5167, latentFrames: null }, 22)).toBe(4100);
  });
  it("marks a landing on a finished take as on its draft (markJoins)", () => {
    const asset = { duration_ms: 5000, latent_frames: null, fps: 24 } as AssetRow;
    const row = (o: Partial<TakeRow>) => ({ head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, ...o }) as TakeRow;
    const placed = (id: string, take: TakeRow, joined: ClipRow["joined"]) => {
      const x = { take, asset };
      return { clip: { id, kind: "video", joined } as ClipRow, takes: [x], active: x, still: null, sound: null, pictures: [] } as Placed;
    };
    const all = [placed("a", row({ id: "ta", tail_ms: 917, next_take_id: "draft", next_at_ms: 917 }), "cut"), placed("b", row({ id: "done", head_ms: 917, finished_from: "draft" }), "continue")];
    markJoins(all);
    expect(all[1]!.active!.landed).toBe(167);
    expect(all[0]!.active!.give).toBe(-167);
  });
  it("works trims out of what is to be seen, the end giving way first, a tenth of a second always left", () => {
    const x = { take: { head_ms: 917, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0 } as TakeRow, asset: { duration_ms: 5000, latent_frames: null } as AssetRow };
    expect(trimsOf(x, { shownFromMs: 1500 })).toEqual({ start: 583, end: 0 });
    expect(trimsOf(x, { shownToMs: 4000 })).toEqual({ start: 0, end: 1000 });
    expect(trimsOf(x, { trimEndMs: 99_999 })).toEqual({ start: 0, end: 5000 - 917 - LEAST_PLAY_MS });
    expect(trimsOf(x, { shownFromMs: 99_999 })).toEqual({ start: 5000 - 917 - LEAST_PLAY_MS, end: 0 });
  });
});

/** A test clip made with ffmpeg: a moving pattern. Skipped where ffmpeg is not installed. */
function makeClip(seconds: number): { file: string; bytes: Uint8Array; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-fix-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=192x320:rate=24:duration=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  if (made.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return { file, bytes: new Uint8Array(readFileSync(file)), dir };
}
const sample = makeClip(2);

describe.skipIf(!sample)("videos handed to ffmpeg by path", () => {
  afterAll(() => rmSync(sample!.dir, { recursive: true, force: true }));
  it("join the same as from their bytes", async () => {
    const part = (source: string | Uint8Array) => ({ kind: "video" as const, source, ext: "mp4", startMs: 0, endMs: 1000, hasSound: false, sound: "own" as const, volume: 1, fill: false });
    const joined = (source: string | Uint8Array) => joinVideosInto([part(source), part(source)], { width: 192, height: 320 }, 24, {}, (file) => readFile(file));
    const fromPath = await joined(sample!.file);
    const fromBytes = await joined(sample!.bytes);
    expect(fromPath.length).toBeGreaterThan(1000);
    expect(Math.abs(fromPath.length - fromBytes.length)).toBeLessThan(fromBytes.length * 0.05);
  });
  it("read a stretch's colour off the video's frame means as the export measures it", async () => {
    const along = await meansAlong(sample!.file, "mp4");
    expect(along.t.length).toBeGreaterThanOrEqual(47);
    const direct = await meansOf(sample!.file, 0.6, 0.4);
    const read = meansWithin(along, 600, 0.4);
    expect(read).not.toBeNull();
    for (const k of ["y", "u", "v"] as const) expect(Math.abs(read![k] - direct![k])).toBeLessThan(0.5);
  });
});
