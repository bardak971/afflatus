import type { Migration } from "kysely/migration";

/**
 * What a rented pod was measured at (podFiles.ts, rented.ts): how fast its files came from each source (Hugging Face,
 * Civitai, an upload from this computer), and how long a deploy took to answer. The Deploy dialog's time and price for a
 * pod's files are worked out from them, slowest to fastest, or not said while there are none.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("pod_measures")
      .addColumn("id", "text", (c) => c.primaryKey())
      // hf, civitai, upload: a file's bytes over the time it took; boot: from the deploy to ComfyUI's first answer
      .addColumn("kind", "text", (c) => c.notNull())
      // secure or community (RunPod's clouds), when known
      .addColumn("cloud", "text")
      .addColumn("bytes", "integer", (c) => c.notNull())
      .addColumn("ms", "integer", (c) => c.notNull())
      .addColumn("at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("pod_measures_kind").on("pod_measures").columns(["kind", "at"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("pod_measures").execute();
  },
};
export default migration;
