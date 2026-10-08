import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("settings")
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("settings").execute();
  },
};
export default migration;
