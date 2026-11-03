import type { Migration } from "kysely/migration";

/**
 * What an MCP token's jobs taken off the Queue still count for its limits (mcpTokens.ts): its renders an hour and its
 * spend this month were read from `jobs`, which Dismiss deletes, so a token (the MCP dismiss tool) or the user tidying the
 * Queue took them out of both, and neither limit held (card #268). Dismiss copies a token's rows here in the same go as it
 * deletes them, with what the counts read of a job: when it was sent, the machine, its start and end, a model load or not.
 * Kept as long as tidy.ts keeps a token's jobs (32 days), then let go.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("mcp_token_jobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("mcp_token_id", "text", (c) => c.notNull())
      .addColumn("machine_id", "text")
      .addColumn("warm", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("started_at", "text")
      .addColumn("finished_at", "text")
      .execute();
    await db.schema.createIndex("mcp_token_jobs_token").on("mcp_token_jobs").columns(["mcp_token_id", "created_at"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("mcp_token_jobs").execute();
  },
};
export default migration;
