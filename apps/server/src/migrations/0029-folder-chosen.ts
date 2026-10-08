import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("folder_chosen", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("folder_chosen").execute();
  },
};
export default migration;
