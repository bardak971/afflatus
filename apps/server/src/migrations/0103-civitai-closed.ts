import type { Migration } from "kysely/migration";

/**
 * When Civitai refused the download of the version a hashed file was matched to (model_hashes.civitai_version) for another
 * reason than the key: its creator disabled downloads, a paid version (card #206). Null while it was never refused. A pod is
 * then sent the file from another copy of the same bytes, or from this computer, without asking Civitai again at each deploy.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("model_hashes").addColumn("civitai_closed_at", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("model_hashes").dropColumn("civitai_closed_at").execute();
  },
};
export default migration;
