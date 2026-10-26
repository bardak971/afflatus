import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate, newId, now, openSqlite, OWNER, type Db } from "../src/db";
import { unusedDrafts } from "../src/drafts";
import { Notify } from "../src/notify";
import { Outside } from "../src/queueOutside";
import { inUse } from "../src/sweep";

/**
 * The reads of the jobs still to run (queued or running) go through the partial index jobs_to_run (migration 0086), on a
 * jobs table shaped as the owner's: 1,285 finished jobs over three statuses, the planner's figures taken by ANALYZE. On it,
 * a status list bound as parameters read the whole table (the 2026-10-22 review: 57 to 85 ms a call on a year of jobs).
 */
let db: Db;
const said: string[] = [];
const prepare = DatabaseSync.prototype.prepare;

beforeAll(async () => {
  db = openSqlite(":memory:", { inline: true });
  await migrate(db);
  const at = now();
  const job = (status: string, i: number) => ({
    id: newId(), owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status, warm: i % 3 === 0 ? 1 : 0, look: null, priority: 0, depends_on: null, attempts: 1,
    resume: JSON.stringify({ promptId: newId() }), error: null, generation_id: null, clip_id: null, timeline_id: null, clip_fit: 0, finished_from: null, draft_id: null, folder_id: null,
    created_at: at, started_at: at, finished_at: status === "queued" || status === "running" ? null : new Date(Date.parse(at) - i * 60_000).toISOString(), updated_at: at,
  });
  const statuses = ["done", "failed", "cancelled"];
  for (let i = 0; i < 1285; i += 200) await db.insertInto("jobs").values(Array.from({ length: Math.min(200, 1285 - i) }, (_, k) => job(statuses[(i + k) % 3]!, i + k)) as never).execute();
  await db.insertInto("jobs").values([job("queued", 0), job("running", 0)] as never).execute();
  // the planner's figures of the owner's jobs table on 2026-10-22, as ANALYZE wrote them (jobs_to_run's: two jobs to run)
  await sql`analyze`.execute(db);
  await sql`delete from sqlite_stat1 where tbl = 'jobs'`.execute(db);
  const owners: Array<[string, string]> = [
    ["jobs_by_status_warm", "1285 429 257"], ["jobs_by_finish", "1285 1 1"], ["jobs_by_depends_on", "1285 24"], ["jobs_by_generation", "1285 2"], ["jobs_by_clip", "1285 7"],
    ["jobs_by_timeline", "1285 68 1"], ["jobs_by_status", "1285 429 161 1"], ["sqlite_autoindex_jobs_1", "1285 1"], ["jobs_to_run", "2 1"],
  ];
  for (const [idx, stat] of owners) await sql`insert into sqlite_stat1 (tbl, idx, stat) values ('jobs', ${idx}, ${stat})`.execute(db);
  await sql`analyze sqlite_schema`.execute(db);
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, text: string) {
    said.push(text);
    return prepare.call(this, text);
  } as typeof prepare);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.destroy();
});

const plan = async (query: string) => (await sql.raw<{ detail: string }>(`explain query plan ${query}`).execute(db)).rows.map((r) => r.detail).join(" | ");

/** The statements on jobs that `run` sends, each with its plan. */
async function jobReads(run: () => Promise<unknown>): Promise<Array<{ query: string; plan: string }>> {
  said.length = 0;
  await run();
  const reads = [...new Set(said.filter((q) => /^select .* from "jobs"/.test(q) && /status/.test(q)))];
  return Promise.all(reads.map(async (query) => ({ query, plan: await plan(query) })));
}

describe("the jobs still to run", () => {
  it("are read through jobs_to_run, which a status list bound as parameters cannot use", async () => {
    expect(await plan(`select id from jobs where status in ('queued', 'running')`)).toContain("USING INDEX jobs_to_run");
    // why the queries write the statuses as literals: the same list bound reads the table
    expect(await plan(`select id from jobs where status in (?, ?)`)).toMatch(/^SCAN jobs$/);
  });

  it("have an index that migration 0086 makes and takes back", async () => {
    const other = openSqlite(":memory:", { inline: true });
    const named = async () => (await sql<{ name: string }>`select name from sqlite_master where type = 'index' and name = 'jobs_to_run'`.execute(other)).rows.length;
    await migrate(other);
    expect(await named()).toBe(1);
    await migrate(other, "0085_session_split_until");
    expect(await named()).toBe(0);
    await other.destroy();
  });

  it("by the sweep, a draft's tidying, the end of a batch and ComfyUI's own queue", async () => {
    const at = now();
    await db.insertInto("drafts").values({ id: newId(), owner_id: OWNER, project_id: null, recipe_id: "sdxl.text-to-picture", title: "", name: null, count: 1, chat: null, target: "new", forms: "{}", look: null, created_at: at, updated_at: at } as never).execute();
    const notify = new Notify({ db } as never);
    (notify as unknown as { batch: object }).batch = {};
    const outside = new Outside({ db, events: new EventEmitter(), machineLanes: () => [], stale: () => undefined, stuck: () => undefined, stopped: () => false, onOutside: () => {}, pump: () => {} });
    const callers: Record<string, () => Promise<unknown>> = {
      inUse: () => inUse(db),
      unusedDrafts: () => unusedDrafts(db),
      emptied: () => (notify as unknown as { emptied(): Promise<void> }).emptied(),
      ownPrompts: () => outside.ownPrompts({ id: "m1" } as never),
    };
    const scans: string[] = [];
    for (const [name, run] of Object.entries(callers)) {
      const reads = await jobReads(run);
      expect(reads.length, name).toBeGreaterThan(0);
      for (const r of reads) if (/SCAN jobs(?! USING)/.test(r.plan)) scans.push(`${name}: ${r.query}`);
      if (!reads.some((r) => r.plan.includes("jobs_to_run"))) scans.push(`${name}: not through jobs_to_run`);
    }
    expect(scans).toEqual([]);
  });

  it("and the jobs that ended a moment ago, for ComfyUI's own queue: the same prompts as one read with an `or`", async () => {
    const outside = new Outside({ db, events: new EventEmitter(), machineLanes: () => [], stale: () => undefined, stuck: () => undefined, stopped: () => false, onOutside: () => {}, pump: () => {} });
    const since = new Date(Date.now() - 2 * 60_000).toISOString();
    const rows = await db.selectFrom("jobs").select("resume").where("resume", "is not", null).where((eb) => eb.or([eb("status", "in", ["running", "queued"]), eb("finished_at", ">=", since)])).execute();
    const ids = rows.map((r) => (JSON.parse(r.resume!) as { promptId: string }).promptId);
    expect(ids.length).toBeGreaterThan(2);
    const own = await outside.ownPrompts({ id: "m1" } as never);
    for (const id of ids) expect(own(id)).toBe(true);
    expect(own(newId())).toBe(false);
  });
});
