import type { Migration } from "kysely/migration";

/**
 * What each network volume holds, as the last pod on it listed its model folders (rentedVolumes.ts): Afflatus cannot read
 * a volume without a pod on it, so what it holds is kept from the last time one ran there, with when that was. `files` is
 * JSON: the files' keys ("folder|name").
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("volume_files")
      .addColumn("volume_id", "text", (c) => c.primaryKey())
      .addColumn("files", "text", (c) => c.notNull())
      .addColumn("seen_at", "text", (c) => c.notNull())
      .addColumn("seen_by", "text", (c) => c.notNull())
      .addColumn("used_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("volume_files").execute();
  },
};
export default migration;
