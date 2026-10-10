import type { Migration } from "kysely/migration";

// the end of ComfyUI's traceback for a job that failed in a node: its log rolls over, and the cause with it
const migration: Migration = {
  async up(db) {
    await db.schema.alterTable("jobs").addColumn("error_trace", "text").execute();
  },
  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("error_trace").execute();
  },
};
export default migration;
