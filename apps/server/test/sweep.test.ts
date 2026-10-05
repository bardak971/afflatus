import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { BIN_MS, sweep, UNKEPT_MS } from "../src/sweep";
import { derivedKeys } from "../src/timelines";
import { makeApp, type TestApp } from "./helpers";

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

  it("erases what the timeline worked out of a video along with it: its film strips, motion and scene cuts", async () => {
    const old = await add({ madeAgo: 0, kept: true, binnedAgo: BIN_MS + HOUR, durationMs: 30_000 });
    const keys = derivedKeys({ id: old, duration_ms: 30_000 });
    const dir = old.slice(0, 2);
    expect(keys).toEqual([`strips/${dir}/${old}.jpg`, `strips/${dir}/${old}-30x48.jpg`, `motion/${dir}/${old}.json`, `scenes/${dir}/${old}.json`]);
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
