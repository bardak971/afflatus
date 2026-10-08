import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("render_stats")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("family", "text", (c) => c.notNull())
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("model_file", "text", (c) => c.notNull())
      .addColumn("time_key", "text", (c) => c.notNull())
      .addColumn("kind", "text")
      .addColumn("width", "integer")
      .addColumn("height", "integer")
      .addColumn("duration_ms", "integer")
      .addColumn("steps", "integer", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("whole", "integer", (c) => c.notNull())
      .addColumn("cold", "integer", (c) => c.notNull())
      .addColumn("waited_ms", "integer", (c) => c.notNull())
      .addColumn("total_ms", "integer", (c) => c.notNull())
      .addColumn("load_ms", "integer", (c) => c.notNull())
      .addColumn("sample_ms", "integer", (c) => c.notNull())
      .addColumn("refine_ms", "integer", (c) => c.notNull())
      .addColumn("finish_ms", "integer", (c) => c.notNull())
      .addColumn("step_ms", "real")
      .addColumn("expected_ms", "integer")
      .addColumn("vram_peak", "real")
      .addColumn("heat_peak", "real")
      .addColumn("asset_id", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("render_stats_at").on("render_stats").column("created_at").execute();
    await db.schema.createIndex("render_stats_recipe").on("render_stats").columns(["recipe_id", "created_at"]).execute();
    await db.schema
      .createTable("render_days")
      .addColumn("day", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("model_file", "text", (c) => c.notNull())
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("family", "text", (c) => c.notNull())
      .addColumn("figures", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("render_days_pk", ["day", "recipe_id", "model_file"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("render_days").execute();
    await db.schema.dropTable("render_stats").execute();
  },
};
export default migration;
