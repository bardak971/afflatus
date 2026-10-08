import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("drafts").addColumn("name", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("drafts").dropColumn("name").execute();
  },
};
export default migration;
