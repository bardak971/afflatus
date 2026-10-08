import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // a result nobody kept counts its day from here when it is set (unkept again, or back from the bin), else from its making
    await db.schema.alterTable("assets").addColumn("countdown_from", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("assets").dropColumn("countdown_from").execute();
  },
};
export default migration;
