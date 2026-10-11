import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { capName, draftLabel, finishedName, frameName, fromName, givenLabel, nameOf, numbered, passName, saysNothing, shownNames, soundName, takeName, type NamedRow } from "../src/autoName";
import { migrate, newId, openSqlite, OWNER, type Db } from "../src/db";
import m0047 from "../src/migrations/0047-label-names";
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

  it("say what was made from a named item after it: finished and how much bigger, a frame and when, a range, its sound", () => {
    expect(finishedName("Big Air · c2 · t5", 2)).toBe("Big Air · c2 · t5 · finished ×2");
    expect(finishedName("Big Air · c2 · t5", 1)).toBe("Big Air · c2 · t5 · finished");
    expect(finishedName("Big Air · c2 · t5", 1.9999)).toBe("Big Air · c2 · t5 · finished ×2");
    // a finish of a finish, named by older code with its route: said finished once
    expect(finishedName("Big Air · c2 · t5 · finished ×2 (SeedVR2)", 2)).toBe("Big Air · c2 · t5 · finished ×2");
    expect(finishedName("", 2)).toBe("video · finished ×2");
    expect(frameName("Big Air · c2 · t5", 3_240)).toBe("Big Air · c2 · t5 · frame 0:03.2");
    expect(frameName("Big Air · c2 · t5")).toBe("Big Air · c2 · t5 · frame");
    expect(fromName("walk.mp4", " · 0:01–0:02")).toBe("walk · 0:01–0:02");
    expect(fromName("v0.2 test", " · 0:01–0:02")).toBe("v0.2 test · 0:01–0:02");
    expect(soundName("walk.mp4")).toBe("walk · audio");
    expect(fromName("word ".repeat(40), " · frame 0:03.2").length).toBeLessThanOrEqual(80);
    // what older code wrote after a nameless video says nothing; a name of one's own does
    expect(saysNothing("")).toBe(true);
    expect(saysNothing("video · finished ×2 (upscale model)")).toBe(true);
    expect(saysNothing("Audio extracted from a video")).toBe(true);
    expect(saysNothing("my video · take two")).toBe(false);
  });
});

describe("the name an item is shown under when its own says nothing", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString();

  it("is worked out from where it came from, as it would be named today; nothing is written", async () => {
    const db: Db = openSqlite(":memory:");
    await migrate(db);
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Big Air", created_at: at(0), updated_at: at(0) } as never).execute();
    for (const [id, position] of [["c-a", 0], ["c-b", 1]] as const) {
      await db.insertInto("clips").values({ id, timeline_id: "tl", position, take_id: null, joined: "cut", recipe_id: "h3.video", inputs: "{}", created_at: at(1), updated_at: at(1) } as never).execute();
    }
    const asset = async (id: string, name: string, i: number, over: Record<string, unknown> = {}) => db.insertInto("assets").values({ ...video(name, over), id, created_at: at(i) }).execute();
    const take = async (id: string, clip: string, assetId: string, i: number, finishedFrom: string | null = null) => db.insertInto("takes").values({
      id, clip_id: clip, asset_id: assetId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null,
      finished_from: finishedFrom, join_kind: null, created_at: at(i),
    } as never).execute();
    // two takes of the second clip, both nameless; the first finished, and named by older code after "video"
    await asset("v1", "", 2);
    await asset("v2", "", 3);
    await take("t1", "c-b", "v1", 2);
    await take("t2", "c-b", "v2", 3);
    await asset("v3", "video · finished ×2 (upscale model)", 4, { source_id: "v1", source_range: "0-3000" });
    await take("t3", "c-b", "v3", 4, "t1");
    // a finish that was never placed: its "×2" is read from the old name
    await asset("v4", "video · finished ×2 (SeedVR2)", 5, { source_id: "v2", source_range: "0-3000" });
    // what was taken out of the first take: a range, a frame, its sound, and a picture mirrored from that frame
    await asset("cut", "video · 0:01–0:02", 6, { origin: "cut", source_id: "v1", source_range: "1000-2000" });
    await asset("cut2", "", 7, { origin: "cut", source_id: "v2", source_range: "500-1500" });
    await asset("frame", "", 8, { kind: "image", origin: "frame", source_id: "v1" });
    await asset("sound", "Audio extracted from a video", 9, { kind: "audio", origin: "imported", source_id: "v1" });
    await asset("mirror", "", 10, { kind: "image", origin: "edited", source_id: "frame" });
    // what a draft with no name nor title made, and a render sent from no draft
    await db.insertInto("drafts").values({ id: "d", owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.text-to-picture", title: "", name: null, forms: "{}", count: 1, chat: null, look: null, created_at: at(0), updated_at: at(0) } as never).execute();
    for (const [g, d] of [["g1", "d"], ["g2", null]] as const) {
      await db.insertInto("generations").values({ id: g, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt: "two gulls on a mooring post at noon" }), resolved: "{}", gen_ms: 1, draft_id: d, created_at: at(0) } as never).execute();
    }
    await asset("p1", "", 11, { kind: "image", generation_id: "g1" });
    await asset("p2", "", 12, { kind: "image", generation_id: "g2" });
    // a name of one's own, and an upload with nothing to go on
    await asset("own", "my favourite", 13, { source_id: "v1", source_range: "0-1000" });
    await asset("up", "", 14, { kind: "image", origin: "uploaded" });

    const rows = (await db.selectFrom("assets").select(["id", "name", "kind", "origin", "generation_id", "source_id", "source_range"]).execute()) as NamedRow[];
    const shown = Object.fromEntries(await shownNames(db, rows));
    expect(shown).toEqual({
      v1: "Big Air · c2 · t1", v2: "Big Air · c2 · t2",
      v3: "Big Air · c2 · t1 · finished ×2", v4: "Big Air · c2 · t2 · finished ×2",
      cut: "Big Air · c2 · t1 · 0:01–0:02", cut2: "Big Air · c2 · t2 · 0:00.5–0:01.5",
      frame: "Big Air · c2 · t1 · frame", sound: "Big Air · c2 · t1 · audio", mirror: "Big Air · c2 · t1 · frame, mirrored",
      p1: "two gulls on a mooring", p2: "two gulls on a mooring",
    });
    // what is made next from one goes by the same name; one's own name as it is
    expect(await nameOf(db, rows.find((r) => r.id === "v1")!)).toBe("Big Air · c2 · t1");
    expect(await nameOf(db, rows.find((r) => r.id === "own")!)).toBe("my favourite");
    expect(await nameOf(db, rows.find((r) => r.id === "up")!)).toBe("");
    // nothing was written
    expect((await db.selectFrom("assets").select("name").where("id", "in", ["v1", "v3", "frame"]).execute()).map((a) => a.name).sort()).toEqual(["", "", "video · finished ×2 (upscale model)"]);
    await db.destroy();
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

  it("is named after the draft and numbered on; a render sent from no draft after its prompt, numbered past the same words", async () => {
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
    expect(names).toEqual(["Harbor walk 01", "Harbor walk 02", "two gulls on a mooring 01", "two gulls on a mooring 02"]);
  });

  it("sent from no draft with a label: named after it and numbered on past the highest; with the recipe's own title, after the prompt", async () => {
    const recipe = "sdxl.text-to-picture";
    const make = async (label?: string) => {
      const before = fake.prompts.size;
      const filed = (await t.db.selectFrom("assets").select("id").execute()).length;
      await post(t.app, "/api/jobs", { recipe, input: { prompt: "a pier in the fog", checkpoint: CHECKPOINT }, ...(label === undefined ? {} : { label }) });
      await until(() => fake.prompts.size === before + 1);
      complete(fake, [...fake.prompts.keys()].at(-1)!);
      await until(async () => (await t.db.selectFrom("assets").select("id").execute()).length === filed + 1);
      return (await t.db.selectFrom("assets").select(["id", "name"]).orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirstOrThrow());
    };
    const label = "Harbor walk · A01 wide";
    expect((await make(label)).name).toBe("Harbor walk · A01 wide 01");
    const second = await make(` ${label} `);
    expect(second.name).toBe("Harbor walk · A01 wide 02");
    expect((await make(label)).name).toBe("Harbor walk · A01 wide 03");
    // the second thrown away and the first renamed by hand: the next is still the fourth
    await t.db.deleteFrom("assets").where("id", "=", second.id).execute();
    await t.db.updateTable("assets").set({ name: "the good one" }).where("name", "=", "Harbor walk · A01 wide 01").execute();
    expect((await make(label)).name).toBe("Harbor walk · A01 wide 04");
    // another label counts on its own, even one that starts the same
    expect((await make("Harbor walk · A01 wide, closer")).name).toBe("Harbor walk · A01 wide, closer 01");
    // the queue's own label (the recipe's title), or none, says nothing: the first words of the prompt name it instead
    expect((await make("txt2img")).name).toBe("a pier in the fog 01");
    expect((await make()).name).toBe("a pier in the fog 02");
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

describe("migration 0047, names for what was sent with a label before", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString();

  it("tells a given label from the recipe's title", () => {
    expect(givenLabel("Harbor walk · A01 wide", "sdxl.text-to-picture", "txt2img")).toBe("Harbor walk · A01 wide");
    expect(givenLabel(" txt2img ", "sdxl.text-to-picture", "txt2img")).toBe("");
    expect(givenLabel("Text to picture", "krea2.text-to-picture")).toBe("");
    expect(givenLabel("Harbor-walk Picture", "workflow.harbor-walk-picture")).toBe("");
    expect(givenLabel("", "sdxl.text-to-picture", "txt2img")).toBe("");
  });

  it("numbers the nameless results of labelled jobs in the order made, past the numbers already given; leaves the rest", async () => {
    const db: Db = openSqlite(":memory:");
    await migrate(db, "0046_auto_names");
    await db.insertInto("drafts").values({ id: "d", owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.text-to-picture", title: "a pier", name: null, forms: "{}", count: 1, chat: null, look: null, created_at: at(0), updated_at: at(0) } as never).execute();
    const made = async (n: number, opts: { label: string; name?: string; draft?: string | null; clip?: string | null; noJob?: boolean; inputs?: string }) => {
      const g = `g${n}`;
      await db.insertInto("generations").values({ id: g, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: opts.inputs ?? "{}", resolved: "{}", gen_ms: 1, draft_id: opts.draft ?? null, created_at: at(n) } as never).execute();
      if (!opts.noJob) {
        await db.insertInto("jobs").values({
          id: `j${n}`, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: opts.label, inputs: "{}", status: "done", warm: 0, look: null, priority: 10, depends_on: null,
          attempts: 1, resume: null, error: null, generation_id: g, clip_id: opts.clip ?? null, draft_id: opts.draft ?? null, folder_id: null, created_at: at(n), updated_at: at(n),
        } as never).execute();
      }
      await db.insertInto("assets").values({ ...video(opts.name ?? "", { kind: "image", generation_id: g }), id: `a${n}`, created_at: at(n) }).execute();
    };
    const label = "Harbor walk · A01 wide";
    await made(1, { label, name: `${label} 05` });
    await made(2, { label });
    await made(3, { label, name: "kept by hand" });
    await made(4, { label });
    await made(5, { label: "Harbor walk · B02 close" });
    await made(6, { label: "txt2img" });
    await made(7, { label: "Harbor walk · C03", draft: "d" });
    await made(8, { label: "Harbor walk · c1 · take 1 of 2", clip: "c" });
    await made(9, { label, noJob: true });
    // the queue's own label: named after the first words of the prompt, numbered past what those words already have
    await made(10, { label: "txt2img", name: "a quiet harbour at dawn 02", draft: "d" });
    await made(11, { label: "txt2img", inputs: JSON.stringify({ prompt: "  a quiet harbour at dawn, gulls over the water" }) });
    await made(12, { label: "txt2img", inputs: "not json" });
    // a given label still wins over the prompt
    await made(13, { label, inputs: JSON.stringify({ prompt: "a quiet harbour at dawn" }) });

    expect(await migrate(db)).toContain("0047_label_names");
    const names = Object.fromEntries((await db.selectFrom("assets").select(["id", "name"]).execute()).map((a) => [a.id, a.name]));
    expect(names).toEqual({
      a1: `${label} 05`, a2: `${label} 06`, a3: "kept by hand", a4: `${label} 07`, a5: "Harbor walk · B02 close 01",
      a6: "", a7: "", a8: "", a9: "", a10: "a quiet harbour at dawn 02", a11: "a quiet harbour at dawn 03", a12: "", a13: `${label} 08`,
    });
    // run again, nothing is left to name and nothing named changes
    await m0047.up(db);
    expect(Object.fromEntries((await db.selectFrom("assets").select(["id", "name"]).execute()).map((a) => [a.id, a.name]))).toEqual(names);
    await db.destroy();
  });
});

describe("what a pass made of a named picture", () => {
  it("is the picture's name and the pass, numbered when several", () => {
    expect(passName("Terrace 10", "Upscale 2x")).toBe("Terrace 10 · Upscale 2x");
    expect(passName("Terrace 10.png", "Face detailer", 2)).toBe("Terrace 10 · Face detailer 02");
    expect(passName("x".repeat(100), "Upscale 2x").length).toBeLessThanOrEqual(80);
  });
});
