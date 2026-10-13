import { describe, expect, it } from "vitest";
import { migrate, openSqlite, OWNER } from "../src/db";

/** The Prompt kit's cut-outs were removed: migration 0058 takes them out of the people kept with them. */

describe("migration 0058, no more cut-outs", () => {
  it("takes the switch and the cut-outs out of a person, and the cut-out pictures to the bin", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0057_kit_cutouts");
    const at = new Date().toISOString();
    const asset = (id: string, origin: string) => db.insertInto("assets").values({
      id, owner_id: OWNER, kind: "image", origin, name: id, file_key: `assets/${id}`, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1,
      duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
    } as never).execute();
    await asset("photo", "kit");
    await asset("cut", "kit");
    const entity = (id: string, def: unknown) => db.insertInto("entities").values({ id, owner_id: OWNER, kind: "person", name: id, def: JSON.stringify(def), created_at: at, updated_at: at } as never).execute();
    await entity("nico", { pictures: ["photo"], voice: null, cutout: true, cutouts: { photo: "cut" } });
    await entity("plain", { pictures: [], voice: null });
    expect(await migrate(db)).toContain("0058_no_cutouts");
    const defs = Object.fromEntries((await db.selectFrom("entities").select(["id", "def"]).execute()).map((e) => [e.id, JSON.parse(e.def)]));
    expect(defs.nico).toEqual({ pictures: ["photo"], voice: null });
    expect(defs.plain).toEqual({ pictures: [], voice: null });
    const gone = Object.fromEntries((await db.selectFrom("assets").select(["id", "deleted_at"]).execute()).map((a) => [a.id, a.deleted_at !== null]));
    expect(gone).toEqual({ photo: false, cut: true });
    await db.destroy();
  });
});

describe("migration 0060, jobs.kit_for dropped", () => {
  it("takes the column off the jobs, which keep everything else", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0058_no_cutouts");
    expect(await migrate(db)).toContain("0060_drop_kit_for");
    const columns = (await db.introspection.getTables()).find((t) => t.name === "jobs")!.columns.map((c) => c.name);
    expect(columns).not.toContain("kit_for");
    expect(columns).toContain("recipe_id");
    await db.destroy();
  });
});
