import type { Migration } from "kysely/migration";

/**
 * The stretches a rented pod's ComfyUI ran work from outside Afflatus (its own page, another tool), by session (podOutside.ts):
 * from the read that first found such a prompt running to the read that found none, `seen_at` the last read that found one
 * (what an interval left open by a restart of Afflatus is closed at). The Costs tab counts that time as the pod used, not
 * idle; it was all idle before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("pod_outside")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("machine_id", "text", (c) => c.notNull())
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("seen_at", "text", (c) => c.notNull())
      .addColumn("ended_at", "text")
      .execute();
    await db.schema.createIndex("pod_outside_session").on("pod_outside").columns(["session_id"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("pod_outside").execute();
  },
};
export default migration;
