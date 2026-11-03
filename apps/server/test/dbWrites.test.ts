import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { migrate, openSqlite } from "../src/db";
import { keptRead, writesTo } from "../src/dbWrites";

/**
 * The writes counted by table (dbWrites.ts, card #244): a read of the model tables is kept until one of them is written
 * to, whatever wrote it, and read again then.
 */
describe("a read kept until its tables are written to", () => {
  it("is read once while nothing is written, again after an insert, an update, a delete or a statement by hand", async () => {
    const db = openSqlite(":memory:", { inline: true });
    await migrate(db);
    let reads = 0;
    const pages = keptRead(["model_pages"], async (d: typeof db) => {
      reads++;
      return d.selectFrom("model_pages").selectAll().execute();
    });
    expect(await pages(db)).toEqual([]);
    expect(await pages(db)).toEqual([]);
    expect(reads).toBe(1);
    const before = writesTo(["model_*"]);
    await db.insertInto("model_pages").values({ folder: "loras", name: "zz-test", url: "https://example.com/a", title: "a", found_at: "2026-11-03" }).execute();
    expect(writesTo(["model_*"])).toBe(before + 1);
    expect((await pages(db)).map((r) => r.url)).toEqual(["https://example.com/a"]);
    await db.updateTable("model_pages").set({ url: "https://example.com/b" }).execute();
    expect((await pages(db)).map((r) => r.url)).toEqual(["https://example.com/b"]);
    await sql`delete from model_pages`.execute(db);
    expect(await pages(db)).toEqual([]);
    expect(reads).toBe(4);
    // a write to another table leaves it kept, a read of its own table too
    const others = writesTo(["model_info"]);
    await db.insertInto("model_info").values({ folder: "loras", file: "zz-test.safetensors", info: "{}", read_at: "2026-11-03" }).execute();
    expect(writesTo(["model_info"])).toBe(others + 1);
    await db.selectFrom("model_pages").selectAll().execute();
    await pages(db);
    expect(reads).toBe(4);
    await db.destroy();
  });
});
