import type { Migration } from "kysely/migration";

/**
 * What the node pack read of the face in each of a Prompt kit person's pictures (faceFacts.ts, card #220): by the
 * picture's id, the version of the route that read it, and its answer as JSON (the largest face's box, points, score,
 * sharpness and ArcFace embedding, or none found). A model that takes one picture of a person is sent the clearest face.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("face_facts")
      .addColumn("asset_id", "text", (c) => c.primaryKey())
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("facts", "text", (c) => c.notNull())
      .addColumn("read_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("face_facts").execute();
  },
};
export default migration;
