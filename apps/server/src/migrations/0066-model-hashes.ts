import type { Migration } from "kysely/migration";

/**
 * Every model file of this computer's ComfyUI hashed once (modelHashes.ts): its SHA-256, kept with the size and the time
 * of the file it was read from (a file changed is hashed again), and what the sites said of it: the Civitai version it
 * is (null: not asked yet; 0: Civitai has none), or the Hugging Face file it is, its SHA-256 the same (hf_url).
 * Sizes and times in bigint: a model is often over 2^31 bytes, which a Postgres integer cannot hold.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_hashes")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("mtime", "bigint", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("hashed_at", "text", (c) => c.notNull())
      .addColumn("civitai_version", "bigint")
      .addColumn("hf_url", "text")
      .addColumn("matched_at", "text")
      .addPrimaryKeyConstraint("model_hashes_pk", ["folder", "file"])
      .execute();
    await db.schema.createIndex("model_hashes_sha256").on("model_hashes").column("sha256").execute();
  },
  async down(db) {
    await db.schema.dropTable("model_hashes").execute();
  },
};
export default migration;
