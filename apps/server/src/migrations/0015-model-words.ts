import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_words")
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("own", "text")
      .addColumn("found", "text")
      .addColumn("asked_at", "text")
      .addPrimaryKeyConstraint("model_words_pk", ["folder", "name"])
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_words").execute();
  },
};
export default migration;
