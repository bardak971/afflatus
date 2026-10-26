import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { migrate, openSqlite, OWNER } from "../src/db";

describe("migration 0032, the timeline of a job", () => {
  it("is filled in for the exports and cuts there were: from an export's inputs, from a cut's clip", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0031_take_lead");
    const at = new Date().toISOString();
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Old", width: null, height: null, created_at: at, updated_at: at } as never).execute();
    await db.insertInto("clips").values({ id: "clip", timeline_id: "tl", position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: at, updated_at: at } as never).execute();
    const job = (id: string, recipe: string, inputs: unknown) => ({
      id, owner_id: OWNER, recipe_id: recipe, label: id, inputs: JSON.stringify(inputs), status: "done", priority: 20, depends_on: null, attempts: 1, resume: null, error: null, generation_id: null,
      created_at: at, started_at: at, finished_at: at, updated_at: at,
    });
    await db.insertInto("jobs").values(job("export", "afflatus.export", { timeline: "tl", scale: 1, music: true }) as never).execute();
    await db.insertInto("jobs").values(job("cut", "afflatus.cut", { asset: "a", startMs: 0, endMs: 1000, action: "slow", clip: "clip" }) as never).execute();
    await db.insertInto("jobs").values(job("loose-cut", "afflatus.cut", { asset: "a", startMs: 0, endMs: 1000, action: "copy" }) as never).execute();
    await db.insertInto("jobs").values(job("render", "sdxl.text-to-picture", { prompt: "a cat" }) as never).execute();

    const ran = await migrate(db);
    expect(ran).toContain("0032_job_timeline");
    const timelines = Object.fromEntries((await db.selectFrom("jobs").select(["id", "timeline_id"]).execute()).map((r) => [r.id, r.timeline_id]));
    expect(timelines).toEqual({ export: "tl", cut: "tl", "loose-cut": null, render: null });
    await db.destroy();
  });
});

describe("migration 0048, the music's place", () => {
  it("plays the timelines there were from the song's start with clip 1, each clip under it as the rest", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0047_label_names");
    const at = new Date().toISOString();
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Old", width: null, height: null, created_at: at, updated_at: at } as never).execute();
    await db.insertInto("clips").values({ id: "clip", timeline_id: "tl", position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: at, updated_at: at } as never).execute();
    expect(await migrate(db)).toContain("0048_music_place");
    expect(await db.selectFrom("timelines").select(["music_from_ms", "music_start_clip_id"]).executeTakeFirst()).toEqual({ music_from_ms: 0, music_start_clip_id: null });
    expect(await db.selectFrom("clips").select("music").executeTakeFirst()).toEqual({ music: null });
    await db.destroy();
  });
});

describe("a migration that fails half way", () => {
  it("leaves nothing of the update applied, and a copy of the database from before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-migrate-"));
    const file = join(dir, "afflatus.db");
    try {
      const db = openSqlite(file);
      await migrate(db, "0031_take_lead");
      // what makes 0032's second step fail, after its first one (a column on jobs) went through
      await sql`create index jobs_by_timeline on jobs (created_at)`.execute(db);
      await expect(migrate(db)).rejects.toThrow();
      const columns = (await sql<{ name: string }>`pragma table_info(jobs)`.execute(db)).rows.map((c) => c.name);
      expect(columns).not.toContain("timeline_id");
      const done = (await sql<{ name: string }>`select name from kysely_migration`.execute(db)).rows.map((r) => r.name);
      expect(done).toContain("0031_take_lead");
      expect(done).not.toContain("0032_job_timeline");
      expect(readdirSync(dir)).toContain("afflatus.db.pre-0032_job_timeline");
      // the cause taken away, the next start goes through
      await sql`drop index jobs_by_timeline`.execute(db);
      expect(await migrate(db)).toContain("0039_wide_sizes");
      await db.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the copy taken before an update", () => {
  it("is written aside and put in place whole: the copy before the previous update goes only once the new one is there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-migrate-"));
    const file = join(dir, "afflatus.db");
    try {
      const db = openSqlite(file);
      await migrate(db, "0031_take_lead");
      // the copy from the update before; and what stops the new copy from being put in place (as a full disk stops its write)
      writeFileSync(join(dir, "afflatus.db.pre-0001_older"), "the copy before the previous update");
      mkdirSync(join(dir, "afflatus.db.pre-0032_job_timeline"));
      await expect(migrate(db)).rejects.toThrow();
      expect(readFileSync(join(dir, "afflatus.db.pre-0001_older"), "utf8")).toBe("the copy before the previous update");
      expect(readdirSync(dir).filter((f) => f.includes(".copying-"))).toEqual([]);
      // the cause taken away, the next start makes its copy, and only then lets the older one go
      rmSync(join(dir, "afflatus.db.pre-0032_job_timeline"), { recursive: true });
      expect(await migrate(db)).toContain("0032_job_timeline");
      expect(readdirSync(dir).filter((f) => f.startsWith("afflatus.db.pre-") || f.includes(".copying-"))).toEqual(["afflatus.db.pre-0032_job_timeline"]);
      await db.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration 0034, the work of the renders before it", () => {
  it("is what SQLite's two-argument max gave, written so that Postgres can run it", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0033_countdown_from");
    const at = new Date().toISOString();
    const row = (id: string, over: Record<string, unknown>) => ({
      id, owner_id: OWNER, recipe_id: "r", family: "f", model: "m", model_file: "m", time_key: "steps=20", kind: "video", width: 832, height: 480, duration_ms: 5_000, steps: 20,
      status: "done", whole: 1, cold: 0, waited_ms: 0, total_ms: 1, load_ms: 0, sample_ms: 0, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null, vram_peak: null, heat_peak: null,
      asset_id: null, created_at: at, ...over,
    });
    await db.insertInto("render_stats").values([
      row("long", {}), row("short", { duration_ms: 10 }), row("none", { duration_ms: 0 }), row("upscaled", { time_key: "upscale=x2" }), row("plain", { time_key: "upscale=Off" }),
      row("picture", { kind: "image", duration_ms: null, time_key: "steps=20" }), row("hires", { kind: "image", duration_ms: null, time_key: "hires=true" }),
    ] as never).execute();
    // the statement as it was written first, read on the same rows
    const before = (await sql<{ id: string; work: number }>`select id, width * height * max(1, cast(round(duration_ms / 1000.0 * 24) as integer)) as work from render_stats where kind = 'video' and (time_key like '%upscale=Off%' or time_key not like '%upscale=%')`.execute(db)).rows;
    await migrate(db, "0034_render_work");
    const work = Object.fromEntries((await sql<{ id: string; work: number | null }>`select id, work from render_stats`.execute(db)).rows.map((r) => [r.id, r.work]));
    for (const b of before) expect(work[b.id]).toBe(b.work);
    expect(work).toEqual({ long: 832 * 480 * 120, short: 832 * 480, none: 832 * 480, upscaled: null, plain: 832 * 480 * 120, picture: 832 * 480, hires: null });
    await db.destroy();
  });
});

describe("migration 0055, the indexes of the counts", () => {
  const indexes = async (db: ReturnType<typeof openSqlite>) =>
    (await sql<{ name: string }>`select name from sqlite_master where type = 'index' and name like ${"generations_by_%"} or name like ${"jobs_by_status%"} order by name`.execute(db)).rows.map((r) => r.name);
  const plan = async (db: ReturnType<typeof openSqlite>, query: string) =>
    (await sql.raw<{ detail: string }>(`explain query plan ${query}`).execute(db)).rows.map((r) => r.detail).join(" | ");

  it("answers each count from an index alone, in place of the two narrower ones, and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0054_pin_mirror");
    expect(await indexes(db)).toEqual(["generations_by_draft", "generations_by_family", "generations_by_time", "jobs_by_status"]);
    expect(await migrate(db)).toContain("0055_aggregate_indexes");
    expect(await indexes(db)).toEqual(["generations_by_draft_family", "generations_by_family_id", "generations_by_time", "jobs_by_status", "jobs_by_status_warm"]);
    // the command index's tries of each draft by family, and the history's counts by status: the table is not read
    expect(await plan(db, "select draft_id, family, count(*), max(created_at) from generations where draft_id is not null group by draft_id, family")).toContain("COVERING INDEX generations_by_draft_family");
    expect(await plan(db, "select status, count(*) from jobs where warm = 0 and status in ('done', 'failed', 'cancelled') group by status")).toContain("COVERING INDEX jobs_by_status_warm");
    // a draft's generations and a family's are still found by an index
    expect(await plan(db, "select id from generations where draft_id = 'd'")).toContain("generations_by_draft_family");
    expect(await plan(db, "select id from generations where family = 'sdxl'")).toContain("generations_by_family_id");
    await migrate(db, "0054_pin_mirror");
    expect(await indexes(db)).toEqual(["generations_by_draft", "generations_by_family", "generations_by_time", "jobs_by_status"]);
    await db.destroy();
  });
});

describe("migration 0070, the record of render times by machine", () => {
  const plan = async (db: ReturnType<typeof openSqlite>, query: string) =>
    (await sql.raw<{ detail: string }>(`explain query plan ${query}`).execute(db)).rows.map((r) => r.detail).join(" | ");
  const columns = async (db: ReturnType<typeof openSqlite>) => (await sql<{ name: string }>`select name from pragma_table_info('render_stats')`.execute(db)).rows.map((r) => r.name);

  it("finds one machine's renders by an index, keeps its days' digests and each render's time per node class; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0069_sessions");
    const query = "select * from render_stats where created_at >= '2026-10-01' and created_at < '2026-10-02' and machine_id = 'm3' order by created_at desc";
    expect(await plan(db, query)).not.toContain("render_stats_by_machine");
    expect(await migrate(db)).toContain("0070_render_machines");
    expect(await plan(db, query)).toContain("render_stats_by_machine");
    expect(await columns(db)).toContain("node_ms");
    await db.insertInto("render_machine_digests").values({ day: "2026-10-01", machine_id: "m3", digest: "{}" }).execute();
    await migrate(db, "0069_sessions");
    expect(await plan(db, query)).not.toContain("render_stats_by_machine");
    expect(await columns(db)).not.toContain("node_ms");
    await db.destroy();
  });
});

describe("migration 0072, the Motion transfer renders recorded with 4096 frames", () => {
  it("gives them the work of their frame times their largest chunk, and leaves every other render as it was", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0071_costs");
    const at = new Date().toISOString();
    const base = {
      owner_id: OWNER, family: "scail", model: "SCAIL", model_file: "sam3", kind: "video" as const, steps: 6, status: "done" as const, whole: 1, cold: 0, waited_ms: 0,
      total_ms: 250_000, load_ms: 20_000, sample_ms: 200_000, refine_ms: 0, finish_ms: 30_000, step_ms: 30_000, created_at: at,
    };
    await db.insertInto("render_stats").values([
      // a window carried on from the clip before (85 frames, a chunk of 81 first), and a short last one (33 frames)
      { ...base, id: "w1", recipe_id: "scail.motion", time_key: "driving+;drivingSeconds=5.3438;previous+;steps=6", width: 480, height: 864, duration_ms: 4969, work: 480 * 864 * 4096 },
      { ...base, id: "w2", recipe_id: "scail.motion", time_key: "driving+;drivingSeconds=1.75;previous+;steps=6", width: 480, height: 864, duration_ms: 1719, work: 480 * 864 * 4096 },
      // sampled at 576 × 576, filed at 384 × 384: its own work, which 4096 happens to divide
      { ...base, id: "ok", recipe_id: "scail.motion", time_key: "driving+;drivingSeconds=5.146;steps=6", width: 384, height: 384, duration_ms: 5031, work: 576 * 576 * 81 },
      { ...base, id: "h3", recipe_id: "h3.video", family: "h3", time_key: "seconds=5", width: 576, height: 1024, duration_ms: 5854, work: 576 * 1024 * 4096 },
    ]).execute();
    expect(await migrate(db)).toContain("0072_motion_work");
    const work = Object.fromEntries((await db.selectFrom("render_stats").select(["id", "work"]).execute()).map((r) => [r.id, r.work]));
    expect(work).toEqual({ w1: 480 * 864 * 81, w2: 480 * 864 * 33, ok: 576 * 576 * 81, h3: 576 * 1024 * 4096 });
    await db.destroy();
  });
});

describe("migration 0073, the work of the renders recorded before their recipes said it", () => {
  it("reads it back from what was rendered: an edit's canvas and pictures, a detailer's guide size, a picture redrawn in tiles", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0071_costs");
    const at = new Date().toISOString();
    const stat = (id: string, recipe: string, over: Record<string, unknown>) => ({
      id, owner_id: OWNER, recipe_id: recipe, family: recipe.split(".")[0], model: "M", model_file: "m", time_key: "source+", kind: "image", width: 768, height: 1376, duration_ms: null,
      steps: 40, status: "done", whole: 1, cold: 0, waited_ms: 0, total_ms: 50_000, load_ms: 1_000, sample_ms: 30_000, refine_ms: 0, finish_ms: 0, step_ms: 700, expected_ms: null,
      vram_peak: null, heat_peak: null, asset_id: null, work: 0, machine_id: "m1", gpu: null, created_at: at, ...over,
    });
    const job = (id: string, recipe: string, inputs: unknown) => ({
      id, owner_id: OWNER, recipe_id: recipe, label: id, inputs: JSON.stringify(inputs), status: "done", priority: 20, depends_on: null, attempts: 1, resume: null, error: null, generation_id: null,
      created_at: at, started_at: at, finished_at: at, updated_at: at,
    });
    await db.insertInto("jobs").values([job("edit", "qwen21.edit", { references: [{ asset: "a" }, { asset: "b" }] }), job("motion", "qwen21.motion-picture", { people: [{ asset: "a" }] })] as never).execute();
    await db.insertInto("render_stats").values([
      stat("edit", "qwen21.edit", {}),
      stat("motion", "qwen21.motion-picture", { steps: 80 }),
      stat("face", "sdxl.fix-face", { time_key: "source+;faceSize=768;faceMax=1280", width: 832, height: 1216 }),
      stat("cut", "tools.remove-background", { width: 512, height: 384, step_ms: null }),
      stat("tiled", "sdxl.sharper", { time_key: "source+;refine=true;tiles=Auto;tileSize=1024;tileOverlap=128;steps=28", width: 3200, height: 3200, steps: 14, work: 3200 * 3200 }),
      stat("whole", "sdxl.sharper", { time_key: "source+;refine=true;tiles=Auto;tileSize=1024;tileOverlap=128;steps=20", width: 1664, height: 2432, steps: 10, work: 1664 * 2432 }),
      stat("hires", "sdxl.text-to-picture", { time_key: "size=640x640;steps=20;hires=true;hiresScale=2.5;hiresSteps=10;tiles=Tiles;tileSize=1024;tileOverlap=128", width: 1600, height: 1600, steps: 30, work: 1600 * 1600 }),
      stat("draft", "h3.video", { kind: "video", work: 0 }),
    ] as never).execute();
    expect(await migrate(db)).toContain("0073_render_work");
    const got = Object.fromEntries((await db.selectFrom("render_stats").select(["id", "work", "steps"]).execute()).map((r) => [r.id, [r.work, r.steps]]));
    expect(got).toEqual({
      edit: [Math.round(768 * 1376 * 2.2), 40], motion: [Math.round(768 * 1376 * 1.8), 80], face: [768 * 768, 40], cut: [512 * 384, 40],
      // sixteen tiles of 1024², each of 14 steps; a picture gone over whole is left as it was
      tiled: [1024 * 1024, 14 * 16], whole: [1664 * 2432, 10],
      // the first pass at 640², then four tiles of ten steps
      hires: [640 * 640, 20 + 10 * 4],
      draft: [0, 40],
    });
    await db.destroy();
  });
});

describe("migration 0077, a pod's work from outside Afflatus", () => {
  const tables = async (db: ReturnType<typeof openSqlite>) => (await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(db)).rows.map((r) => r.name);

  it("keeps its stretches by session, an open one without its end; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0076_rent_boot");
    expect(await tables(db)).not.toContain("pod_outside");
    expect(await migrate(db)).toContain("0077_pod_outside");
    const at = new Date().toISOString();
    await db.insertInto("pod_outside").values([
      { id: "o1", session_id: "s1", machine_id: "rp", started_at: at, seen_at: at, ended_at: at },
      { id: "o2", session_id: "s1", machine_id: "rp", started_at: at, seen_at: at, ended_at: null },
    ]).execute();
    expect(await db.selectFrom("pod_outside").select("id").where("session_id", "=", "s1").where("ended_at", "is", null).execute()).toEqual([{ id: "o2" }]);
    await migrate(db, "0076_rent_boot");
    expect(await tables(db)).not.toContain("pod_outside");
    await db.destroy();
  });
});

describe("migration 0080, what a pod's run ran on", () => {
  it("leaves the runs there were unknown (null), keeps a new run's build, host, data center, pull and boot log; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0079_pod_crash");
    const at = new Date().toISOString();
    await db.insertInto("rent_sessions").values({ id: "old", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: at, ended_at: at, seen_at: at, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null } as never).execute();
    expect(await migrate(db)).toContain("0080_rent_build");
    expect(await db.selectFrom("rent_sessions").select(["image", "host_cuda", "data_center", "pull", "boot_log"]).executeTakeFirstOrThrow()).toEqual({ image: null, host_cuda: null, data_center: null, pull: null, boot_log: null });
    await db.updateTable("rent_sessions").set({ image: "ghcr.io/owner/afflatus-pod:0.1.27-cu128", host_cuda: "12.8", data_center: "EU-RO-1", pull: "{}", boot_log: "{}" }).execute();
    expect((await db.selectFrom("rent_sessions").select("image").executeTakeFirstOrThrow()).image).toMatch(/-cu128$/);
    await migrate(db, "0079_pod_crash");
    const columns = (await sql<{ name: string }>`pragma table_info(rent_sessions)`.execute(db)).rows.map((c) => c.name);
    expect(columns).not.toContain("image");
    expect(columns).not.toContain("boot_log");
    await db.destroy();
  });
});

describe("migration 0083, H3 · Swap motion retired", () => {
  // Its down is a no-op on purpose (a window made Swap character or Motion transfer cannot be told from one made so by
  // hand), so taken back and run again it must leave the rows as the first run left them (review O-17).
  it("is taken back without undoing the forms it gave, and run again changes nothing", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0082_timeline_recordings");
    const at = new Date().toISOString();
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "zz-test Swap motion", created_at: at, updated_at: at } as never).execute();
    const clip = (id: string, position: number, joined: string, inputs: unknown) => ({ id, timeline_id: "tl", position, take_id: null, joined, recipe_id: "h3.swapMotion", inputs: JSON.stringify(inputs), created_at: at, updated_at: at });
    await db.insertInto("clips").values([clip("open", 0, "cut", { who: "", sourceStart: 0 }), clip("carry", 1, "continue", { who: "", sourceStart: 5 })] as never).execute();
    const rows = async () => (await db.selectFrom("clips").select(["id", "recipe_id", "inputs"]).orderBy("position").execute()).map((c) => [c.id, c.recipe_id, JSON.parse(c.inputs)]);
    expect(await migrate(db, "0083_swap_motion_retired")).toEqual(["0083_swap_motion_retired"]);
    const after = await rows();
    expect(after.map((r) => r[1])).toEqual(["h3.swap", "h3.motion"]);
    await migrate(db, "0082_timeline_recordings");
    expect(await rows()).toEqual(after);
    expect(await migrate(db, "0083_swap_motion_retired")).toEqual(["0083_swap_motion_retired"]);
    expect(await rows()).toEqual(after);
    await db.destroy();
  });
});

describe("migration 0084, an ended session's split kept", () => {
  it("leaves the sessions there were without one (null), keeps one written after; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0083_swap_motion_retired");
    const at = new Date().toISOString();
    await db.insertInto("rent_sessions").values({ id: "old", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: at, ended_at: at, seen_at: at, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3 } as never).execute();
    expect(await migrate(db, "0084_session_split")).toEqual(["0084_session_split"]);
    expect((await db.selectFrom("rent_sessions").select("split").executeTakeFirstOrThrow()).split).toBeNull();
    await db.updateTable("rent_sessions").set({ split: JSON.stringify({ spans: [], estimated: [] }) }).execute();
    expect(JSON.parse((await db.selectFrom("rent_sessions").select("split").executeTakeFirstOrThrow()).split!)).toEqual({ spans: [], estimated: [] });
    await migrate(db, "0083_swap_motion_retired");
    const columns = (await sql<{ name: string }>`pragma table_info(rent_sessions)`.execute(db)).rows.map((c) => c.name);
    expect(columns).not.toContain("split");
    // the session itself is kept, and the column comes back empty
    expect(await migrate(db, "0084_session_split")).toEqual(["0084_session_split"]);
    expect(await db.selectFrom("rent_sessions").select(["id", "split"]).execute()).toEqual([{ id: "old", split: null }]);
    await db.destroy();
  });
});

describe("migration 0085, a running session's split kept up to a moment", () => {
  it("leaves the sessions there were without one (null), keeps one written after; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0084_session_split");
    const at = new Date().toISOString();
    await db.insertInto("rent_sessions").values({ id: "old", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: at, ended_at: null, seen_at: at, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3 } as never).execute();
    expect(await migrate(db, "0085_session_split_until")).toEqual(["0085_session_split_until"]);
    expect(await db.selectFrom("rent_sessions").select(["split", "split_until"]).executeTakeFirstOrThrow()).toEqual({ split: null, split_until: null });
    await db.updateTable("rent_sessions").set({ split: JSON.stringify({ spans: [], estimated: [] }), split_until: at }).execute();
    expect((await db.selectFrom("rent_sessions").select("split_until").executeTakeFirstOrThrow()).split_until).toBe(at);
    await migrate(db, "0084_session_split");
    const columns = (await sql<{ name: string }>`pragma table_info(rent_sessions)`.execute(db)).rows.map((c) => c.name);
    expect(columns).not.toContain("split_until");
    // 0084's split is left as it was, and the column comes back empty
    expect(columns).toContain("split");
    expect(await migrate(db, "0085_session_split_until")).toEqual(["0085_session_split_until"]);
    expect(await db.selectFrom("rent_sessions").select(["id", "split_until"]).execute()).toEqual([{ id: "old", split_until: null }]);
    await db.destroy();
  });
});

describe("migration 0087, the record of render times by family", () => {
  const plan = async (db: ReturnType<typeof openSqlite>, query: string) =>
    (await sql.raw<{ detail: string }>(`explain query plan ${query}`).execute(db)).rows.map((r) => r.detail).join(" | ");

  it("finds a family's renders newest first by an index, not through every model's; and is taken back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0086_jobs_to_run");
    // forecast.ts familyRows and familyWarmLoads, as a waiting job's forecast asks them
    const rows = "select * from render_stats where family = 'sdxl' and model_file != 'a.safetensors' and model_file != '' and status = 'done' and whole = 1 order by created_at desc limit 200";
    const loads = "select load_ms from render_stats where status = 'done' and whole = 1 and cold = 0 and family = 'sdxl' and model_file != '' order by created_at desc limit 50";
    expect(await plan(db, rows)).not.toContain("render_stats_by_family");
    expect(await migrate(db)).toContain("0087_render_stats_family");
    for (const q of [rows, loads]) {
      expect(await plan(db, q)).toContain("render_stats_by_family (family=? AND status=?)");
      expect(await plan(db, q)).not.toContain("TEMP B-TREE");
    }
    await migrate(db, "0086_jobs_to_run");
    expect(await plan(db, rows)).not.toContain("render_stats_by_family");
    await db.destroy();
  });
});

describe("migration 0093, Wan's Hybrid turbo off where a model's saved settings held the old default", () => {
  it("drops a saved Hybrid turbo on from Wan's models only, keeps every other value, and is taken back without putting it back", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0092_latent_clock");
    const at = new Date().toISOString();
    const row = (family: string, file: string, values: unknown) => ({ owner_id: OWNER, family, file, values: JSON.stringify(values), updated_at: at });
    await db.insertInto("model_settings").values([
      row("wan", "wan-high.safetensors", { turboHybrid: true, turboSteps: 6, turboStrength: 0.7, shift: 8 }),
      row("wan", "only-hybrid.safetensors", { turboHybrid: true }),
      row("wan", "kept-off.safetensors", { turboHybrid: false, turboSteps: 4 }),
      row("h3", "h3.safetensors", { turboHybrid: true, steps: 8 }),
      row("sdxl", "sdxl.safetensors", { sampler: "euler", cfg: 5 }),
    ] as never).execute();
    const saved = async () => Object.fromEntries((await db.selectFrom("model_settings").select(["family", "file", "values"]).execute()).map((r) => [`${r.family}/${r.file}`, JSON.parse(r.values)]));
    expect(await migrate(db, "0093_wan_hybrid_saved")).toEqual(["0093_wan_hybrid_saved"]);
    const after = await saved();
    expect(after).toEqual({
      "wan/wan-high.safetensors": { turboSteps: 6, turboStrength: 0.7, shift: 8 },
      // nothing left saved: no row, as Forget saved defaults leaves it
      "wan/kept-off.safetensors": { turboHybrid: false, turboSteps: 4 },
      "h3/h3.safetensors": { turboHybrid: true, steps: 8 },
      "sdxl/sdxl.safetensors": { sampler: "euler", cfg: 5 },
    });
    await migrate(db, "0092_latent_clock");
    expect(await saved()).toEqual(after);
    expect(await migrate(db)).toContain("0093_wan_hybrid_saved");
    expect(await saved()).toEqual(after);
    await db.destroy();
  });
});
