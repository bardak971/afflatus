import { describe, expect, it } from "vitest";
import { migrate, openSqlite, type Db } from "../src/db";
import { readSettings } from "../src/settings";

/**
 * The one LLM from before there was a list (migration 0108, card #262): made the list's first and its row deleted, so that
 * its API key no longer stays in the database once the model is changed in Settings.
 */
const at = "2026-11-03T10:00:00.000Z";

async function before(rows: Record<string, unknown>): Promise<Db> {
  const db: Db = openSqlite(":memory:");
  await migrate(db, "0107_jobs_by_machine_start");
  for (const [key, value] of Object.entries(rows)) await db.insertInto("settings").values({ key, value: JSON.stringify(value), updated_at: at }).execute();
  return db;
}
const keys = async (db: Db) => (await db.selectFrom("settings").select("key").execute()).map((r) => r.key).sort();

describe("the old LLM row", () => {
  it("becomes the list's first model, its row and its key gone from the settings table", async () => {
    const db = await before({ llm: { baseUrl: "http://127.0.0.1:1/v1", model: "zz-test", apiKey: "zz-secret-old" }, runpodS3User: "user_zztest" });
    await migrate(db);
    expect(await keys(db)).toEqual(["llms"]);
    expect((await db.selectFrom("settings").select("value").execute()).map((r) => r.value).join()).not.toContain("user_zztest");
    expect((await readSettings(db)).llms).toMatchObject([{ id: "main", baseUrl: "http://127.0.0.1:1/v1", model: "zz-test", apiKey: "zz-secret-old" }]);
  });

  it("only goes where there is a list already, and with no address it was no model", async () => {
    const listed = await before({ llm: { baseUrl: "http://old/v1", apiKey: "zz-secret-old" }, llms: [{ id: "a", baseUrl: "http://new/v1", model: "m" }] });
    await migrate(listed);
    expect(await keys(listed)).toEqual(["llms"]);
    expect((await readSettings(listed)).llms.map((l) => l.id)).toEqual(["a"]);
    const empty = await before({ llm: { baseUrl: "", apiKey: "zz-secret-old" } });
    await migrate(empty);
    expect(await keys(empty)).toEqual([]);
  });
});
