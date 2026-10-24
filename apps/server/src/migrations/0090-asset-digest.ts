import type { Migration } from "kysely/migration";

/**
 * What a library item holds, as a digest (sameContent.ts): a picture's pixels, a video's or a sound's bytes. A file pasted
 * into Afflatus that the library already holds (a picture copied with Copy the picture and pasted back) is found by it and
 * used, not added twice. Null until it is first needed: worked out on upload, and for an older item when a file of its
 * size comes in, as a migration reads no files.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("digest", "text").execute();
    await db.schema.createIndex("assets_digest").on("assets").column("digest").execute();
  },
  async down(db) {
    await db.schema.dropIndex("assets_digest").execute();
    await db.schema.alterTable("assets").dropColumn("digest").execute();
  },
};
export default migration;
