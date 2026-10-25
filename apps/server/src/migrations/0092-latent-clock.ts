import type { Migration } from "kysely/migration";

/**
 * How a kept latent counts its frames (core LatentClock, as JSON): the family whose model made it, its rate, its frame grid
 * and its size. Null for every latent kept before: MiniMax H3's, the one model whose latent was kept until LTX's (card #40).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("assets").addColumn("latent_clock", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("latent_clock").execute();
  },
};
export default migration;
