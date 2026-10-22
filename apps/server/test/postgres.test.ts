import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { costs } from "../src/costs";
import { migrate, newId, openDb, OWNER, type Db } from "../src/db";
import { migrations } from "../src/migrations";
import type { QueueCore } from "../src/queueModel";
import { history } from "../src/queueView";
import { Registry } from "../src/registry";
import type { RenderRow } from "../src/renderDigests";
import { clear, fold } from "../src/renders";
import { summary } from "../src/rendersRead";
import { createServices } from "../src/services";
import { readSettings, writeSettings } from "../src/settings";
import { LocalStorage } from "../src/storage";
import { pruneJobs } from "../src/tidy";
import { FAST, NOWHERE } from "./helpers";

/**
 * The migrations on a real Postgres: run only when DATABASE_URL names one (CI's postgres job does; see
 * .github/workflows/ci.yml). Each run works in a schema of its own, dropped after.
 */
const url = process.env.DATABASE_URL?.trim();

/** The database in a schema of its own for the length of `run`, dropped after. */
async function inSchema(run: (db: Db) => Promise<void>): Promise<void> {
  const schema = `t_${newId().slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  try {
    const at = new URL(url!);
    at.searchParams.set("options", `-c search_path=${schema}`);
    const { db, kind } = openDb({ ...loadConfig({}), databaseUrl: at.toString() });
    expect(kind).toBe("postgres");
    await run(db);
  } finally {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

describe.skipIf(!url)("on Postgres", () => {
  it("every migration runs, and a size or a work past 2^31 is kept and read back as a number", async () => {
    await inSchema(async (db) => {
      const ran = await migrate(db);
      // every migration there is, up to the last one: a literal here went stale at the next migration
      expect(ran.at(-1)).toBe(Object.keys(migrations).at(-1));
      expect(ran).toHaveLength(Object.keys(migrations).length);
      const now = new Date().toISOString();
      await db.insertInto("assets").values({
        id: "big", owner_id: OWNER, kind: "video", origin: "exported", name: "", file_key: "k", thumb_key: null, mime: "video/mp4", bytes: 3_000_000_000, width: null, height: null,
        duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now, deleted_at: null, created_at: now,
      } as never).execute();
      expect((await db.selectFrom("assets").select("bytes").where("id", "=", "big").executeTakeFirstOrThrow()).bytes).toBe(3_000_000_000);
      // the history is searched alike on both databases, whatever the case
      await db.insertInto("jobs").values({
        id: "j", owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "A Red Fox", inputs: "{}", status: "done", warm: 0, look: null, priority: 20, depends_on: null, attempts: 1,
        resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null, finished_from: null, created_at: now, started_at: now, finished_at: now, updated_at: now,
      }).execute();
      const registry = new Registry(db);
      await registry.load();
      const core = { db, registry } as unknown as QueueCore;
      expect((await history(core, { q: "red fox" })).items.map((i) => i.id)).toEqual(["j"]);
      expect((await history(core, { q: "RED" })).items).toHaveLength(1);
      // old finished jobs nothing names go, through the same statements as on SQLite: a job another waits on stays
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const row = (id: string, depends: string | null, status: "done" | "queued") => ({
        id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status, warm: 0, look: null, priority: 20, depends_on: depends, attempts: 1,
        resume: null, error: null, generation_id: null, clip_id: "gone", clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null, finished_from: null, created_at: old, started_at: old,
        finished_at: status === "done" ? old : null, updated_at: old,
      });
      await db.insertInto("jobs").values([row("old", null, "done"), row("waited", null, "done"), row("next", "waited", "queued")]).execute();
      expect(await pruneJobs(db, 30, 90)).toBe(1);
      expect((await db.selectFrom("jobs").select("id").orderBy("id").execute()).map((r) => r.id)).toEqual(["j", "next", "waited"]);
      await db.destroy();
    });
  });

  it("the library is searched by its words, and the days over are digested and folded, as on SQLite", async () => {
    await inSchema(async (db) => {
      await migrate(db);
      await writeSettings(db, { comfyUrl: NOWHERE });
      const dir = mkdtempSync(join(tmpdir(), "afflatus-test-"));
      const services = await createServices(db, "postgres", new LocalStorage(dir), FAST, { shippedPresets: null, precompute: false });
      await services.started;
      const app = buildApp(services, { backup: { dataDir: dir, filesDir: dir } });
      try {
        // Postgres has no index of the library's words: a search reads the items its SQL sieve lets through (assetSearch.ts)
        const now = new Date().toISOString();
        await db.insertInto("generations").values({
          id: "g", owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt: "a red fox in the snow" }), resolved: "{}",
          gen_ms: 1000, draft_id: null, created_at: now,
        }).execute();
        const asset = (id: string, over: Record<string, unknown>) => ({
          id, owner_id: OWNER, kind: "image", origin: "uploaded", name: "", file_key: `${id}.png`, thumb_key: null, mime: "image/png", bytes: 1000, width: 64, height: 64,
          duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: now, ...over,
        });
        await db.insertInto("assets").values([asset("fox", { origin: "generated", generation_id: "g" }), asset("cafe", { name: "zz-test Café du Nord" })] as never).execute();
        const search = async (q: string) => {
          const res = await app.inject({ method: "GET", url: `/api/assets?q=${encodeURIComponent(q)}`, headers: { "x-afflatus": "1" } });
          expect(res.statusCode).toBe(200);
          return (res.json().items as Array<{ id: string }>).map((i) => i.id);
        };
        expect(await search("red fox")).toEqual(["fox"]);
        expect(await search("FOX")).toEqual(["fox"]);
        // a word typed without its accent finds the name that has one
        expect(await search("cafe nord")).toEqual(["cafe"]);
        expect(await search("zebra")).toEqual([]);

        // the days over are digested, and a summary reads the same from the digests as from the rows
        const DAY = 86_400_000;
        const NOW = Date.parse("2026-10-02T18:00:00.000Z");
        const render = (n: number, ago: number): RenderRow => ({
          id: `r${n}`, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "illustrious", time_key: "steps=28",
          kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: n % 2, waited_ms: 0,
          total_ms: 20_000 + n * 100, load_ms: 1_000, sample_ms: 16_000 + n * 100, refine_ms: 0, finish_ms: 3_000, step_ms: 570, expected_ms: 20_000,
          vram_peak: 70, heat_peak: 68, asset_id: null, work: 832 * 1216, machine_id: null, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: new Date(NOW - ago).toISOString(),
        });
        await db.insertInto("render_stats").values([0, 1, 2, 3, 4, 5].map((n) => render(n, n * DAY + 3_600_000))).execute();
        // an ended pod session: the fold keeps its split before its renders become figures (costs.ts freezeSplits, in the
        // fold's transaction), the write that never ran on Postgres while the schema had no session (review O-17)
        const ended = new Date(NOW - 3 * DAY).toISOString();
        await db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: new Date(NOW - 3 * DAY - 3_600_000).toISOString(), ended_at: ended, seen_at: ended, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3 } as never).execute();
        const all = async () => JSON.stringify(await summary(db, services.registry, "all", 90, NOW));
        const fromRows = await all();
        expect(await fold(db, 90, NOW)).toBe(0);
        const split = (await db.selectFrom("rent_sessions").select("split").where("id", "=", "s1").executeTakeFirstOrThrow()).split;
        expect(JSON.parse(split!)).toMatchObject({ spans: expect.any(Array), estimated: expect.any(Array) });
        const digested = async () => (await db.selectFrom("render_digests").select("day").orderBy("day").execute()).map((d) => d.day);
        expect((await digested()).length).toBeGreaterThan(3);
        expect(await all()).toBe(fromRows);
        // older days fold into figures per day: their rows and their digests go
        expect(await fold(db, 2, NOW)).toBeGreaterThan(0);
        expect((await db.selectFrom("render_days").select("day").execute()).length).toBeGreaterThan(0);
        expect((await digested()).every((d) => d >= new Date(NOW - 2 * DAY).toISOString().slice(0, 10))).toBe(true);
      } finally {
        await app.close();
        await services.close();
        await db.destroy().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // The split of a pod still running, kept up to a moment (0085's split_until), written, compared and read back on
  // Postgres: the fold's case above has only an ended session, so no non-null split_until ever ran there (review O-20).
  it("a running pod's split is kept up to the fold's cutoff and to a Forget, Costs reads it back, and 0085 is taken back", async () => {
    await inSchema(async (db) => {
      await migrate(db);
      await writeSettings(db, { comfyUrl: NOWHERE });
      const dir = mkdtempSync(join(tmpdir(), "afflatus-test-"));
      const services = await createServices(db, "postgres", new LocalStorage(dir), FAST, { shippedPresets: null, precompute: false });
      await services.started;
      try {
        const MIN = 60_000;
        const iso = (ms: number) => new Date(ms).toISOString();
        // as costs.test's: s4 runs from 22:00, a render to 23:00 that day and one to 01:00 the next; the fold at 01:00 with
        // one history day cuts at that midnight, while the pod still runs
        const from = Date.parse("2026-10-13T22:00:00.000Z");
        const at = Date.parse("2026-10-15T01:00:00.000Z");
        await db.insertInto("rent_sessions").values({ id: "s4", machine_id: "rp-d", pod: "s4", rate: 0.6, started_at: iso(from), ended_at: null, seen_at: null, gpu: "NVIDIA A40", up_at: iso(from + 2 * MIN), idle_minutes: 10 } as never).execute();
        const render = (n: number, end: number): RenderRow => ({
          id: `r${n}`, owner_id: OWNER, recipe_id: "scail.motion", family: "scail", model: "scail", model_file: "scail.safetensors", time_key: "", kind: "video", width: 832, height: 480, duration_ms: 5000,
          steps: 6, status: "done", whole: 1, cold: 0, waited_ms: 0, total_ms: 30 * MIN, load_ms: 0, sample_ms: 30 * MIN, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null, vram_peak: null, heat_peak: null,
          asset_id: null, work: null, machine_id: "rp-d", gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: iso(end),
        });
        await db.insertInto("render_stats").values([render(1, from + 60 * MIN), render(2, from + 180 * MIN)]).execute();
        const parts = async (when: number) =>
          (await costs({ db, registry: services.registry, settings: await readSettings(db), spending: null, billReadAt: null, costBetween: async () => 0, offers: async () => null }, {}, when)).sessions.find((s) => s.id === "s4")!.parts;
        const until = async () => (await db.selectFrom("rent_sessions").select("split_until").where("id", "=", "s4").executeTakeFirstOrThrow()).split_until;
        const before = await parts(at);
        expect(before).toMatchObject({ render: 60 * MIN });
        await fold(db, 1, at);
        expect(await until()).toBe("2026-10-14T00:00:00.000Z");
        expect(await db.selectFrom("render_stats").select("id").execute()).toEqual([{ id: "r2" }]);
        // the kept part joined to what is left after it
        expect(await parts(at)).toEqual(before);
        // every render time forgotten while it still runs: kept up to then
        await clear(db, at);
        expect(await until()).toBe(iso(at));
        expect(await parts(at)).toEqual(before);

        // 0085 taken back drops the column and leaves the session and its 0084 split; run again, it comes back empty
        const columns = async () => (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'rent_sessions'`.execute(db)).rows.map((c) => c.column_name);
        expect(await migrate(db, "0084_session_split")).toContain("0085_session_split_until");
        expect(await columns()).not.toContain("split_until");
        expect(await columns()).toContain("split");
        expect((await db.selectFrom("rent_sessions").select("split").executeTakeFirstOrThrow()).split).not.toBeNull();
        expect(await migrate(db)).toContain("0085_session_split_until");
        expect(await db.selectFrom("rent_sessions").select(["id", "split_until"]).execute()).toEqual([{ id: "s4", split_until: null }]);
      } finally {
        await services.close();
        await db.destroy().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
