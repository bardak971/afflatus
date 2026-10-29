import type { Migration } from "kysely/migration";

/**
 * MCP Tasks (0.8.2, mcpTasks.ts): a long call (render, render_clips, finish, export, a slow motion, run_workflow, deploy_pod)
 * answered to a client that takes tasks with a task it follows. The task is the call's own answer (`answer`, the JSON the
 * call would have answered) and what it waits for (`follow`: its jobs, or a pod); whether it is done is read from the jobs
 * and the pod each time it is asked, so a restart of Afflatus loses nothing. `status`: working, or how it ended once it was
 * seen ending (completed, cancelled), with the result sent then (`result`), which never changes after. A task is its
 * token's alone; it is forgotten a day after it was made (`expires_at`).
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("mcp_tasks")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_id", "text", (c) => c.notNull())
      .addColumn("tool", "text", (c) => c.notNull())
      .addColumn("answer", "text", (c) => c.notNull())
      .addColumn("follow", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("result", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("mcp_tasks_expires").on("mcp_tasks").column("expires_at").execute();
  },
  async down(db) {
    await db.schema.dropTable("mcp_tasks").execute();
  },
};
export default migration;
