import type { Migration } from "kysely/migration";

/**
 * When a running pod last had work, kept on its open rent session (rented.ts keepBusy): Afflatus kept it in memory only, so
 * every restart (an update, a live restart) gave an idle pod a new idle time, billed. Read back at the next start
 * (busySince). Null on the sessions before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("busy_at", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("busy_at").execute();
  },
};
export default migration;
