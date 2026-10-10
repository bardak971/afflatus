import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The lookups the 2026-10 review found reading whole tables: a project's folders, drafts and timelines (the project
 * counts, every library page filtered by project), the generations newest first (prompt history, the render rates),
 * the queue's history by when each job ended, and the bin page newest first. The bin's index holds only the items
 * in the bin, so it costs nothing for the rest of the library; partial indexes are the same SQL on SQLite and Postgres.
 */
const INDEXES: Array<[name: string, table: string, columns: string[]]> = [
  ["folders_by_project", "folders", ["project_id"]],
  ["drafts_by_project", "drafts", ["project_id", "updated_at"]],
  ["timelines_by_project", "timelines", ["project_id", "updated_at"]],
  ["generations_by_time", "generations", ["created_at", "id"]],
  ["jobs_by_finish", "jobs", ["finished_at", "created_at"]],
];

const migration: Migration = {
  async up(db) {
    for (const [name, table, columns] of INDEXES) await db.schema.createIndex(name).on(table).columns(columns).execute();
    await db.schema.createIndex("assets_in_bin").on("assets").columns(["created_at", "id"]).where(sql.ref("deleted_at"), "is not", null).execute();
  },
  async down(db) {
    for (const [name] of INDEXES) await db.schema.dropIndex(name).execute();
    await db.schema.dropIndex("assets_in_bin").execute();
  },
};
export default migration;
