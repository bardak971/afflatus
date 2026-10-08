import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("takes").addColumn("join_kind", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("takes").dropColumn("join_kind").execute();
  },
};
export default migration;
