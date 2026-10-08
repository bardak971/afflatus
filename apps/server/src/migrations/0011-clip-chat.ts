import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("clips").addColumn("chat", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("clips").dropColumn("chat").execute();
  },
};
export default migration;
