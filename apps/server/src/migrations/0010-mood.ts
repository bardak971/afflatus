import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("mood", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("mood").execute();
  },
};
export default migration;
