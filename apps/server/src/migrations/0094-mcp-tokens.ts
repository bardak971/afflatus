import type { Migration } from "kysely/migration";

/**
 * Afflatus from outside (0.8.0): the personal tokens an MCP client drives Afflatus with (mcpTokens.ts), what each of their
 * calls did, and which token sent a job.
 *
 * A token's id is a random id of its own; `hash` the SHA-256 of the token itself, never the token: a copy of the database
 * lets no client in. `scopes`: the scopes ticked, comma-separated ("look,make,spend"). `renders_per_hour` and
 * `spend_cap_cents` its own limits, on top of the app's caps (the cap in cents, never a float). `expires_at` null: it never
 * ends; `revoked_at` set: it is refused from then on and kept for its activity. `tail`: its last four characters, which the
 * list shows so that a token pasted somewhere can be told from another. The last use: when, from where, and the client
 * name the MCP initialize gave.
 *
 * `mcp_activity`: each call, its tool, what it touched in plain words, refused or not and why; kept 30 days.
 * `jobs.mcp_token_id`: the token whose call queued the job (null: the page, or before this), for its limits, Costs and the
 * status bar.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("mcp_tokens")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("hash", "text", (c) => c.notNull().unique())
      .addColumn("tail", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("scopes", "text", (c) => c.notNull())
      .addColumn("renders_per_hour", "integer", (c) => c.notNull())
      .addColumn("spend_cap_cents", "integer", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text")
      .addColumn("revoked_at", "text")
      .addColumn("last_used_at", "text")
      .addColumn("last_ip", "text")
      .addColumn("last_client", "text")
      .execute();
    await db.schema
      .createTable("mcp_activity")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_id", "text", (c) => c.notNull())
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("tool", "text", (c) => c.notNull())
      .addColumn("said", "text", (c) => c.notNull())
      .addColumn("refused", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("why", "text")
      .execute();
    await db.schema.createIndex("mcp_activity_token_at").on("mcp_activity").columns(["token_id", "at"]).execute();
    await db.schema.createIndex("mcp_activity_at").on("mcp_activity").column("at").execute();
    await db.schema.alterTable("jobs").addColumn("mcp_token_id", "text").execute();
    await db.schema.createIndex("jobs_mcp_token").on("jobs").columns(["mcp_token_id", "created_at"]).execute();
  },
  async down(db) {
    await db.schema.dropIndex("jobs_mcp_token").execute();
    await db.schema.alterTable("jobs").dropColumn("mcp_token_id").execute();
    await db.schema.dropTable("mcp_activity").execute();
    await db.schema.dropTable("mcp_tokens").execute();
  },
};
export default migration;
