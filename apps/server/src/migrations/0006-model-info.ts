import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_info")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("info", "text", (c) => c.notNull())
      .addColumn("read_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_info_pk", ["folder", "file"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_info").execute();
  },
};
export default migration;
