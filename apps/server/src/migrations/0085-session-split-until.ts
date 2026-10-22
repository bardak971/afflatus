import type { Migration } from "kysely/migration";

/**
 * A running session's split kept up to a moment (rent_sessions.split_until, ISO; costs.ts keepSplitsUntil): its render rows
 * are deleted before it has ended a day (Settings › Renders' history days pass its start, or every render time is
 * forgotten while its pod runs), and freezing only ended sessions read those renders as idle once it was split at its end.
 * Its split up to that moment is kept, and finished from what is left after it at its end. Null: the split kept is the
 * whole one (0084), or none is kept.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("split_until", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("split_until").execute();
  },
};
export default migration;
