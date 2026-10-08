import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // what a frame or a sound was taken out of: its story is that one's
    await db.schema.alterTable("assets").addColumn("source_id", "text").execute();
    // who was in it and how it looked, as the job was sent: kept with what it makes
    await db.schema.alterTable("jobs").addColumn("look", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("source_id").execute();
    await db.schema.alterTable("jobs").dropColumn("look").execute();
  },
};
export default migration;
