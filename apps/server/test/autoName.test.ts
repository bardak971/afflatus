import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { capName, draftLabel, finishedName, numbered, takeName } from "../src/autoName";
import { migrate, newId, openSqlite, OWNER, type Db } from "../src/db";
import { newAssetRow } from "../src/media";
import { CHECKPOINT, complete, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

const video = (name = "", over: Record<string, unknown> = {}) => newAssetRow({
  id: newId(), kind: "video", origin: "generated", name, file_key: "assets/x.mp4", thumb_key: null, mime: "video/mp4", bytes: 1, width: 640, height: 360,
  duration_ms: 3_000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, source_id: null, source_range: null, raw_key: null, latent_key: null,
  latent_frames: null, linked_path: null, countdown_from: null, ...over,
});

describe("the names given", () => {
  it("say the timeline, clip and take; a draft's label and its number; never longer than 80 characters", () => {
    expect(takeName("Harbor walk", 2, 3)).toBe("Harbor walk · c2 · t3");
    expect(takeName("", 1, 1)).toBe("Timeline · c1 · t1");
    expect(finishedName("Harbor walk · c2 · t3")).toBe("Harbor walk · c2 · t3 · finished");
    expect(finishedName("Harbor walk · c2 · t3 · finished")).toBe("Harbor walk · c2 · t3 · finished");
    expect(numbered("Harbor walk", 1)).toBe("Harbor walk 01");
    expect(numbered("Harbor walk", 100)).toBe("Harbor walk 100");
    const long = takeName("a very long timeline name ".repeat(6), 12, 4);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("… · c12 · t4")).toBe(true);
    expect(numbered("word ".repeat(40), 7).length).toBeLessThanOrEqual(80);
    expect(capName("x".repeat(200)).length).toBe(80);
    // a draft: its name, else the first words of its title or prompt, else its recipe
    expect(draftLabel({ name: " Harbor walk ", title: "a boat", recipe: "Words to picture" })).toBe("Harbor walk");
    expect(draftLabel({ name: null, title: "A quiet harbour at dawn, fog over the water", recipe: "Words to picture" })).toBe("A quiet harbour at dawn");
    expect(draftLabel({ name: null, title: "", prompt: "two gulls on a post", recipe: "Words to picture" })).toBe("two gulls on a post");
    expect(draftLabel({ name: null, title: "", prompt: "", recipe: "Words to picture" })).toBe("Words to picture");
  });
});

describe("a take placed on a clip", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("is named after its timeline, its clip's place and its own place; its finish after it; a name given by hand stays", async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "Harbor walk" })).json();
    await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" });
    const second = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip as string;
    const place = async (name = "", finishedFrom: string | null = null) => {
      const row = video(name);
      await t.db.insertInto("assets").values(row).execute();
      const asset = await t.db.selectFrom("assets").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
      const take = await t.services.timelines.takes.add(second, asset, { headMs: 0, tailMs: 0 }, {}, finishedFrom);
      return { take, name: (await t.db.selectFrom("assets").select("name").where("id", "=", row.id).executeTakeFirstOrThrow()).name };
    };
    const one = await place();
    expect(one.name).toBe("Harbor walk · c2 · t1");
    expect((await place()).name).toBe("Harbor walk · c2 · t2");
    expect((await place("", one.take)).name).toBe("Harbor walk · c2 · t1 · finished");
    expect((await place("my favourite.mp4")).name).toBe("my favourite.mp4");
  });
});

describe("what a draft made", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  it("is named after the draft and numbered on; a render sent from no draft keeps no name", async () => {
    const recipe = "sdxl.text-to-picture";
    const named = (await post(t.app, "/api/drafts", { recipe, forms: { [recipe]: { prompt: "a harbour at dusk" } } })).json();
    await t.app.inject({ method: "PUT", url: `/api/drafts/${named.id}`, payload: { name: "Harbor walk" } });
    const untitled = (await post(t.app, "/api/drafts", { recipe, forms: { [recipe]: { prompt: "two gulls on a mooring post at noon" } } })).json();
    const make = async (extra: Record<string, unknown>) => {
      const before = fake.prompts.size;
      const filed = (await t.db.selectFrom("assets").select("id").execute()).length;
      await post(t.app, "/api/jobs", { recipe, input: { prompt: "two gulls on a mooring post at noon", checkpoint: CHECKPOINT }, ...extra });
      await until(() => fake.prompts.size === before + 1);
      complete(fake, [...fake.prompts.keys()].at(-1)!);
      await until(async () => (await t.db.selectFrom("assets").select("id").execute()).length === filed + 1);
    };
    await make({ draft: named.id });
    await make({ draft: named.id });
    await make({ draft: untitled.id });
    await make({});
    const names = (await t.db.selectFrom("assets").select("name").orderBy("created_at").execute()).map((a) => a.name);
    expect(names).toEqual(["Harbor walk 01", "Harbor walk 02", "two gulls on a mooring 01", ""]);
  });
});

describe("migration 0046, names for what was made before", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString();

  it("names the takes, what drafts made and their frames, and leaves the names already given", async () => {
    const db: Db = openSqlite(":memory:");
    await migrate(db, "0045_music_duck_db");
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Harbor walk", created_at: at(0), updated_at: at(0) } as never).execute();
    for (const [id, position] of [["c-a", 0], ["c-b", 1]] as const) {
      await db.insertInto("clips").values({ id, timeline_id: "tl", position, take_id: null, joined: "cut", recipe_id: "h3.video", inputs: "{}", created_at: at(1), updated_at: at(1) } as never).execute();
    }
    const asset = async (id: string, name: string, i: number, over: Record<string, unknown> = {}) => db.insertInto("assets").values({ ...video(name, over), id, created_at: at(i) }).execute();
    const take = async (id: string, clip: string, assetId: string, i: number, finishedFrom: string | null = null) => db.insertInto("takes").values({
      id, clip_id: clip, asset_id: assetId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null,
      finished_from: finishedFrom, join_kind: null, created_at: at(i),
    } as never).execute();
    await asset("v1", "", 2);
    await asset("v2", "", 3);
    await asset("v3", "kept by hand", 4);
    await asset("v4", "", 5);
    await take("t1", "c-b", "v1", 2);
    await take("t2", "c-b", "v2", 3);
    await take("t3", "c-a", "v3", 4);
    await take("t4", "c-b", "v4", 5, "t1");
    // a frame of a take
    await asset("f1", "", 6, { kind: "image", origin: "frame", source_id: "v2", mime: "image/png" });
    // a draft's three results, one of them named already, and one of a draft deleted since
    await db.insertInto("drafts").values({ id: "d", owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.text-to-picture", title: "a harbour at dusk under rain", name: null, forms: "{}", count: 1, chat: null, look: null, created_at: at(0), updated_at: at(0) } as never).execute();
    const generation = async (id: string, draft: string | null) => db.insertInto("generations").values({ id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt: "a harbour" }), resolved: "{}", gen_ms: 1, draft_id: draft, created_at: at(0) } as never).execute();
    for (const [g, d] of [["g1", "d"], ["g2", "d"], ["g3", "d"], ["g4", "gone"], ["g5", null]] as const) await generation(g, d);
    await asset("p1", "", 7, { kind: "image", generation_id: "g1" });
    await asset("p2", "mine", 8, { kind: "image", generation_id: "g2" });
    await asset("p3", "", 9, { kind: "image", generation_id: "g3" });
    await asset("p4", "", 10, { kind: "image", generation_id: "g4" });
    await asset("p5", "", 11, { kind: "image", generation_id: "g5" });

    expect(await migrate(db)).toContain("0046_auto_names");
    const names = Object.fromEntries((await db.selectFrom("assets").select(["id", "name"]).execute()).map((a) => [a.id, a.name]));
    expect(names).toEqual({
      v1: "Harbor walk · c2 · t1", v2: "Harbor walk · c2 · t2", v3: "kept by hand", v4: "Harbor walk · c2 · t1 · finished",
      f1: "Harbor walk · c2 · t2, a frame",
      p1: "a harbour at dusk under 01", p2: "mine", p3: "a harbour at dusk under 03", p4: "", p5: "",
    });
    await db.destroy();
  });
});
