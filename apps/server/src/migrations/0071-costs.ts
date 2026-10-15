import type { Migration } from "kysely/migration";
import { onPostgres } from "./dialect";

/**
 * What the Queue's Costs tab splits a pod's time with (costs.ts), kept from now on rather than guessed:
 *  - on each rent session, its GPU's name, when its ComfyUI first answered (the end of its boot) and the idle minutes it ran
 *    with (what a shorter idle would have saved is worked out against them);
 *  - `pod_fetches`: each model file a pod got, from when its bytes started to when it was whole, with its name (the same file
 *    fetched on several deploys is what a network volume would have kept). pod_measures keeps only speeds, without the pod;
 *  - on each render of this PC's, the energy its GPU drew while it rendered and its mean power (the node pack's power reading),
 *    for its electricity; null where nothing reported the power.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("gpu", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("up_at", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("idle_minutes", "integer").execute();
    await db.schema
      .createTable("pod_fetches")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("machine_id", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("folder", "text", (c) => c.notNull())
      // hf, civitai, url, upload
      .addColumn("via", "text", (c) => c.notNull())
      // a model file is often over 2^31 bytes: bigint on Postgres (SQLite's integer is 64 bits already)
      .addColumn("bytes", onPostgres(db) ? "bigint" : "integer", (c) => c.notNull())
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("ended_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("pod_fetches_ended").on("pod_fetches").columns(["ended_at"]).execute();
    await db.schema.alterTable("render_stats").addColumn("energy_wh", "real").execute();
    await db.schema.alterTable("render_stats").addColumn("power_avg_w", "real").execute();
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("power_avg_w").execute();
    await db.schema.alterTable("render_stats").dropColumn("energy_wh").execute();
    await db.schema.dropTable("pod_fetches").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("idle_minutes").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("up_at").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("gpu").execute();
  },
};
export default migration;
