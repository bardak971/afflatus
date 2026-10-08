import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_updates")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("model_id", "integer", (c) => c.notNull())
      .addColumn("model_name", "text", (c) => c.notNull())
      .addColumn("version_id", "integer", (c) => c.notNull())
      .addColumn("version_name", "text", (c) => c.notNull())
      .addColumn("latest_id", "integer")
      .addColumn("latest_name", "text")
      .addColumn("latest_at", "text")
      .addColumn("latest_file", "text")
      .addColumn("checked_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_updates_pk", ["folder", "name"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_updates").execute();
  },
};
export default migration;
