import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("takes").addColumn("finished_from", "text").execute();
    await db.schema.alterTable("jobs").addColumn("finished_from", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("takes").dropColumn("finished_from").execute();
    await db.schema.alterTable("jobs").dropColumn("finished_from").execute();
  },
};
export default migration;
