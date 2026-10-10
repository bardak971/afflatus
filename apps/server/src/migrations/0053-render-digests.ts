import type { Migration } from "kysely/migration";

/**
 * Each day over whose renders are still rows, digested once (see Digest in renders.ts): the "Render times" summaries
 * cut into days ("month", "all") read these instead of working every row kept out again on each call. The table starts
 * empty: the days already on record are digested by the fold that runs at start (renders.ts, `fold`), as a migration
 * stays frozen and does not call the app's code. Until then a summary works those days out from their rows, as before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("render_digests")
      .addColumn("day", "text", (c) => c.primaryKey())
      .addColumn("digest", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("render_digests").execute();
  },
};
export default migration;
