import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_settings")
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("family", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("values", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_settings_pk", ["owner_id", "family", "file"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_settings").execute();
  },
};
export default migration;
