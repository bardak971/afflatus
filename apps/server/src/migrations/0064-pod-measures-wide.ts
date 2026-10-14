import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { onPostgres } from "./dialect";

/**
 * A pod's file measured is often over 2^31 bytes (a model of several GB), which a Postgres integer cannot hold: bigint
 * there (as 0039 did for the files' sizes), or its speed was never kept. SQLite's integer is 64 bits already.
 */
const migration: Migration = {
  async up(db) {
    if (!onPostgres(db)) return;
    await sql`alter table pod_measures alter column bytes type bigint`.execute(db);
    await sql`alter table pod_measures alter column ms type bigint`.execute(db);
  },
  async down(db) {
    if (!onPostgres(db)) return;
    await sql`alter table pod_measures alter column ms type integer`.execute(db);
    await sql`alter table pod_measures alter column bytes type integer`.execute(db);
  },
};
export default migration;
