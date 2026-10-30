import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * "Search Hugging Face and Civitai" and "Download missing models" kept off where they were off (card #166, 0.8.4). They
 * became on by default for a new install, so that Find models and the downloads a job needs work from the first launch;
 * an install from before that never touched them read them off from the old default, and would have found them on after
 * the update, its files' hashes sent to Civitai without having been asked. Each is written off here, where it was never
 * saved, in an install that already holds anything (a setting or a job); a fresh install (nothing yet) takes the new
 * default. A value saved on purpose, on or off, stays.
 */
const migration: Migration = {
  async up(db) {
    await keptOff(db);
  },
  // the values written are the ones the install read before: taken back, they stay as they are
  async down() {},
};
export default migration;

/** The settings' keys, as settings.ts held them on 2026-10-30 (not read from it, so that the migration stays as it ran). */
const KEYS = ["civitaiLookups", "downloadModels"];

export async function keptOff(db: Kysely<any>): Promise<void> {
  const used = (await db.selectFrom("settings").select("key").limit(1).execute()).length > 0
    || (await db.selectFrom("jobs").select("id").limit(1).execute()).length > 0;
  if (!used) return;
  const at = new Date().toISOString();
  for (const key of KEYS) {
    await db.insertInto("settings").values({ key, value: "false", updated_at: at }).onConflict((oc) => oc.column("key").doNothing()).execute();
  }
}
