import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("drafts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("target", "text", (c) => c.notNull())
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("forms", "text", (c) => c.notNull())
      .addColumn("count", "integer", (c) => c.notNull())
      .addColumn("chat", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("drafts_by_time").on("drafts").columns(["owner_id", "updated_at"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("drafts").execute();
  },
};
export default migration;
