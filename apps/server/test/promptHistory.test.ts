import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqlite, OWNER } from "../src/db";
import { get, makeApp, post, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  // on this thread, not in the worker: the tests count the statements a route prepares, with a spy on node:sqlite here
  t = await makeApp({ db: openSqlite(":memory:", { inline: true }) });
});
afterEach(async () => {
  await t.close();
});

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
const generation = (id: string, prompt: string, n: number) => ({
  id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt }), resolved: "{}", gen_ms: 1000, draft_id: null, created_at: at(n),
});
const asset = (id: string, gen: string, n: number, binned = false) => ({
  id, owner_id: OWNER, kind: "image", origin: "generated", name: id, file_key: `k-${id}`, thumb_key: null, mime: "image/png", bytes: 10, width: 8, height: 8,
  duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: gen, kept_at: at(n), deleted_at: binned ? at(n + 1) : null, created_at: at(n),
});

describe("prompt history", () => {
  it("reads only the newest renders when they hold the prompts asked for, and an older render's picture when the newer ones are gone", async () => {
    // 1 200 renders of 12 prompts, oldest first; the newest renders of "prompt 0" have their pictures in the bin, its oldest one does not
    const gens = [];
    const assets = [];
    for (let n = 0; n < 1200; n++) {
      const p = n % 12;
      gens.push(generation(`g${n}`, `prompt ${p}`, n));
      assets.push(asset(`a${n}`, `g${n}`, n, p === 0 && n > 0));
    }
    for (let i = 0; i < gens.length; i += 200) {
      await t.db.insertInto("generations").values(gens.slice(i, i + 200)).execute();
      await t.db.insertInto("assets").values(assets.slice(i, i + 200) as never).execute();
    }
    const read = async (url: string) => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const parse = vi.spyOn(JSON, "parse");
      const res = await get(t.app, url);
      const statements = prepare.mock.calls.length;
      const parsed = parse.mock.calls.length;
      prepare.mockRestore();
      parse.mockRestore();
      return { items: res.json().items as Array<{ prompt: string; assetId: string | null }>, statements, parsed };
    };
    // five prompts, all with a picture of their newest render: one page of renders, one look at the library and one at the
    // timeline clips those pictures are takes of
    const five = await read("/api/prompt-history?limit=5");
    expect(five.items.map((i) => i.prompt)).toEqual(["prompt 11", "prompt 10", "prompt 9", "prompt 8", "prompt 7"]);
    expect(five.items.map((i) => i.assetId)).toEqual(["a1199", "a1198", "a1197", "a1196", "a1195"]);
    expect(five.statements).toBeLessThanOrEqual(3);
    expect(five.parsed).toBeLessThanOrEqual(500);
    // every prompt: "prompt 0" has a picture left only from its first render, 50 renders back at most, so none is offered
    const all = await read("/api/prompt-history?limit=30");
    expect(all.items).toHaveLength(12);
    expect(all.items.find((i) => i.prompt === "prompt 0")?.assetId).toBeNull();
    expect(all.items.find((i) => i.prompt === "prompt 1")?.assetId).toBe("a1189");
  });

  it("finds the picture of a prompt's render past the first page of renders", async () => {
    // "old" was rendered 3 times, once long ago (with its picture kept) and twice lately (their pictures binned), between 600 renders of another prompt
    const gens = [generation("old-1", "old", 0)];
    const assets = [asset("keep", "old-1", 0)];
    for (let n = 1; n <= 600; n++) {
      gens.push(generation(`g${n}`, "busy", n));
      assets.push(asset(`a${n}`, `g${n}`, n));
    }
    gens.push(generation("old-2", "old", 601), generation("old-3", "old", 602));
    assets.push(asset("gone-2", "old-2", 601, true), asset("gone-3", "old-3", 602, true));
    for (let i = 0; i < gens.length; i += 200) {
      await t.db.insertInto("generations").values(gens.slice(i, i + 200)).execute();
      await t.db.insertInto("assets").values(assets.slice(i, i + 200) as never).execute();
    }
    const items = (await get(t.app, "/api/prompt-history?limit=2")).json().items as Array<{ prompt: string; assetId: string | null }>;
    expect(items).toEqual([expect.objectContaining({ prompt: "old", assetId: "keep" }), expect.objectContaining({ prompt: "busy", assetId: "a600" })]);
  });
  it("says the timeline clip a prompt's render is a take of, so that it is opened there; a draft's render is not one", async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test prompts" })).json() as { id: string };
    const now = at(10);
    await t.db.insertInto("clips").values({
      id: "c1", timeline_id: tl.id, position: 0, take_id: null, joined: "cut", recipe_id: "h3.video", inputs: "{}", kind: "video", still_asset_id: null, still_ms: 3000,
      sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: now, updated_at: now,
    } as never).execute();
    await t.db.insertInto("generations").values([generation("gc", "a clip's prompt", 11), generation("gd", "a draft's prompt", 12)]).execute();
    await t.db.insertInto("assets").values([asset("ac", "gc", 11), asset("ad", "gd", 12)] as never).execute();
    await t.db.insertInto("takes").values({
      id: "k1", clip_id: "c1", asset_id: "ac", head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null,
      finished_from: null, join_kind: null, created_at: at(11),
    } as never).execute();
    const items = (await get(t.app, "/api/prompt-history")).json().items as Array<{ prompt: string; clip: { timeline: string; clip: number } | null }>;
    expect(items.find((i) => i.prompt === "a clip's prompt")?.clip).toEqual({ timeline: tl.id, clip: 1 });
    expect(items.find((i) => i.prompt === "a draft's prompt")?.clip).toBeNull();
  });
});
