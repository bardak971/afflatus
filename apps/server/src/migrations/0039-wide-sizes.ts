import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { onPostgres } from "./dialect";

/**
 * A file's size and a render's sampled work pass 2^31 (an export over 2 GiB; pixels times frames of a long
 * clip), which a Postgres integer cannot hold: bigint there. SQLite's integer is 64 bits already, so
 * nothing changes on SQLite.
 */
const migration: Migration = {
  async up(db) {
    if (!onPostgres(db)) return;
    await sql`alter table assets alter column bytes type bigint`.execute(db);
    await sql`alter table render_stats alter column work type bigint`.execute(db);
  },
  async down(db) {
    if (!onPostgres(db)) return;
    await sql`alter table render_stats alter column work type integer`.execute(db);
    await sql`alter table assets alter column bytes type integer`.execute(db);
  },
};
export default migration;
