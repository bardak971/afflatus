import type { Migration } from "kysely/migration";

/**
 * A Prompt-kit person's picture with its background taken out (kitCutouts.ts): the job that makes it names the person and
 * the picture (JSON), so that what it makes is filed with them, out of the library, rather than as a render.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("kit_for", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("kit_for").execute();
  },
};
export default migration;
