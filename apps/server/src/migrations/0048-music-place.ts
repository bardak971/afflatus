import type { Migration } from "kysely/migration";

// which part of the song plays and from which clip on (timelines), and what each clip asks of the music under it (JSON)
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("music_from_ms", "integer", (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable("timelines").addColumn("music_start_clip_id", "text").execute();
    await db.schema.alterTable("clips").addColumn("music", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("clips").dropColumn("music").execute();
    await db.schema.alterTable("timelines").dropColumn("music_start_clip_id").execute();
    await db.schema.alterTable("timelines").dropColumn("music_from_ms").execute();
  },
};
export default migration;
