import type { Migration } from "kysely/migration";

/**
 * The network volume a pod session ran on, by id (null: none, or a session from before). A pod keeps its volume for its
 * whole life, so its machine's renders are the volume's: the volume viewer says when a render last used each file there
 * from them (volumeFiles.ts), and a pod terminated since still counts.
 *
 * And a volume's model files as last listed with their sizes (JSON, volumeFiles.ts KeptFile; null: never listed so, or
 * listed by name only): its Files show them when neither its pod nor the S3 API can read it now, and its tile says their size.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("volume", "text").execute();
    await db.schema.alterTable("volume_files").addColumn("listing", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("volume_files").dropColumn("listing").execute();
    await db.schema.alterTable("rent_sessions").dropColumn("volume").execute();
  },
};
export default migration;
