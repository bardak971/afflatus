import type { Migration } from "kysely/migration";

// how far the music goes down under speech, in dB (duck.ts)
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("music_duck_db", "integer", (c) => c.notNull().defaultTo(10)).execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("music_duck_db").execute();
  },
};
export default migration;
