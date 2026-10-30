import type { Migration } from "kysely/migration";

/**
 * The hashes of the model files ComfyUI does not load by their name (modelHashes.ts): a name held by two of a folder's
 * directories is the first one's for ComfyUI (models/loras before A1111's Lora that extra_model_paths.yaml adds), and
 * model_hashes keeps that one's under the name. The other file, other bytes often, kept its hash under the same name
 * too: one file's hash was taken for the other's, and Delete moved the first one when the second was asked (card #185).
 * Each such file's hash here, by its path; size and time as model_hashes' (bigint).
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_hash_places")
      .addColumn("path", "text", (c) => c.primaryKey())
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("mtime", "bigint", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("hashed_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_hash_places").execute();
  },
};
export default migration;
