import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // the form as it was sent, before the cast was worked into it (JSON): what a tool carries on with, the cast given again beside it
    await db.schema.alterTable("jobs").addColumn("asked", "text").execute();
    await db.schema.alterTable("generations").addColumn("asked", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("generations").dropColumn("asked").execute();
    await db.schema.alterTable("jobs").dropColumn("asked").execute();
  },
};
export default migration;
