import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("projects")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("folder_id", "text")
      .addColumn("archived_at", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.alterTable("folders").addColumn("project_id", "text").execute();
    await db.schema.alterTable("drafts").addColumn("project_id", "text").execute();
    await db.schema.alterTable("timelines").addColumn("project_id", "text").execute();
    await db.schema.alterTable("timelines").addColumn("folder_id", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("folder_id").execute();
    await db.schema.alterTable("timelines").dropColumn("project_id").execute();
    await db.schema.alterTable("drafts").dropColumn("project_id").execute();
    await db.schema.alterTable("folders").dropColumn("project_id").execute();
    await db.schema.dropTable("projects").execute();
  },
};
export default migration;
