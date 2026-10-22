import type { Migration } from "kysely/migration";

/**
 * When a render's job took its machine (render_stats.started_at, ISO): Costs placed a render at [its row's moment − its
 * length], its row written after its result was filed, so what Afflatus did on a pod before the prompt went (the uploads) and
 * after it ended (the filing) read as Idle, and the render was shifted by its filing. Null on the rows from before, which
 * keep being placed as they were.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("render_stats").addColumn("started_at", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("started_at").execute();
  },
};
export default migration;
