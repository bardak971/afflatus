import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("timelines")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("width", "integer")
      .addColumn("height", "integer")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("clips")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("timeline_id", "text", (c) => c.notNull().references("timelines.id").onDelete("cascade"))
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("take_id", "text")
      .addColumn("joined", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text")
      .addColumn("inputs", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("clips_by_timeline").on("clips").columns(["timeline_id", "position"]).execute();
    await db.schema
      .createTable("takes")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("clip_id", "text", (c) => c.notNull().references("clips.id").onDelete("cascade"))
      .addColumn("asset_id", "text", (c) => c.notNull().references("assets.id").onDelete("cascade"))
      .addColumn("head_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("tail_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("trim_start_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("trim_end_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("prev_take_id", "text")
      .addColumn("prev_at_ms", "integer")
      .addColumn("next_take_id", "text")
      .addColumn("next_at_ms", "integer")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("takes_by_clip").on("takes").column("clip_id").execute();
    await db.schema.alterTable("jobs").addColumn("clip_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("clip_fit", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("clip_fit").execute();
    await db.schema.alterTable("jobs").dropColumn("clip_id").execute();
    for (const t of ["takes", "clips", "timelines"]) await db.schema.dropTable(t).execute();
  },
};
export default migration;
