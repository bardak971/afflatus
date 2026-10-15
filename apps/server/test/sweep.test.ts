import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { BIN_MS, keepOf, sweep, UNKEPT_MS } from "../src/sweep";
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

  it("erases what the timeline worked out of a video along with it: its film strips, motion, scene cuts, colour along it and join scores", async () => {
    const old = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR, durationMs: 30_000 });
    const keys = derivedKeys({ id: old, duration_ms: 30_000 });
    const dir = old.slice(0, 2);
    // the strips under their names since `-2`, and under the names before
    expect(keys).toEqual([`strips/${dir}/${old}-2.jpg`, `strips/${dir}/${old}-30x48-2.jpg`, `strips/${dir}/${old}.jpg`, `strips/${dir}/${old}-30x48.jpg`, `motion/${dir}/${old}.json`, `scenes/${dir}/${old}.json`, `means/${dir}/${old}.json`, `joins/${dir}/${old}.json`]);
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
