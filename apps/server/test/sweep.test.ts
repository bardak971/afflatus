import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { BIN_MS, sweep, UNKEPT_MS } from "../src/sweep";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function add(over: { kept?: boolean; madeAgo: number; binnedAgo?: number; origin?: "generated" | "uploaded" }): Promise<string> {
  const id = newId();
  const key = `assets/${id}.png`;
  await t.services.storage.put(key, new Uint8Array([1]));
  await t.db
    .insertInto("assets")
    .values({
      id, owner_id: OWNER, kind: "image", origin: over.origin ?? "generated", name: "", file_key: key, thumb_key: null, mime: "image/png",
      bytes: 1, width: 1, height: 1, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
      kept_at: over.kept ? ago(0) : null, deleted_at: over.binnedAgo === undefined ? null : ago(over.binnedAgo), created_at: ago(over.madeAgo),
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
