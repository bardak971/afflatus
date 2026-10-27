import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { BIN_MS, inUse, keepOf, sweep, UNKEPT_MS } from "../src/sweep";
import { derivedKeys } from "../src/timelineModel";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function add(over: { kept?: boolean; madeAgo: number; countdownAgo?: number; binnedAgo?: number; origin?: "generated" | "uploaded"; durationMs?: number }): Promise<string> {
  const id = newId();
  const key = `assets/${id}.png`;
  await t.services.storage.put(key, new Uint8Array([1]));
  await t.db
    .insertInto("assets")
    .values({
      id, owner_id: OWNER, kind: over.durationMs ? "video" : "image", origin: over.origin ?? "generated", name: "", file_key: key, thumb_key: null, mime: over.durationMs ? "video/mp4" : "image/png",
      bytes: 1, width: 1, height: 1, duration_ms: over.durationMs ?? null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
      kept_at: over.kept ? ago(0) : null, countdown_from: over.countdownAgo === undefined ? null : ago(over.countdownAgo),
      deleted_at: over.binnedAgo === undefined ? null : ago(over.binnedAgo), created_at: ago(over.madeAgo),
    })
    .execute();
  return id;
}
const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();

describe("sweep", () => {
  it("bins results nobody kept after a day, and nothing else", async () => {
    const fresh = await add({ madeAgo: UNKEPT_MS - HOUR });
    const stale = await add({ madeAgo: UNKEPT_MS + HOUR });
    const kept = await add({ madeAgo: UNKEPT_MS + HOUR, kept: true });
    const mine = await add({ madeAgo: UNKEPT_MS + HOUR, origin: "uploaded" });

    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 1, erased: 0 });
    expect((await row(stale))!.deleted_at).not.toBeNull();
    for (const id of [fresh, kept, mine]) expect((await row(id))!.deleted_at).toBeNull();
  });

  it("counts the day from where the countdown was last started again: unkept after a long time kept, or back from the bin", async () => {
    const restarted = await add({ madeAgo: 3 * UNKEPT_MS, countdownAgo: HOUR });
    const lapsed = await add({ madeAgo: 3 * UNKEPT_MS, countdownAgo: UNKEPT_MS + HOUR });

    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 1, erased: 0 });
    expect((await row(lapsed))!.deleted_at).not.toBeNull();
    expect((await row(restarted))!.deleted_at).toBeNull();
  });

  it("erases what the timeline worked out of a video along with it: its film strips, motion, scene cuts, a sound's pauses, colour along it, join scores, a take's sound end and a recording's gain", async () => {
    const old = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR, durationMs: 30_000 });
    const keys = derivedKeys({ id: old, duration_ms: 30_000 });
    const dir = old.slice(0, 2);
    // the strips under their names since `-2`, and under the names before
    expect(keys).toEqual([`strips/${dir}/${old}-2.jpg`, `strips/${dir}/${old}-30x48-2.jpg`, `strips/${dir}/${old}.jpg`, `strips/${dir}/${old}-30x48.jpg`, `motion/${dir}/${old}.json`, `scenes/${dir}/${old}.json`, `pauses/${dir}/${old}.json`, `means/${dir}/${old}.json`, `joins/${dir}/${old}.json`, `sounds/${dir}/${old}.json`, `gains/${dir}/${old}.json`]);
    for (const key of keys) await t.services.storage.put(key, new Uint8Array([1]));

    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 0, erased: 1 });
    for (const key of keys) await expect(t.services.storage.get(key)).rejects.toThrow();
  });

  it("erases what has been in the bin for a week, with its file", async () => {
    const recent = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS - HOUR });
    const old = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR });
    const key = (await row(old))!.file_key;

    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 0, erased: 1 });
    expect(await row(old)).toBeUndefined();
    await expect(t.services.storage.get(key)).rejects.toThrow();
    expect(await row(recent)).toBeDefined();
  });
});

describe("sweep, and what a timeline's Undo and Redo would put back", () => {
  it("erases no video a step of Undo or Redo names, inside its clips' inputs and its source too: an Undo brings the clip back with its take", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test undo" } })).json().id as string;
    const [take, still, parked, redone, loose] = (await Promise.all([1, 2, 3, 4, 5].map(() => add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR })))) as [string, string, string, string, string];
    // a snapshot as TimelineHistory keeps one: the row, its clips and their takes; the clip's inputs and the source as JSON strings
    const snapshot = (takeAsset: string, inside: string) => JSON.stringify({
      timeline: { id: tl, source: JSON.stringify({ parked: [{ clip: { inputs: JSON.stringify({ picture: inside }) }, takes: [{ asset_id: inside }] }] }) },
      clips: [{ id: "c", inputs: JSON.stringify({ picture: inside }) }],
      takes: [{ id: "t", clip_id: "c", asset_id: takeAsset }],
    });
    await t.db.insertInto("timeline_history").values({ id: newId(), timeline_id: tl, seq: 1, label: "zz-test", snapshot: snapshot(take, still), created_at: ago(0) }).execute();
    await t.db.insertInto("timeline_future").values({ id: newId(), timeline_id: tl, seq: 1, label: "zz-test", snapshot: snapshot(redone, parked), created_at: ago(0) }).execute();
    const used = await inUse(t.db, { undo: true });
    for (const id of [take, still, parked, redone]) expect(used.get(id)).toBe("a timeline's Undo");
    // the bin and Unkeep do not read them: an item named only there can be binned, and a restore takes it back out (T-27)
    for (const id of [take, still, parked, redone]) expect((await inUse(t.db)).has(id)).toBe(false);
    // what works the takes out on its own (the unused takes) does not read them
    expect((await inUse(t.db, { takes: false })).has(take)).toBe(false);
    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 0, erased: 1 });
    expect(await row(loose)).toBeUndefined();
    for (const id of [take, still, parked, redone]) expect(await row(id)).toBeDefined();
  });
});

describe("inUse's Undo snapshots, a page at a time (T-25)", () => {
  it("reads every snapshot, past the first page too", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test pages" } })).json().id as string;
    const late = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR });
    const rows = Array.from({ length: 250 }, (_, k) => ({ id: newId(), timeline_id: tl, seq: k + 1, label: "zz-test", snapshot: JSON.stringify({ timeline: { id: tl }, clips: [], takes: k === 249 ? [{ id: "t", clip_id: "c", asset_id: late }] : [] }), created_at: ago(0) }));
    await t.db.insertInto("timeline_history").values(rows).execute();
    expect((await inUse(t.db, { undo: true })).get(late)).toBe("a timeline's Undo");
    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 0, erased: 0 });
  });
});

describe("sweep, as long as the settings say", () => {
  const DAY = 24 * HOUR;
  it("reads the days from the settings: 0 is never", () => {
    expect(keepOf({ unkeptDays: 1, binDays: 7 })).toEqual({ unkeptMs: UNKEPT_MS, binMs: BIN_MS });
    expect(keepOf({ unkeptDays: 3, binDays: 30 })).toEqual({ unkeptMs: 3 * DAY, binMs: 30 * DAY });
    expect(keepOf({ unkeptDays: 0, binDays: 0 })).toEqual({ unkeptMs: null, binMs: null });
  });

  it("gives an unkept result its days, and bins nothing on its own when told never", async () => {
    const two = await add({ madeAgo: 2 * DAY });
    const four = await add({ madeAgo: 4 * DAY });
    expect(await sweep(t.db, t.services.storage, Date.now(), keepOf({ unkeptDays: 3, binDays: 7 }))).toEqual({ binned: 1, erased: 0 });
    expect((await row(four))!.deleted_at).not.toBeNull();
    expect((await row(two))!.deleted_at).toBeNull();
    expect(await sweep(t.db, t.services.storage, Date.now() + 365 * DAY, keepOf({ unkeptDays: 0, binDays: 0 }))).toEqual({ binned: 0, erased: 0 });
    expect((await row(two))!.deleted_at).toBeNull();
  });

  it("keeps the bin its days, and until emptied when told so", async () => {
    const ten = await add({ madeAgo: 0, kept: true, binnedAgo: 10 * DAY });
    expect(await sweep(t.db, t.services.storage, Date.now(), keepOf({ unkeptDays: 1, binDays: 30 }))).toEqual({ binned: 0, erased: 0 });
    expect(await sweep(t.db, t.services.storage, Date.now() + 365 * DAY, keepOf({ unkeptDays: 1, binDays: 0 }))).toEqual({ binned: 0, erased: 0 });
    expect(await row(ten)).toBeDefined();
    expect(await sweep(t.db, t.services.storage, Date.now() + 25 * DAY, keepOf({ unkeptDays: 1, binDays: 30 }))).toEqual({ binned: 0, erased: 1 });
  });

  it("are settings of their own, a day and a week at first, and only the choices offered", async () => {
    const s = (await get(t.app, "/api/settings")).json();
    expect([s.unkeptDays, s.binDays]).toEqual([1, 7]);
    const put = (body: object) => t.app.inject({ method: "PUT", url: "/api/settings", payload: body });
    expect((await put({ unkeptDays: 0, binDays: 30 })).json()).toMatchObject({ unkeptDays: 0, binDays: 30 });
    expect((await put({ unkeptDays: 2 })).statusCode).toBe(400);
  });
});
