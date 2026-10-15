import type { Migration } from "kysely/migration";

/**
 * What a library item keeps on the disk beside its file, in bytes: an H3 clip's latent and its finished latent, and the
 * model's own frames of a video changed after. They were in no size (an H3 clip of 4 MB took 15 to 20, 1.6 GB of 2.9 GB
 * uncounted on 2026-10-15). Filled in for the items made before at start (fillKeptBytes): a migration reads no files.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("kept_bytes", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("kept_bytes").execute();
  },
};
export default migration;
