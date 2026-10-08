import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("latent_key", "text").execute();
    await db.schema.alterTable("assets").addColumn("latent_frames", "integer").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("latent_key").execute();
    await db.schema.alterTable("assets").dropColumn("latent_frames").execute();
  },
};
export default migration;
