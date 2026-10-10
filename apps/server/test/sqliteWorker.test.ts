import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openSqlite, type Db } from "../src/db";

const opened: Db[] = [];
const open = (file = ":memory:", inline = false) => {
  const db = openSqlite(file, inline ? { inline } : { worker: true });
  opened.push(db);
  return db;
};
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.destroy().catch(() => undefined)));
});

const row = (key: string) => ({ key, value: "zz-test", updated_at: "2026-10-10T00:00:00.000Z" });
const failure = async (work: Promise<unknown>) => {
  const err = (await work.then(() => null, (e: unknown) => e)) as (Error & { code?: string; errcode?: number; errstr?: string }) | null;
  return err && { message: err.message, code: err.code, errcode: err.errcode, errstr: err.errstr };
};

describe("SQLite in its worker thread", () => {
  it("does not hold the server's thread while a statement runs", async () => {
    const db = open();
    // a statement that takes a while: counting to a few million in SQL
    const slow = sql<{ n: number }>`with recursive c(n) as (select 1 union all select n + 1 from c where n < 3000000) select count(*) as n from c`.execute(db);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const { rows } = await slow;
    clearInterval(timer);
    expect(rows[0]!.n).toBe(3_000_000);
    // on this thread the timer could not fire once until the count was done
    expect(ticks).toBeGreaterThan(2);
  });

  it("throws node:sqlite's own errors: the same message and code as on this thread, with the caller in the stack", async () => {
    const cases = async (db: Db) => {
      await migrate(db);
      await db.insertInto("settings").values(row("a")).execute();
      const unique = await failure(db.insertInto("settings").values(row("a")).execute());
      await sql`create table zz_parent (id text primary key)`.execute(db);
      await sql`create table zz_child (parent text references zz_parent (id))`.execute(db);
      const foreign = await failure(sql`insert into zz_child (parent) values ('nowhere')`.execute(db));
      const syntax = await failure(sql`selec 1`.execute(db));
      return { unique, foreign, syntax };
    };
    const inWorker = await cases(open());
    expect(inWorker.unique).toMatchObject({ message: "UNIQUE constraint failed: settings.key", code: "ERR_SQLITE_ERROR", errcode: 1555 });
    expect(inWorker.foreign).toMatchObject({ message: "FOREIGN KEY constraint failed", code: "ERR_SQLITE_ERROR" });
    expect(inWorker).toEqual(await cases(open(":memory:", true)));
    const err = (await db0Error()) as Error;
    expect(err.stack).toContain("sqliteWorker.test.ts");
  });

  it("carries big integers and bytes both ways, and says what a write changed", async () => {
    const db = open();
    await sql`create table zz_test (id integer primary key, n integer, b blob)`.execute(db);
    const written = await sql`insert into zz_test (n, b) values (${2n ** 40n}, ${new Uint8Array([0, 1, 254, 255])})`.execute(db);
    expect(written).toMatchObject({ insertId: 1n, numAffectedRows: 1n });
    const { rows } = await sql<{ n: number; b: Uint8Array }>`select n, b from zz_test`.execute(db);
    expect(rows[0]!.n).toBe(2 ** 40);
    expect([...rows[0]!.b]).toEqual([0, 1, 254, 255]);
    expect((await db.deleteFrom("zz_test" as never).executeTakeFirst()).numDeletedRows).toBe(1n);
  });

  it("runs the statements in the order they were asked, even all at once", async () => {
    const db = open();
    await sql`create table zz_test (id integer primary key, n integer)`.execute(db);
    await Promise.all(Array.from({ length: 200 }, (_, n) => sql`insert into zz_test (n) values (${n})`.execute(db)));
    const { rows } = await sql<{ id: number; n: number }>`select id, n from zz_test order by id`.execute(db);
    expect(rows.map((r) => r.n)).toEqual(rows.map((r) => r.id - 1));
  });

  it("lets a transaction hold the database: what is asked meanwhile waits for its end, and is not part of it", async () => {
    const db = open();
    await migrate(db);
    let inside = false;
    const seen: Array<{ inside: boolean; rows: number }> = [];
    const trx = db.transaction().execute(async (trx) => {
      inside = true;
      await trx.insertInto("settings").values(row("zz-a")).execute();
      await new Promise((r) => setTimeout(r, 30));
      await trx.insertInto("settings").values(row("zz-b")).execute();
      inside = false;
      throw new Error("zz-test rollback");
    });
    // asked while the transaction is open: answered after its rollback, so it sees neither row
    const meanwhile = db.selectFrom("settings").selectAll().where("key", "like", "zz-%").execute().then((rows) => seen.push({ inside, rows: rows.length }));
    await expect(trx).rejects.toThrow("zz-test rollback");
    await meanwhile;
    expect(seen).toEqual([{ inside: false, rows: 0 }]);
    // and a committed one keeps both
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("settings").values(row("zz-a")).execute();
      await trx.insertInto("settings").values(row("zz-b")).execute();
    });
    expect(await db.selectFrom("settings").select("key").where("key", "like", "zz-%").orderBy("key").execute()).toEqual([{ key: "zz-a" }, { key: "zz-b" }]);
  });

  it("closes its worker: the file is written and opens again, and a statement after the close is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-worker-"));
    try {
      const file = join(dir, "zz-test.db");
      const db = openSqlite(file, { worker: true });
      await migrate(db);
      await db.insertInto("settings").values(row("zz-kept")).execute();
      await db.destroy();
      await expect(db.selectFrom("settings").selectAll().execute()).rejects.toThrow();
      const again = open(file);
      expect(await again.selectFrom("settings").select("value").where("key", "=", "zz-kept").executeTakeFirst()).toEqual({ value: "zz-test" });
      await again.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says why a database cannot be opened, at its first statement", async () => {
    const db = open(join(tmpdir(), "afflatus-no-such-folder", "zz", "zz-test.db"));
    await expect(sql`select 1`.execute(db)).rejects.toThrow(/unable to open/);
  });
});

/** An error thrown by a statement asked from this file, for its stack. */
async function db0Error(): Promise<unknown> {
  const db = open();
  return sql`select * from no_such_table`.execute(db).then(() => null, (e: unknown) => e);
}
