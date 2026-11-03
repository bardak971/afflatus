import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The one LLM from before there was a list ("llm") made the list's first ("llms"), as settings.ts read it at every load, and
 * its row deleted: read that way, it was never deleted, and its API key stayed in the database (a backup blanked it, the
 * file held it) after the model was changed or removed in Settings (card #262). An install that already has a list keeps
 * it as it is; the old row only goes. The S3 key's user ("runpodS3User"), never written by the page and no longer read
 * (the account's own id is), goes with it.
 */
const migration: Migration = {
  async up(db) {
    await llmRowGone(db);
  },
  // the list made holds what the old row held: taken back, the settings read the same
  async down() {},
};
export default migration;

export async function llmRowGone(db: Kysely<any>): Promise<void> {
  const rows = await db.selectFrom("settings").select(["key", "value"]).where("key", "in", ["llm", "llms"]).execute();
  const one = rows.find((r) => r.key === "llm");
  if (one && !rows.some((r) => r.key === "llms")) {
    let value: unknown = null;
    try {
      value = JSON.parse(one.value);
    } catch {
      // a value that isn't JSON was read as no model: there is nothing to keep of it
    }
    // as settings.ts read it: a model with an address is the list's first, under the id "main"
    if (value && typeof value === "object" && (value as { baseUrl?: unknown }).baseUrl) {
      await db.insertInto("settings").values({ key: "llms", value: JSON.stringify([{ id: "main", ...value }]), updated_at: new Date().toISOString() }).execute();
    }
  }
  await db.deleteFrom("settings").where("key", "in", ["llm", "runpodS3User"]).execute();
}
