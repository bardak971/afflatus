import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("entities")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("def", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("entities_by_kind").on("entities").columns(["owner_id", "kind"]).execute();
    for (const table of ["timelines", "clips", "drafts"] as const) await db.schema.alterTable(table).addColumn("look", "text").execute();
  },
  async down(db) {
    for (const table of ["timelines", "clips", "drafts"] as const) await db.schema.alterTable(table).dropColumn("look").execute();
    await db.schema.dropTable("entities").execute();
  },
};
export default migration;
