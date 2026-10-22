import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The jobs still to run (queued or running), indexed on their own: what the sweep, a draft's tidying, the notice at the end
 * of a batch and ComfyUI's own queue (queueOutside.ownPrompts) ask for many times a minute. jobs_by_status holds them too,
 * but with only sqlite_stat1's average (a third of the rows per status) the planner read the whole table instead: 3 to 4 ms
 * a call on 2,000 jobs, 57 to 85 ms on a year of them (the 2026-10-22 review). This index holds only the few jobs still to
 * run, whatever the table's size. SQLite uses a partial index only for a query whose own words imply its WHERE, so the
 * queries write the statuses as literals, in this order (db.ts, toRun): bound as parameters, they still read the table.
 */
const migration: Migration = {
  async up(db) {
    await sql`create index jobs_to_run on jobs (status) where status in ('queued', 'running')`.execute(db);
  },
  async down(db) {
    await db.schema.dropIndex("jobs_to_run").execute();
  },
};
export default migration;
