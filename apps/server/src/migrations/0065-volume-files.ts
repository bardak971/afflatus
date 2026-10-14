import type { Migration } from "kysely/migration";

/**
 * What each network volume holds, as the last pod on it listed its model folders (rentedVolumes.ts): Afflatus cannot read
 * a volume without a pod on it, so what it holds is kept from the last time one ran there, with when that was. `files` is
 * JSON: the files' keys ("folder|name"); null until a pod on it was listed. `noticed_at`: when Afflatus first saw the
 * volume, from which one never used is counted unused. `fill_note`: how its last Fill from a set… ended (JSON: when, the
 * files that failed and why).
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("volume_files")
      .addColumn("volume_id", "text", (c) => c.primaryKey())
      .addColumn("files", "text")
      .addColumn("seen_at", "text")
      .addColumn("seen_by", "text")
      .addColumn("used_at", "text")
      .addColumn("noticed_at", "text", (c) => c.notNull())
      .addColumn("fill_note", "text")
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("volume_files").execute();
  },
};
export default migration;
