import type { Migration } from "kysely/migration";

/**
 * The lookups that read whole tables without them: what a generation made, which takes and jobs name an
 * asset, a clip or a generation, the jobs that wait on another, what an asset was used for, the library
 * and the bin page by page, the forecast on every form change, a draft's results, the family filter and
 * the sweep. generation_inputs is looked up by generation through its primary key already.
 */
const INDEXES: Array<[name: string, table: string, columns: string[]]> = [
  ["assets_by_generation", "assets", ["generation_id"]],
  ["assets_by_bin", "assets", ["deleted_at", "created_at", "id"]],
  ["assets_by_origin", "assets", ["origin", "kept_at"]],
  ["takes_by_asset", "takes", ["asset_id"]],
  ["jobs_by_clip", "jobs", ["clip_id"]],
  ["jobs_by_generation", "jobs", ["generation_id"]],
  ["jobs_by_depends_on", "jobs", ["depends_on"]],
  ["generation_inputs_by_asset", "generation_inputs", ["asset_id"]],
  ["render_stats_by_model", "render_stats", ["model_file", "status", "created_at"]],
  ["generations_by_draft", "generations", ["draft_id"]],
  ["generations_by_family", "generations", ["family"]],
];

const migration: Migration = {
  async up(db) {
    for (const [name, table, columns] of INDEXES) await db.schema.createIndex(name).on(table).columns(columns).execute();
  },
  async down(db) {
    for (const [name] of INDEXES) await db.schema.dropIndex(name).execute();
  },
};
export default migration;
