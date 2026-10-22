import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, newId, OWNER, openSqlite, type Db } from "../src/db";
import { dropGoneMachines, writeSettings } from "../src/settings";
import { JOURNAL_LIMIT } from "../src/sqliteWorker";
import { optimizeSearch, RESUME_KEPT_MS, slimFinished } from "../src/tidy";

let db: Db;
beforeEach(async () => {
  db = openSqlite(":memory:", { inline: true });
  await migrate(db);
});
afterEach(async () => {
  await db.destroy();
});

const DAY = 24 * 60 * 60_000;
/** A resume as a render keeps it: what is still read of it once it ended, and the kilobyte and more that is not. */
const whole = (i = 0) => ({
  promptId: `p-${i}`, seed: 1234 + i, overlap: { headMs: 500, tailMs: 0, latent: true }, outputs: [{ node: "9", role: "result", kind: "image" }],
  totalSteps: 30, phases: { "3": { label: "Sampling", steps: 30 } }, passes: [], clientId: "c".repeat(32), titles: { "9": "Save" }, loads: ["checkpoints/zz-test.safetensors"],
  startedAt: 1, input: { prompt: "a lighthouse on a cliff at dusk ".repeat(20) }, timing: { model: "zz-test", modelFile: "zz-test.safetensors", timeKey: "steps=30", cold: false, expectedMs: 9000, expect: {} },
});

async function job(status: string, finishedAgoMs: number | null, resume: unknown, at = Date.now()) {
  const id = newId();
  const finished = finishedAgoMs === null ? null : new Date(at - finishedAgoMs).toISOString();
  await db.insertInto("jobs").values({
    id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status, warm: 0, look: null, priority: 0, depends_on: null, attempts: 1,
    resume: resume === null ? null : JSON.stringify(resume), error: null, generation_id: null, clip_id: null, timeline_id: null, clip_fit: 0, finished_from: null, draft_id: null, folder_id: null,
    created_at: new Date(at - 3 * DAY).toISOString(), started_at: null, finished_at: finished, updated_at: new Date(at).toISOString(),
  } as never).execute();
  return id;
}
const resumeOf = async (id: string) => JSON.parse((await db.selectFrom("jobs").select("resume").where("id", "=", id).executeTakeFirstOrThrow()).resume!) as Record<string, unknown>;

describe("a finished job's resume", () => {
  it("is cut down to what is still read of it a day after the job ended, and only then; a job still to run keeps all of it", async () => {
    const old = await job("done", RESUME_KEPT_MS + 60_000, whole(1));
    const failed = await job("failed", 30 * DAY, { ...whole(2), made: "a".repeat(32) });
    const recent = await job("done", RESUME_KEPT_MS - 60_000, whole(3));
    const running = await job("running", null, whole(4));
    const queued = await job("queued", null, whole(5));
    const small = await job("cancelled", 30 * DAY, { promptId: "p-6" });
    const none = await job("cancelled", 30 * DAY, null);
    expect(await slimFinished(db)).toBe(2);
    expect(await resumeOf(old)).toEqual({ promptId: "p-1", seed: 1235, overlap: { headMs: 500, tailMs: 0, latent: true } });
    expect(await resumeOf(failed)).toEqual({ promptId: "p-2", seed: 1236, overlap: { headMs: 500, tailMs: 0, latent: true }, made: "a".repeat(32) });
    for (const [id, i] of [[recent, 3], [running, 4], [queued, 5]] as const) expect(await resumeOf(id)).toEqual(whole(i));
    expect(await resumeOf(small)).toEqual({ promptId: "p-6" });
    expect((await db.selectFrom("jobs").select("resume").where("id", "=", none).executeTakeFirstOrThrow()).resume).toBeNull();
    // no job is deleted
    expect(Number((await db.selectFrom("jobs").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n)).toBe(7);
  });

  it("is cut on every page of jobs that ended in the same moment, and a pass after reads only what ended since", async () => {
    const at = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 1200; i++) ids.push(await job("done", 2 * DAY, whole(i), at));
    expect(await slimFinished(db, at)).toBe(1200);
    const bytes = await db.selectFrom("jobs").select(sql<number>`max(length(resume))`.as("n")).executeTakeFirstOrThrow();
    expect(bytes.n).toBeLessThan(200);
    // a job that ended a day before the last pass's limit, written whole meanwhile, is not read again: the next pass starts there
    await db.updateTable("jobs").set({ resume: JSON.stringify(whole(0)) }).where("id", "=", ids[0]!).execute();
    const later = await job("done", RESUME_KEPT_MS + 60_000, whole(9), at + DAY);
    expect(await slimFinished(db, at + DAY)).toBe(1);
    expect(await resumeOf(later)).toEqual({ promptId: "p-9", seed: 1243, overlap: { headMs: 500, tailMs: 0, latent: true } });
  });
});

describe("the library's word index", () => {
  it("is merged back into one segment", async () => {
    const at = new Date().toISOString();
    for (let i = 0; i < 40; i++) {
      const id = newId();
      await db.insertInto("assets").values({
        id, owner_id: OWNER, kind: "image", origin: "uploaded", name: `zz-test harbour ${i}`, file_key: `assets/${id}`, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1,
        duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: at,
      }).execute();
    }
    const segments = async () => Number((await sql<{ n: number }>`select count(*) as n from asset_words_index_idx`.execute(db)).rows[0]!.n);
    const found = async () => (await sql<{ n: number }>`select count(*) as n from asset_words_index where asset_words_index match 'harbour'`.execute(db)).rows[0]!.n;
    expect(await segments()).toBeGreaterThan(1);
    expect(await found()).toBe(40);
    await optimizeSearch(db);
    expect(await segments()).toBe(1);
    expect(await found()).toBe(40);
  });
});

describe("the queue's notes of machines", () => {
  const notes = async () => (await db.selectFrom("settings").select("key").where("key", "like", "queue.%").orderBy("key").execute()).map((r) => r.key);
  const note = (key: string) => db.insertInto("settings").values({ key, value: "true", updated_at: new Date().toISOString() }).execute();
  const machine = (id: string, port: number) => ({ id, url: `http://127.0.0.1:${port}` });

  it("go with their machine, removed now or before this start; the others', the first machine's and Pause all stay", async () => {
    await writeSettings(db, { machines: [machine("m1", 18188), machine("m2", 18189)] });
    for (const key of ["queue.paused", "queue.model", "queue.loads", "queue.pausedAll", "queue.paused.m1", "queue.paused.m2", "queue.model.m2", "queue.loads.m2", "queue.paused.rp-gone", "queue.model.rp-gone", "queue.loads.rp-gone"]) await note(key);
    expect(await dropGoneMachines(db)).toBe(3);
    expect(await notes()).toEqual(["queue.loads", "queue.loads.m2", "queue.model", "queue.model.m2", "queue.paused", "queue.paused.m1", "queue.paused.m2", "queue.pausedAll"]);
    // m2 removed in the settings: its notes go with it
    await writeSettings(db, { machines: [machine("m1", 18188)] });
    expect(await notes()).toEqual(["queue.loads", "queue.model", "queue.paused", "queue.paused.m1", "queue.pausedAll"]);
  });

  it("stay when the stored list cannot be read whole, or was never written", async () => {
    await note("queue.paused.rp-gone");
    expect(await dropGoneMachines(db)).toBe(0);
    await db.insertInto("settings").values({ key: "machines", value: "not json", updated_at: new Date().toISOString() }).execute();
    expect(await dropGoneMachines(db)).toBe(0);
    await db.updateTable("settings").set({ value: JSON.stringify([{ url: "http://127.0.0.1:18188" }]) }).where("key", "=", "machines").execute();
    expect(await dropGoneMachines(db)).toBe(0);
    expect(await notes()).toEqual(["queue.paused.rp-gone"]);
  });
});

describe("the WAL file", () => {
  it("is cut back to JOURNAL_LIMIT after a checkpoint, on this thread and in the worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-wal-"));
    try {
      for (const opts of [{ inline: true }, { worker: true }]) {
        const file = openSqlite(join(dir, `zz-test-${opts.inline ? "inline" : "worker"}.db`), opts);
        const limit = (await sql<{ journal_size_limit: number }>`pragma journal_size_limit`.execute(file)).rows[0]!.journal_size_limit;
        expect(limit).toBe(JOURNAL_LIMIT);
        await file.destroy();
      }
      expect(JOURNAL_LIMIT).toBe(16 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
