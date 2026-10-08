import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
