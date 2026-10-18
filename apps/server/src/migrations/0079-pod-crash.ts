import type { Migration } from "kysely/migration";

/**
 * Why a pod's run ended (rent_sessions.end_why: "idle", "cap", "you", "crash"…; null: still running, or a run from before),
 * kept past a restart of Afflatus, and when its ComfyUI died there, the pod's report of it (rent_sessions.crash, JSON: what
 * deploy/runpod/died.py measured, and the line said): Queue › Costs says it on the run's row.
 *
 * And the most RAM a render used, with the RAM there was (render_stats.ram_peak / ram_total, GB, as ComfyUI counts them: a
 * pod's container limit, not its host's), next to vram_peak: where a render dies of memory is learned from them.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("end_why", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("crash", "text").execute();
    await db.schema.alterTable("render_stats").addColumn("ram_peak", "real").execute();
    await db.schema.alterTable("render_stats").addColumn("ram_total", "real").execute();
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("ram_total").execute();
    await db.schema.alterTable("render_stats").dropColumn("ram_peak").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("crash").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("end_why").execute();
  },
};
export default migration;
