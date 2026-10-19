import type { Migration } from "kysely/migration";

/**
 * What a pod's run ran on, kept with it past the pod's end (its machine removed, the pod terminated): the image it was
 * deployed with (rent_sessions.image: its "-cu128" says the CUDA 12.8 build), the CUDA its host's driver offered
 * (host_cuda, as RunPod said it: "13.2") and its data center (data_center). Its image's pull as RunPod's system log told it
 * (pull, JSON: { fresh, bytes, downloadMs, extractMs, mbps }, podPull.ts), and, only while Settings › Rented GPUs keeps
 * boot logs, its boot's lines (boot_log, JSON: { system, pod }), dropped after the days said there. Null on runs from before.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("image", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("host_cuda", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("data_center", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("pull", "text").execute();
    await db.schema.alterTable("rent_sessions").addColumn("boot_log", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("boot_log").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("pull").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("data_center").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("host_cuda").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("image").execute();
  },
};
export default migration;
