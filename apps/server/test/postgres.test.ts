import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { migrate, newId, openDb, OWNER, type Db } from "../src/db";
import { migrations } from "../src/migrations";
import type { QueueCore } from "../src/queueModel";
import { history } from "../src/queueView";
import { Registry } from "../src/registry";
import type { RenderRow } from "../src/renderDigests";
import { fold } from "../src/renders";
import { summary } from "../src/rendersRead";
import { createServices } from "../src/services";
import { writeSettings } from "../src/settings";
import { LocalStorage } from "../src/storage";
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
          vram_peak: 70, heat_peak: 68, asset_id: null, work: 832 * 1216, created_at: new Date(NOW - ago).toISOString(),
        });
        await db.insertInto("render_stats").values([0, 1, 2, 3, 4, 5].map((n) => render(n, n * DAY + 3_600_000))).execute();
        const all = async () => JSON.stringify(await summary(db, services.registry, "all", 90, NOW));
        const fromRows = await all();
        expect(await fold(db, 90, NOW)).toBe(0);
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
});
