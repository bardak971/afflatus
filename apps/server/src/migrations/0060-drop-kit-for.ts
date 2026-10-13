import type { Migration } from "kysely/migration";

/** jobs.kit_for (0057) named the person and the picture of a Prompt-kit cut-out; the cut-outs were removed (0058): it goes. */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").dropColumn("kit_for").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").addColumn("kit_for", "text").execute();
  },
};
export default migration;
