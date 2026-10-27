import type { Migration } from "kysely/migration";

/**
 * A workflow an agent imported (0.8.0, mcpWorkflows.ts import_workflow) waits for the user's approval before it renders:
 * its nodes run code on the user's machines, and some read or write files or fetch addresses. `pending_token`: the MCP
 * token that imported it, by id (null: the user's own import, or one approved); `pending_name`: that token's name then,
 * which the card says ("from Claude Code") even once the token is revoked and purged.
 */
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("workflows").addColumn("pending_token", "text").execute();
    await db.schema.alterTable("workflows").addColumn("pending_name", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("workflows").dropColumn("pending_name").execute();
    await db.schema.alterTable("workflows").dropColumn("pending_token").execute();
  },
};
export default migration;
