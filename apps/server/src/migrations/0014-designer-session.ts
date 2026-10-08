import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("drafts").addColumn("designer", "text").execute();
    await db.schema.alterTable("clips").addColumn("designer", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("drafts").dropColumn("designer").execute();
    await db.schema.alterTable("clips").dropColumn("designer").execute();
  },
};
export default migration;
