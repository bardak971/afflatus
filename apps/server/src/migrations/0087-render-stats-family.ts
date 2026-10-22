import type { Migration } from "kysely/migration";

/**
 * The lookups of a model's family in the record of render times (forecast.ts familyRows, familyWarmLoads, coldLoadsElsewhere):
 * a forecast for a model with too few renders of its own reads its family's, once per waiting job and machine. Without an
 * index they were answered through render_stats_by_model, a whole pass over the record sorted by time at each call: 190
 * calls took 2 s of a queue pass on two years of renders (the 2026-10-22 review, H-1).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.createIndex("render_stats_by_family").on("render_stats").columns(["family", "status", "created_at"]).execute();
  },
  async down(db) {
    await db.schema.dropIndex("render_stats_by_family").execute();
  },
};
export default migration;
