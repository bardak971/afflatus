import type { Migration } from "kysely/migration";

/**
 * A rented session's split kept once it has ended (rent_sessions.split, JSON: { spans, estimated }, costs.ts freezeSplits):
 * the render rows it is worked out from are folded into days after Settings › Renders' history days, or forgotten at once,
 * and a split worked out again from what is left then read the session's renders as idle. Kept, an ended session's time by
 * part never moves (the Costs tab, the Grafana gauges, the hunt's overhead). Null: still running, or not kept yet.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("split", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("split").execute();
  },
};
export default migration;
