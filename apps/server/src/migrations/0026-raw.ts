import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("raw_key", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("raw_key").execute();
  },
};
export default migration;
