import type { Migration } from "kysely/migration";

/**
 * The record of render times by machine (the 2026-10-15 performance review). One machine's summary read every row it
 * had kept, each call: its rows are now found by an index on the machine and the time (with the GPU time, so that each
 * machine's share of a window is read from the index alone), and each day over is digested for each machine as it is for
 * every machine together (`render_machine_digests`, the same digest of that machine's rows of the day; renderDigests.ts).
 * The table starts empty: the days on record are digested by the fold that runs at start.
 * And a render's milliseconds per node class (`node_ms`, JSON; null when they were not heard), from ComfyUI's
 * "executing" messages: what was taken for loading the model is told apart from a preprocessing node's own time.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.createIndex("render_stats_by_machine").on("render_stats").columns(["machine_id", "created_at", "total_ms"]).execute();
    await db.schema
      .createTable("render_machine_digests")
      .addColumn("day", "text", (c) => c.notNull())
      .addColumn("machine_id", "text", (c) => c.notNull())
      .addColumn("digest", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("render_machine_digests_pk", ["day", "machine_id"])
      .execute();
    await db.schema.alterTable("render_stats").addColumn("node_ms", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("node_ms").execute();
    await db.schema.dropTable("render_machine_digests").execute();
    await db.schema.dropIndex("render_stats_by_machine").execute();
  },
};
export default migration;
