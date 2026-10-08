import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_pages")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("url", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("found_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_pages_pk", ["folder", "name"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_pages").execute();
  },
};
export default migration;
