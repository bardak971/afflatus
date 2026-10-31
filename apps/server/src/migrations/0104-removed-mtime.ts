import type { Migration } from "kysely/migration";

/**
 * The date on disk (ms) of a file Settings › Model files' Delete moved, kept with the hash it had (modelLibrary.ts): Put
 * back gives the file its hash again only when its size and date are still those, and a hash is recorded only when its row
 * was of these very bytes. Null for a row from before: its hash is not trusted (the file is hashed again once back).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("model_removed").addColumn("mtime", "integer").execute();
  },
  async down(db) {
    await db.schema.alterTable("model_removed").dropColumn("mtime").execute();
  },
};
export default migration;
