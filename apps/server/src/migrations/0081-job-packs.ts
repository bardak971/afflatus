import type { Migration } from "kysely/migration";

/**
 * What a job was told to do about the node packs it asks for that its machine lacks (jobPacks.ts): `packs`, JSON
 * `{ install?: string[]; without?: string[] }`, the packs the user had installed for it from its Queue row (Install and
 * restart) and those it runs without (Run without). Null: nothing said, the machine's own rule (Ask / Always) holds.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("packs", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("packs").execute();
  },
};
export default migration;
