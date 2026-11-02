import type { Migration } from "kysely/migration";

/**
 * When each machine took its jobs, for an MCP token's spend this month (mcpTokens.ts spentThisMonthOf): the next job a
 * rented pod took after a token's work ends the idle time that work left it. Read by machine from the month's start, it
 * was a scan of every job (1,465 rows of the owner's PC since the 1st, 8 ms), at each Settings › Agents poll, each pod
 * poll and each MCP render (card #243).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.createIndex("jobs_by_machine_start").on("jobs").columns(["machine_id", "started_at"]).execute();
  },
  async down(db) {
    await db.schema.dropIndex("jobs_by_machine_start").execute();
  },
};
export default migration;
