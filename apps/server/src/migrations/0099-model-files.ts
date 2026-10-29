import type { Migration } from "kysely/migration";

/**
 * Settings › Model files (0.8.2, modelLibrary.ts): what each model file was used for, and where a deleted one went.
 *
 * `model_uses`: the files a job's built graph loaded (queueSubmit.submit), one row each; `exact` 0 for a row the backfill
 * guessed (a helper file of a job from before, read from today's recipe). Apart from `jobs`, which "Keep finished jobs"
 * prunes: a file's uses outlive its jobs. `job_id` is the job's, or `gen:` and the generation's for one whose job is gone;
 * `generation_id` the takes it made. `name_key` the file as fileKey says it (its folder and bare name), and `sha256` the
 * file's when it was hashed then: a file moved or renamed keeps its uses.
 *
 * `model_removed`: each file Delete moved, to the Recycle Bin (`place` bin, its `$I` entry in `info_path`) or the set-aside
 * folder (aside), `stored_path` where it is now; put back (`restored_at`), or erased by Empty (`emptied_at`). `batch`: one
 * Delete's files, put back together by Undo. Sizes in bigint, as model_hashes'.
 *
 * `model_civitai`: what Civitai says of a version a file was matched to (model_hashes.civitai_version): its model's name,
 * the version's, its base model, its page's first picture. Asked once per version, in the background.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_uses")
      .addColumn("job_id", "text", (c) => c.notNull())
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("name_key", "text", (c) => c.notNull())
      .addColumn("sha256", "text")
      .addColumn("generation_id", "text")
      .addColumn("machine_id", "text")
      .addColumn("exact", "integer", (c) => c.notNull())
      .addColumn("used_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("model_uses_pk", ["job_id", "folder", "file"])
      .execute();
    await db.schema.createIndex("model_uses_name").on("model_uses").column("name_key").execute();
    await db.schema.createIndex("model_uses_generation").on("model_uses").column("generation_id").execute();
    await db.schema
      .createTable("model_removed")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("batch", "text", (c) => c.notNull())
      .addColumn("folder", "text", (c) => c.notNull())
      .addColumn("file", "text", (c) => c.notNull())
      .addColumn("path_was", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("sha256", "text")
      .addColumn("place", "text", (c) => c.notNull())
      .addColumn("stored_path", "text", (c) => c.notNull())
      .addColumn("info_path", "text")
      .addColumn("removed_at", "text", (c) => c.notNull())
      .addColumn("restored_at", "text")
      .addColumn("emptied_at", "text")
      .execute();
    await db.schema
      .createTable("model_civitai")
      .addColumn("version_id", "bigint", (c) => c.primaryKey())
      .addColumn("model_id", "bigint")
      .addColumn("model_name", "text")
      .addColumn("version_name", "text")
      .addColumn("base", "text")
      .addColumn("picture", "text")
      .addColumn("read_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("model_civitai").execute();
    await db.schema.dropTable("model_removed").execute();
    await db.schema.dropTable("model_uses").execute();
  },
};
export default migration;
