import type { Migration } from "kysely/migration";

/**
 * The clips of a timeline's voice recordings set aside by a trim (Timelines.trimRecording): JSON, by recording asset, each
 * clip whole with its takes, in order, to come back as they were when the recording is made longer again. null = none.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("recordings", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("recordings").execute();
  },
};
export default migration;
