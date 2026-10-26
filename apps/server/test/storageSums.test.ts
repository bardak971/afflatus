import type { KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, openSqlite, OWNER } from "../src/db";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * Settings › Storage's sums (`GET /api/storage`, P4): read by every page open (the command bar) on each change of the library,
 * so summed by SQL rather than every item sent through the database's thread and added up here.
 */

// how many rows the queries gave back, counted while `counting`
let rows = 0;
let counting = false;
const counter: KyselyPlugin = {
  transformQuery: (args) => args.node,
  transformResult: async ({ result }) => {
    if (counting) rows += result.rows.length;
    return result;
  },
};

let t: TestApp;
beforeEach(async () => {
  t = await makeApp({ db: openSqlite(":memory:").withPlugin(counter) });
});
afterEach(() => t.close());

/** An item of `kind` taking `bytes` (and `kept` beside it). */
async function item(kind: "image" | "video" | "audio", bytes: number, over: { kept?: boolean; binned?: boolean; origin?: "generated" | "uploaded"; keptBytes?: number } = {}) {
  const id = newId();
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind, origin: over.origin ?? "generated", name: "zz-test", file_key: `assets/${id}`, thumb_key: null, mime: "application/octet-stream",
    bytes, kept_bytes: over.keptBytes ?? 0, width: null, height: null, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
    kept_at: over.kept ? now() : null, deleted_at: over.binned ? now() : null, created_at: now(),
  }).execute();
  return id;
}

describe("where the space goes", () => {
  it("is summed by kind, bin, unkept and takes that never play, with a few rows read whatever the library's size", async () => {
    for (let i = 0; i < 40; i++) await item("image", 10, { kept: i % 2 === 0 });
    await item("image", 7, { binned: true });
    await item("video", 100, { keptBytes: 50 });
    await item("video", 30, { origin: "uploaded", kept: true });
    await item("audio", 5, { kept: true });
    await item("audio", 3, { binned: true });
    // a timeline whose clip plays one take; another take of it, not kept, never plays
    const timeline = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: {} })).json() as { id: string };
    const playing = await item("video", 20, { kept: true });
    const idle = await item("video", 60);
    const clip = (await t.app.inject({ method: "POST", url: `/api/timelines/${timeline.id}/clips`, payload: { asset: playing } })).json().clip as string;
    await t.db.insertInto("takes").values({ id: "zz-idle", clip_id: clip, asset_id: idle, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, created_at: now() }).execute();

    counting = true;
    const s = (await get(t.app, "/api/storage")).json();
    counting = false;
    expect(s).toEqual({
      total: 400 + 7 + 150 + 30 + 5 + 3 + 20 + 60,
      pictures: 400,
      videos: 150 + 30 + 20,
      sounds: 5,
      idleTakes: { count: 1, bytes: 60 },
      bin: { count: 2, bytes: 10 },
      // the 20 pictures not kept, the generated video and the idle take
      unkept: { count: 22, bytes: 200 + 150 + 60 },
    });
    // the library's 48 items are not each read: its groups, the timeline's takes and clips
    expect(rows).toBeLessThan(20);
  });
});
