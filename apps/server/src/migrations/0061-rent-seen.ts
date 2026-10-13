import type { Migration } from "kysely/migration";

/**
 * When a rented pod was last seen running (rented.ts), on its open session: a run found ended after Afflatus was away (off,
 * asleep) is closed at that moment rather than at the moment Afflatus came back, which would count hours that were not billed.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("seen_at", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("seen_at").execute();
  },
};
export default migration;
