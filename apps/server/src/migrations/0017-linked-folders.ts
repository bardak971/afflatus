import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("folders").addColumn("path", "text").execute();
    await db.schema.alterTable("assets").addColumn("linked_path", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("folders").dropColumn("path").execute();
    await db.schema.alterTable("assets").dropColumn("linked_path").execute();
  },
};
export default migration;
