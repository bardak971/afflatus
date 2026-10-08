import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("draft_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("folder_id", "text").execute();
    await db.schema.alterTable("generations").addColumn("draft_id", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("draft_id").execute();
    await db.schema.alterTable("jobs").dropColumn("folder_id").execute();
    await db.schema.alterTable("generations").dropColumn("draft_id").execute();
  },
};
export default migration;
