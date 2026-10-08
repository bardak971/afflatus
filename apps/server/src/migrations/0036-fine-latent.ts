import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("fine_latent_key", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("fine_latent_key").execute();
  },
};
export default migration;
