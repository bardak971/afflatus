import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, OWNER } from "../src/db";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

/** The families filter as it was written before 2026-10-22: one join of generations and items per family. */
const before = `select "f"."family" from (select distinct "family" from "generations") as "f" where exists (select "generations"."id" from "generations" inner join "assets" on "assets"."generation_id" = "generations"."id" where "generations"."family" = "f"."family" and "assets"."deleted_at" is null)`;

async function made(family: string, items: Array<"live" | "binned">) {
  const g = newId();
  const at = new Date().toISOString();
  await t.db.insertInto("generations").values({ id: g, owner_id: OWNER, recipe_id: `${family}.text-to-picture`, recipe_version: 1, family, inputs: "{}", resolved: "{}", gen_ms: 1, draft_id: null, created_at: at } as never).execute();
  for (const state of items) {
    const id = newId();
    await t.db.insertInto("assets").values({
      id, owner_id: OWNER, kind: "image", origin: "generated", name: "zz-test", file_key: `assets/${id}`, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1, duration_ms: null, fps: null,
      has_sound: 0, folder_id: null, generation_id: g, kept_at: null, deleted_at: state === "binned" ? at : null, created_at: at,
    }).execute();
  }
}

describe("the families filter", () => {
  it("lists the families of live items, as before, from each family's generations and not by reading every live item", async () => {
    await made("sdxl", ["live", "binned"]);
    await made("sdxl", []);
    await made("h3", ["binned"]);
    await made("wan", []);
    await made("qwen", ["live"]);
    await made("qwen", ["live", "live"]);
    await made("klein", ["binned", "live"]);
    // the planner's figures of a heavy user's library (the review's scale copy), on which the join read every live item per family
    await sql`analyze`.execute(t.db);
    await sql`delete from sqlite_stat1 where tbl in ('assets', 'generations')`.execute(t.db);
    const figures: Array<[string, string, string]> = [
      ["generations", "generations_by_family_id", "3568 179 1"], ["generations", "generations_by_draft_family", "3568 36 14 1"], ["generations", "generations_by_time", "3568 1 1"],
      ["generations", "sqlite_autoindex_generations_1", "3568 1"], ["assets", "assets_in_bin", "213 2 1"], ["assets", "assets_by_origin", "6018 753 1"], ["assets", "assets_by_bin", "6018 29 1 1"],
      ["assets", "assets_by_generation", "6018 3"], ["assets", "assets_by_folder", "6018 70"], ["assets", "assets_by_time", "6018 6018 1"], ["assets", "sqlite_autoindex_assets_1", "6018 1"],
    ];
    for (const [tbl, idx, stat] of figures) await sql`insert into sqlite_stat1 (tbl, idx, stat) values (${tbl}, ${idx}, ${stat})`.execute(t.db);
    await sql`analyze sqlite_schema`.execute(t.db);

    const said: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, text: string) {
      said.push(text);
      return prepare.call(this, text);
    } as typeof prepare);
    const items = (await get(t.app, "/api/assets/families")).json().items as string[];
    vi.restoreAllMocks();
    const was = (await sql.raw<{ family: string }>(before).execute(t.db)).rows.map((r) => r.family);
    expect([...items].sort()).toEqual([...was].sort());
    expect([...items].sort()).toEqual(["klein", "qwen", "sdxl"]);
    const query = said.find((q) => /select distinct "family" from "generations"/.test(q))!;
    const plan = (await sql.raw<{ detail: string }>(`explain query plan ${query}`).execute(t.db)).rows.map((r) => r.detail).join(" | ");
    expect(plan).toContain("assets_by_generation");
    expect(plan).not.toContain("assets_by_bin");
  });
});
