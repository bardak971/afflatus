import type { Migration } from "kysely/migration";

/**
 * Versions of a picture (card #274): a fix painted on the Stage, a face or hand refine, an edit come back under the picture
 * they were made from instead of as new items of the library, until one of them is kept (versions.ts). `assets.version_of`
 * names the stack's head, always its root (a version of a version joins the same stack); a head erased lets its versions go
 * as plain items (`set null`). `jobs.version_of` is the head a render was sent for, followed up to the root when it is filed.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("version_of", "text", (c) => c.references("assets.id").onDelete("set null")).execute();
    await db.schema.createIndex("assets_versions").on("assets").columns(["version_of", "created_at"]).execute();
    await db.schema.alterTable("jobs").addColumn("version_of", "text").execute();
  },
  async down(db) {
    await db.schema.dropIndex("assets_versions").execute();
    await db.schema.alterTable("assets").dropColumn("version_of").execute();
    await db.schema.alterTable("jobs").dropColumn("version_of").execute();
  },
};
export default migration;
