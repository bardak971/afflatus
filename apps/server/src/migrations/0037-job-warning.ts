import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // what went less well than asked in a job that still finished (a take not placed, a latent join made on frames): said on the job, not only in the log
    await db.schema.alterTable("jobs").addColumn("warning", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("warning").execute();
  },
};
export default migration;
