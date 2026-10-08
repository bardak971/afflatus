import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a job that only loads the models of a render, and makes nothing
    await db.schema.alterTable("jobs").addColumn("warm", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("warm").execute();
  },
};
export default migration;
