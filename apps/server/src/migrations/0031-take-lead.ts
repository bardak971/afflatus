import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("takes").addColumn("lead_ms", "integer", (c) => c.notNull().defaultTo(0)).execute();
    // the joins made in the latent so far hand over four frames early too (167 ms at 24 a second), when their shared part has room
    await db.updateTable("takes").set({ lead_ms: 167 }).where("join_kind", "in", ["latent", "hybrid"]).where("head_ms", ">=", 334).execute();
  },
  async down(db) {
    await db.schema.alterTable("takes").dropColumn("lead_ms").execute();
  },
};
export default migration;
