import type { Migration } from "kysely/migration";

/**
 * A pinned frame mirrored at render time: on the clip, which of its pinned pictures are flipped left to right (JSON, input id →
 * true; null when none is), the library's picture left as it is. On the job, the flips it was sent with (JSON, a list of input
 * ids): a flip changed while the job waits does not change what it renders, and a finish repeats its draft's.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("clips").addColumn("pin_mirror", "text").execute();
    await db.schema.alterTable("jobs").addColumn("clip_mirror", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("clip_mirror").execute();
    await db.schema.alterTable("clips").dropColumn("pin_mirror").execute();
  },
};
export default migration;
