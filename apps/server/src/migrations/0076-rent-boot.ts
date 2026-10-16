import type { Migration } from "kysely/migration";

/**
 * A pod session's boot in its parts, kept as rented.ts sees them while it boots (so that a restart of Afflatus mid-boot keeps
 * them): when its container came up (its image pulled: RunPod's uptime first seen), when its boot log's node packs step began
 * and the step after it, the Python packages installed per pack (JSON: [{ pack, ms }]), and the step its start failed at.
 * The Costs tab splits its boot by them. Null on the sessions before, and where nothing said it (plain "boot" there).
 */
const COLUMNS = ["pulled_at", "packs_from", "packs_to", "boot_packs", "start_failed"] as const;

const migration: Migration = {
  async up(db) {
    for (const c of COLUMNS) await db.schema.alterTable("rent_sessions").addColumn(c, "text").execute();
  },
  async down(db) {
    for (const c of COLUMNS) await db.schema.alterTable("rent_sessions").dropColumn(c).execute();
  },
};
export default migration;
