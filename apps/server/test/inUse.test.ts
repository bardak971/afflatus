import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { BIN_MS, sweep, UNKEPT_MS } from "../src/sweep";
import { derivedKeys } from "../src/timelineModel";
import { makeApp, post, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A video nobody kept, made long enough ago for the bin; kept, or in the bin since `binnedAgo`, when asked. */
async function add(over: { kept?: boolean; binnedAgo?: number; madeAgo?: number; fine?: boolean } = {}): Promise<string> {
  const id = newId();
  const key = `assets/${id}.mp4`;
  await t.services.storage.put(key, new Uint8Array([1]));
  const fine = over.fine ? `assets/${id}.fine.safetensors` : null;
  if (fine) await t.services.storage.put(fine, new Uint8Array([2]));
  await t.db
    .insertInto("assets")
    .values({
      id, owner_id: OWNER, kind: "video", origin: "generated", name: "", file_key: key, thumb_key: null, mime: "video/mp4", bytes: 1, width: 1, height: 1, duration_ms: 30_000,
      fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: over.kept ? ago(0) : null, fine_latent_key: fine,
      deleted_at: over.binnedAgo === undefined ? null : ago(over.binnedAgo), created_at: ago(over.madeAgo ?? UNKEPT_MS + HOUR),
    })
    .execute();
  return id;
}
const asset = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();

async function timeline(): Promise<string> {
  return (await post(t.app, "/api/timelines", {})).json().id as string;
}
async function clip(timelineId: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  const at = ago(0);
  await t.db.insertInto("clips").values({ id, timeline_id: timelineId, position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: at, updated_at: at, ...over } as never).execute();
  return id;
}
async function take(clipId: string, assetId: string, over: { finished_from?: string; prev_take_id?: string } = {}): Promise<string> {
  const id = newId();
  await t.db.insertInto("takes").values({
    id, clip_id: clipId, asset_id: assetId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: over.prev_take_id ?? null, prev_at_ms: null, next_take_id: null, next_at_ms: null,
    finished_from: over.finished_from ?? null, created_at: ago(0),
  } as never).execute();
  return id;
}

describe("moving the takes that never play to the bin", () => {
  it("leaves the draft a finished take was made from and a take another carries on from; a kept take goes too (every placed take is kept)", async () => {
    const c = await clip(await timeline());
    const draftAsset = await add();
    const draft = await take(c, draftAsset);
    const finished = await take(c, await add(), { finished_from: draft });
    await t.db.updateTable("clips").set({ take_id: finished }).where("id", "=", c).execute();
    const before = await add();
    const beforeTake = await take(c, before);
    // the clip after carries on from `beforeTake`
    const next = await clip(await timeline());
    await t.db.updateTable("clips").set({ take_id: await take(next, await add(), { prev_take_id: beforeTake }) }).where("id", "=", next).execute();
    const kept = await add({ kept: true });
    await take(c, kept);
    const idle = await add();
    const idleTake = await take(c, idle);

    expect((await post(t.app, "/api/storage/bin-idle-takes")).json()).toEqual({ moved: 2 });
    expect((await asset(idle))!.deleted_at).not.toBeNull();
    expect((await asset(kept))!.deleted_at).not.toBeNull();
    for (const id of [draftAsset, before]) expect((await asset(id))!.deleted_at).toBeNull();
    const left = (await t.db.selectFrom("takes").select("id").where("clip_id", "=", c).execute()).map((r) => r.id);
    expect(left).toContain(draft);
    expect(left).not.toContain(idleTake);
  });
});

describe("the sweep", () => {
  it("neither bins nor erases what something still uses: takes, stills, sounds, music, pictures of people, inputs of a job still to run", async () => {
    const tl = await timeline();
    const playing = await add();
    const still = await add();
    const sound = await add();
    const music = await add({ kept: true, binnedAgo: BIN_MS + HOUR });
    const picture = await add();
    const input = await add();
    const free = await add();
    const freeInBin = await add({ kept: true, binnedAgo: BIN_MS + HOUR });
    const c = await clip(tl, { still_asset_id: still, sound_asset_id: sound });
    const playingTake = await take(c, playing);
    await t.db.updateTable("clips").set({ take_id: playingTake }).where("id", "=", c).execute();
    await t.db.updateTable("timelines").set({ music_asset_id: music }).where("id", "=", tl).execute();
    await t.db.insertInto("entities").values({ id: newId(), owner_id: OWNER, kind: "person", name: "Ada", def: JSON.stringify({ pictures: [picture] }), created_at: ago(0), updated_at: ago(0) }).execute();
    await t.db.insertInto("jobs").values({
      id: newId(), owner_id: OWNER, recipe_id: "sdxl.image-to-picture", label: "x", inputs: JSON.stringify({ image: input }), status: "queued", warm: 0, look: null, priority: 20, depends_on: null,
      attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null, finished_from: null,
      created_at: ago(0), started_at: null, finished_at: null, updated_at: ago(0),
    }).execute();

    expect(await sweep(t.db, t.services.storage)).toEqual({ binned: 1, erased: 1 });
    expect((await asset(free))!.deleted_at).not.toBeNull();
    expect(await asset(freeInBin)).toBeUndefined();
    for (const id of [playing, still, sound, picture, input]) expect((await asset(id))!.deleted_at).toBeNull();
    expect(await asset(music)).toBeDefined();
  });
});

describe("emptying the bin", () => {
  it("erases each file and what was derived from it, and leaves what something still uses", async () => {
    const old = await add({ binnedAgo: HOUR, fine: true });
    const row = (await asset(old))!;
    const keys = derivedKeys(row);
    for (const key of keys) await t.services.storage.put(key, new Uint8Array([1]));
    const used = await add({ binnedAgo: HOUR });
    const c = await clip(await timeline());
    await t.db.updateTable("clips").set({ take_id: await take(c, used) }).where("id", "=", c).execute();

    expect((await post(t.app, "/api/storage/empty-bin")).json()).toEqual({ erased: 1, inUse: 1 });
    expect(await asset(old)).toBeUndefined();
    for (const key of [row.file_key, row.fine_latent_key!, ...keys]) await expect(t.services.storage.get(key)).rejects.toThrow();
    expect(await asset(used)).toBeDefined();
  });
});

describe("the bin's Delete now and Put all back", () => {
  it("erases only the items named, and only from the bin; puts everything back unkept", async () => {
    const a = await add({ binnedAgo: HOUR });
    const b = await add({ binnedAgo: HOUR });
    const out = await add();
    expect((await post(t.app, "/api/storage/empty-bin", { ids: [a, out] })).json()).toEqual({ erased: 1, inUse: 0 });
    expect(await asset(a)).toBeUndefined();
    expect(await asset(out)).toBeDefined();
    expect((await asset(b))!.deleted_at).not.toBeNull();

    expect((await post(t.app, "/api/storage/restore-bin")).json()).toEqual({ restored: 1 });
    expect((await asset(b))!).toMatchObject({ deleted_at: null, kept_at: null });
  });
});

describe("the library's keep and bin", () => {
  it("refuse to unkeep or bin what something still uses, and leave it out of a choice of several", async () => {
    const used = await add({ kept: true });
    const c = await clip(await timeline());
    await t.db.updateTable("clips").set({ take_id: await take(c, used) }).where("id", "=", c).execute();
    const free = await add({ kept: true });

    const unkept = await post(t.app, `/api/assets/${used}/keep`, { kept: false });
    expect(unkept.statusCode).toBe(409);
    expect(unkept.json().error).toContain("a timeline");
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${used}` })).statusCode).toBe(409);
    expect((await post(t.app, "/api/assets/bulk", { ids: [used, free], action: "bin" })).json()).toEqual({ changed: 1, inUse: 1 });
    expect((await asset(used))!).toMatchObject({ deleted_at: null });
    expect((await asset(used))!.kept_at).not.toBeNull();
    expect((await asset(free))!.deleted_at).not.toBeNull();
    // what is not used goes as before
    expect((await post(t.app, `/api/assets/${free}/keep`, { kept: false })).statusCode).toBe(200);
  });
});
