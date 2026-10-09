import type { Migration } from "kysely/migration";

// whether a clip ends where the next one begins (rendered to land on it): kept on the clip, on unless turned off
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("clips").addColumn("fit_next", "integer", (c) => c.notNull().defaultTo(1)).execute();
  },
  async down(db) {
    await db.schema.alterTable("clips").dropColumn("fit_next").execute();
  },
};
export default migration;
