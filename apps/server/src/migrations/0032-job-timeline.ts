import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("timeline_id", "text").execute();
    await db.schema.createIndex("jobs_by_timeline").on("jobs").columns(["timeline_id", "created_at"]).execute();
    // the exports and cuts there are: an export names its timeline in its inputs, a cut names a clip of one
    const rows = await db.selectFrom("jobs").select(["id", "recipe_id", "inputs"]).where("recipe_id", "in", ["afflatus.export", "afflatus.cut"]).execute();
    for (const r of rows) {
      let inputs: { timeline?: unknown; clip?: unknown };
      try {
        inputs = JSON.parse(r.inputs) as { timeline?: unknown; clip?: unknown };
      } catch {
        continue;
      }
      let timeline = typeof inputs.timeline === "string" ? inputs.timeline : null;
      if (!timeline && typeof inputs.clip === "string") {
        timeline = (await db.selectFrom("clips").select("timeline_id").where("id", "=", inputs.clip).executeTakeFirst())?.timeline_id ?? null;
      }
      if (timeline) await db.updateTable("jobs").set({ timeline_id: timeline }).where("id", "=", r.id).execute();
    }
  },
  async down(db) {
    await db.schema.dropIndex("jobs_by_timeline").execute();
    await db.schema.alterTable("jobs").dropColumn("timeline_id").execute();
  },
};
export default migration;
