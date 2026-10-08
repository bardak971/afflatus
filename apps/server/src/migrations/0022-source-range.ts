import type { Migration } from "kysely/migration";

// a video cut out of another remembers the range
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("source_range", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("source_range").execute();
  },
};
export default migration;
