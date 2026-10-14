import type { Migration } from "kysely/migration";

/**
 * Model sets (modelSets.ts): named lists of model files, for a rented pod (Deploy a GPU), a new computer or a friend. A
 * set holds presets by reference (their files follow them) and files of its own, as JSON in `def`.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_sets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("def", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_sets").execute();
  },
};
export default migration;
