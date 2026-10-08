import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("timeline_future")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("timeline_id", "text", (c) => c.notNull())
      .addColumn("seq", "integer", (c) => c.notNull())
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("snapshot", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("timeline_future_by_timeline").on("timeline_future").columns(["timeline_id", "seq"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("timeline_future").execute();
  },
};
export default migration;
