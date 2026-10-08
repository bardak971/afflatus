import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { migrate, newId, openDb, OWNER } from "../src/db";
import type { QueueCore } from "../src/queueModel";
import { history } from "../src/queueView";
import { Registry } from "../src/registry";

/**
 * The migrations on a real Postgres: run only when DATABASE_URL names one (CI's postgres job does; see
 * .github/workflows/ci.yml). Each run works in a schema of its own, dropped after.
 */
const url = process.env.DATABASE_URL?.trim();

describe.skipIf(!url)("on Postgres", () => {
  it("every migration runs, and a size or a work past 2^31 is kept and read back as a number", async () => {
    const schema = `t_${newId().slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    try {
      const at = new URL(url!);
      at.searchParams.set("options", `-c search_path=${schema}`);
      const { db, kind } = openDb({ ...loadConfig({}), databaseUrl: at.toString() });
      expect(kind).toBe("postgres");
      const ran = await migrate(db);
      expect(ran.at(-1)).toBe("0039_wide_sizes");
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
    } finally {
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
});
