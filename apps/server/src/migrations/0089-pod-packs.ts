import type { Migration } from "kysely/migration";

/**
 * When a rented pod installed node packs for its jobs after its boot, and restarted its ComfyUI to load them (podPacks.ts):
 * from the first install asked to ComfyUI answering again, by session. Billed, and no job could start there meanwhile, but
 * Costs read it as Idle, and its advice as a pod left waiting too long.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("pod_packs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("machine_id", "text", (c) => c.notNull())
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("ended_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("pod_packs_ended").on("pod_packs").column("ended_at").execute();
  },
  async down(db) {
    await db.schema.dropTable("pod_packs").execute();
  },
};
export default migration;
