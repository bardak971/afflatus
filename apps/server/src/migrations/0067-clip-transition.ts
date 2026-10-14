import type { Migration } from "kysely/migration";

/**
 * A cut's transition (a dissolve, a dip to black, a flash…): on the clip after the cut, as it keeps how it meets the clip
 * before. JSON (@afflatus/core's Transition: kind, length, sound); null = a plain cut.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("clips").addColumn("transition", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("clips").dropColumn("transition").execute();
  },
};
export default migration;
