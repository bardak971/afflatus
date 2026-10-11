import type { Migration } from "kysely/migration";

/**
 * The three counts the 2026-10-11 review found working through whole tables: each draft's tries by family (the command
 * index), the queue history's counts by status, and the families things in the library were made with (the "Any model"
 * filter). Each index holds every column its count reads, so the count is answered from the index alone. The first two
 * new ones start with the columns of generations_by_draft and generations_by_family, which they replace.
 */
const INDEXES: Array<[name: string, table: string, columns: string[]]> = [
  ["generations_by_draft_family", "generations", ["draft_id", "family", "created_at"]],
  ["generations_by_family_id", "generations", ["family", "id"]],
  ["jobs_by_status_warm", "jobs", ["status", "warm"]],
];

/** The indexes the new ones make redundant: a lookup by their one column reads the new index as well. */
const REPLACED: Array<[name: string, table: string, column: string]> = [
  ["generations_by_draft", "generations", "draft_id"],
  ["generations_by_family", "generations", "family"],
];

const migration: Migration = {
  async up(db) {
    for (const [name, table, columns] of INDEXES) await db.schema.createIndex(name).on(table).columns(columns).execute();
    for (const [name] of REPLACED) await db.schema.dropIndex(name).execute();
  },
  async down(db) {
    for (const [name, table, column] of REPLACED) await db.schema.createIndex(name).on(table).column(column).execute();
    for (const [name] of INDEXES) await db.schema.dropIndex(name).execute();
  },
};
export default migration;
