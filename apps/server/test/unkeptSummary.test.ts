import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

type Summary = { count: number; from: string | null; to: string | null; ids?: string[] };

async function add(over: { kind?: "image" | "audio"; name?: string; kept?: boolean; binned?: boolean; at: number; countdown?: number }): Promise<string> {
  const id = newId();
  const { kind = "image", name = "" } = over;
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind, origin: "generated", name, file_key: `assets/${id}`, thumb_key: null, mime: kind === "audio" ? "audio/mpeg" : "image/png",
    bytes: 1, width: 1, height: 1, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
    kept_at: over.kept ? new Date().toISOString() : null, deleted_at: over.binned ? new Date().toISOString() : null, created_at: new Date(over.at).toISOString(),
    countdown_from: over.countdown ? new Date(over.countdown).toISOString() : null,
  }).execute();
  return id;
}
const summary = async (query = "") => (await get(t.app, `/api/assets/unkept${query}`)).json() as Summary;

describe("the items not kept, summed up", () => {
  it("counts them across the view, says when the first and the last countdown started, ids only when asked", async () => {
    const now = Date.now();
    const a = await add({ at: now - 5 * 3_600_000 });
    // unkept again an hour ago: its countdown runs from then, not from its making
    const b = await add({ at: now - 20 * 3_600_000, countdown: now - 3_600_000 });
    const c = await add({ at: now - 2 * 3_600_000, kind: "audio" });
    await add({ at: now - 10 * 3_600_000, kept: true });
    await add({ at: now - 3 * 3_600_000, binned: true });

    const all = await summary();
    expect(all.count).toBe(3);
    expect(all.from).toBe(new Date(now - 5 * 3_600_000).toISOString());
    expect(all.to).toBe(new Date(now - 3_600_000).toISOString());
    expect(all.ids).toBeUndefined();

    const withIds = await summary("?ids=1");
    expect(new Set(withIds.ids)).toEqual(new Set([a, b, c]));

    // the list's filters hold; kept and bin are the endpoint's own
    const images = await summary("?kind=image&kept=1&bin=1&ids=1");
    expect(images.count).toBe(2);
    expect(new Set(images.ids)).toEqual(new Set([a, b]));
  });

  it("sums up a search by words too", async () => {
    const now = Date.now();
    const sunset = await add({ at: now - 3_600_000, name: "sunset harbour" });
    await add({ at: now - 2 * 3_600_000, name: "mountain" });
    const found = await summary("?q=sunset&ids=1");
    expect(found.count).toBe(1);
    expect(found.ids).toEqual([sunset]);
    expect(found.from).toBe(found.to);
  });

  it("says nothing to keep when everything is kept", async () => {
    await add({ at: Date.now(), kept: true });
    expect(await summary()).toEqual({ count: 0, from: null, to: null });
  });
});
