import type { Migration } from "kysely/migration";

/**
 * Whether a token's client follows MCP Tasks (0.8.2, card #154): read from the capabilities its last tools/call declared
 * (mcp.ts tasksOf), 1 or 0, null before any call. Settings › Access says it on the token's row: a client that does not
 * follow them holds its session through a long render (Claude Code run through the Agent SDK needs a setting for it).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("mcp_tokens").addColumn("last_tasks", "integer").execute();
  },
  async down(db) {
    await db.schema.alterTable("mcp_tokens").dropColumn("last_tasks").execute();
  },
};
export default migration;
