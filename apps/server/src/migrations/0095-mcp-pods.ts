import type { Migration } from "kysely/migration";

/**
 * A pod's run started by an MCP token (0.8.0, mcpMachines.ts): the token whose deploy_pod or start_pod started it, by id
 * (null: the user's own click, the GPU hunt, or a run from before). Its whole run is that token's spend (mcpTokens.ts
 * spentThisMonth), idle and boot included, not only the renders it sent there: the token's cap holds over the pod it
 * started, and the pod is stopped once that cap is reached (rentedFollow.ts).
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("rent_sessions").addColumn("mcp_token_id", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("rent_sessions").dropColumn("mcp_token_id").execute();
  },
};
export default migration;
