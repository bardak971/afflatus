import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { openSqlite, OWNER } from "../src/db";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  // on this thread, not in the worker: the tests count the statements a route prepares, with a spy on node:sqlite here
  t = await makeApp({ db: openSqlite(":memory:", { inline: true }) });
});
afterEach(async () => {
  await t.close();
});

/** A job row as the queue leaves it, finished `minute` minutes into the day (several can end in the same minute). */
const job = (id: string, status: string, minute: number | null, extra: Record<string, unknown> = {}) => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
  return {
    id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: `job ${id}`, inputs: "{}", status, warm: 0, look: null, priority: 20, depends_on: null, attempts: 1,
    resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null, finished_from: null,
    created_at: at(minute ?? 59), started_at: minute === null ? null : at(minute), finished_at: minute === null ? null : at(minute), updated_at: at(minute ?? 59), ...extra,
  };
};

describe("the queue's history", () => {
  it("pages by offset or by the cursor alike, newest first, and leaves out what is not finished or only loaded a model", async () => {
    const rows = [
      job("a", "done", 1), job("b", "failed", 2), job("c", "done", 3), job("d", "cancelled", 3), job("e", "done", 3), job("f", "done", 5), job("g", "done", 6),
      job("warm", "done", 7, { warm: 1 }), job("waiting", "queued", null),
    ];
    await t.db.insertInto("jobs").values(rows as never).execute();
    const all = (await get(t.app, "/api/jobs?limit=200")).json();
    const order = all.items.map((i: { id: string }) => i.id);
    expect(order).toEqual(["g", "f", "e", "d", "c", "b", "a"]);
    expect(all.counts).toEqual({ done: 5, failed: 1, cancelled: 1 });
    const byOffset: string[] = [];
    const byCursor: string[] = [];
    for (let offset = 0, more = true; more; offset += 3) {
      const page = (await get(t.app, `/api/jobs?limit=3&offset=${offset}`)).json();
      byOffset.push(...page.items.map((i: { id: string }) => i.id));
      more = page.more;
    }
    for (let after: string | null = "", n = 0; after !== null && n < 10; n++) {
      const page: { items: Array<{ id: string }>; next: string | null; more: boolean } = (await get(t.app, `/api/jobs?limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`)).json();
      byCursor.push(...page.items.map((i: { id: string }) => i.id));
      after = page.next;
      expect(Boolean(page.next)).toBe(page.more);
    }
    expect(byOffset).toEqual(order);
    expect(byCursor).toEqual(order);
    // a status picked follows the cursor too; the counts still say what each chip would show
    const done = (await get(t.app, "/api/jobs?status=done&limit=2")).json();
    expect(done.items.map((i: { id: string }) => i.id)).toEqual(["g", "f"]);
    const rest = (await get(t.app, `/api/jobs?status=done&limit=5&after=${encodeURIComponent(done.next)}`)).json();
    expect(rest.items.map((i: { id: string }) => i.id)).toEqual(["e", "c", "a"]);
    expect(rest.counts).toEqual({ done: 5, failed: 1, cancelled: 1 });
  });

  it("gives some jobs by id whatever ran since, with the copies of a person a picture of them had pasted in", async () => {
    const id = (n: number) => String(n).padStart(32, "0");
    const at = new Date(Date.UTC(2026, 9, 1, 9, 0)).toISOString();
    await t.db.insertInto("generations").values({ id: "g1", owner_id: OWNER, recipe_id: "qwen21.motion-picture", recipe_version: 1, family: "qwen21", inputs: "{}", resolved: JSON.stringify({ face: 0.91, faceCopies: 2 }), gen_ms: 1, draft_id: null, created_at: at } as never).execute();
    // a picture box's three, then sixty other renders: the last page holds none of them any more
    await t.db.insertInto("jobs").values([job(id(1), "done", 1, { generation_id: "g1" }), job(id(2), "failed", 1), job(id(3), "done", 1), ...Array.from({ length: 60 }, (_, i) => job(id(100 + i), "done", 30))] as never).execute();
    const asked = (await get(t.app, `/api/jobs?ids=${id(1)},${id(2)},${id(3)}`)).json();
    expect(asked.items.map((i: { id: string }) => i.id).sort()).toEqual([id(1), id(2), id(3)]);
    expect(asked.items.find((i: { id: string }) => i.id === id(1))).toMatchObject({ face: 0.91, faceCopies: 2 });
    expect(asked.items.find((i: { id: string }) => i.id === id(3))).toMatchObject({ faceCopies: 0 });
    expect((await get(t.app, "/api/jobs?ids=not-an-id")).statusCode).toBe(400);
  });

  it("reads the finished jobs from the index on when they ended, not by sorting them all", async () => {
    await t.db.insertInto("jobs").values([job("a", "done", 1), job("b", "failed", 2), job("waiting", "queued", null)] as never).execute();
    // the SQL the history and the queue's recent jobs run, planned by SQLite as it is
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    await get(t.app, "/api/jobs?limit=60");
    await get(t.app, "/api/queue");
    const ran = prepare.mock.calls.map((c) => String(c[0])).filter((q) => /from "jobs"/.test(q) && /order by "finished_at" desc/.test(q));
    prepare.mockRestore();
    expect(ran).toHaveLength(2);
    for (const q of ran) {
      const plan = (await sql.raw<{ detail: string }>(`explain query plan ${q}`).execute(t.db)).rows.map((r) => r.detail).join(" | ");
      expect(plan).toContain("jobs_by_finish");
      expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    }
  });
});
