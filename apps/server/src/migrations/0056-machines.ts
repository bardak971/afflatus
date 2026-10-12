import type { Migration } from "kysely/migration";

/**
 * Several ComfyUIs (settings.ts `machines`). On a job: the machine it runs or ran on (set when a machine claims it; null for
 * a job that needs no ComfyUI, and for jobs from before), and the one it was pinned to by hand (null: whichever the queue
 * picks). On a render's record: the machine and the GPU it ran on, so that each machine's speed is learned on its own.
 * Rows from before were made on the one ComfyUI there was, which is the first machine ("m1").
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("machine_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("pin_machine", "text").execute();
    await db.schema.alterTable("render_stats").addColumn("machine_id", "text").execute();
    await db.schema.alterTable("render_stats").addColumn("gpu", "text").execute();
    await db.updateTable("render_stats").set({ machine_id: "m1" }).execute();
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("gpu").execute();
    await db.schema.alterTable("render_stats").dropColumn("machine_id").execute();
    await db.schema.alterTable("jobs").dropColumn("pin_machine").execute();
    await db.schema.alterTable("jobs").dropColumn("machine_id").execute();
  },
};
export default migration;
