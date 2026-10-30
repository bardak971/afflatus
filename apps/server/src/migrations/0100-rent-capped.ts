import type { Migration } from "kysely/migration";

/**
 * When a running pod's run reached a spending cap (the app's or its MCP token's), kept on its open rent session
 * (rentedFollow.ts capSince): Afflatus kept it in memory only, so a restart gave a render running at a cap a fresh grace
 * hour, billed. Null while no cap is reached, and on the sessions before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("capped_at", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("capped_at").execute();
  },
};
export default migration;
