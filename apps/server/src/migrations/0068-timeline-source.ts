import type { Migration } from "kysely/migration";

/**
 * A timeline's source lane: a long video (a driving video) laid under the clips, made into clips window by window
 * (timelineSource.ts). JSON: the video, where its start sits on the timeline, the stretch to make, and the form the windows
 * are made with (model, window length, picture, prompt). null = no source.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("timelines").addColumn("source", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("timelines").dropColumn("source").execute();
  },
};
export default migration;
