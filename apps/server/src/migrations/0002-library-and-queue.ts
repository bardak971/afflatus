import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("folders")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("parent_id", "text")
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("generations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("recipe_version", "integer", (c) => c.notNull())
      .addColumn("family", "text", (c) => c.notNull())
      .addColumn("inputs", "text", (c) => c.notNull())
      .addColumn("resolved", "text", (c) => c.notNull())
      .addColumn("gen_ms", "integer", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("assets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("origin", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("file_key", "text", (c) => c.notNull())
      .addColumn("thumb_key", "text")
      .addColumn("mime", "text", (c) => c.notNull())
      .addColumn("bytes", "integer", (c) => c.notNull())
      .addColumn("width", "integer")
      .addColumn("height", "integer")
      .addColumn("duration_ms", "integer")
      .addColumn("fps", "real")
      .addColumn("has_sound", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("folder_id", "text", (c) => c.references("folders.id").onDelete("set null"))
      .addColumn("generation_id", "text", (c) => c.references("generations.id").onDelete("set null"))
      .addColumn("kept_at", "text")
      .addColumn("deleted_at", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("assets_by_time").on("assets").columns(["owner_id", "created_at"]).execute();
    await db.schema.createIndex("assets_by_folder").on("assets").column("folder_id").execute();
    await db.schema
      .createTable("generation_inputs")
      .addColumn("generation_id", "text", (c) => c.notNull().references("generations.id").onDelete("cascade"))
      .addColumn("asset_id", "text", (c) => c.notNull().references("assets.id").onDelete("cascade"))
      .addColumn("role", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("generation_inputs_pk", ["generation_id", "asset_id", "role"])
      .execute();
    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("inputs", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("priority", "integer", (c) => c.notNull())
      .addColumn("depends_on", "text")
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("resume", "text")
      .addColumn("error", "text")
      .addColumn("generation_id", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("started_at", "text")
      .addColumn("finished_at", "text")
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("jobs_by_status").on("jobs").columns(["status", "priority", "created_at"]).execute();
  },
  async down(db) {
    for (const t of ["jobs", "generation_inputs", "assets", "generations", "folders"]) await db.schema.dropTable(t).execute();
  },
};
export default migration;
