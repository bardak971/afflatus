import { now, type Db } from "./db";
import type { Storage } from "./storage";
import { derivedKeys } from "./timelines";

export const UNKEPT_MS = 24 * 60 * 60_000;
export const BIN_MS = 7 * 24 * 60 * 60_000;

/**
 * The one place the two expiry rules live:
 *  - a result nobody kept goes to the bin a day after it was made, or a day after its countdown was last
 *    started again (unkept after being kept, taken back from the bin: see assets.countdown_from);
 *  - what has been in the bin for a week is erased, file and all.
 * Returns how many items each rule touched.
 */
export async function sweep(db: Db, storage: Storage, at = Date.now()): Promise<{ binned: number; erased: number }> {
  const binned = await db
    .updateTable("assets")
    .set({ deleted_at: now() })
    .where("deleted_at", "is", null)
    .where("kept_at", "is", null)
    .where("origin", "=", "generated")
    .where((eb) => eb(eb.fn.coalesce("countdown_from", "created_at"), "<", new Date(at - UNKEPT_MS).toISOString()))
    .executeTakeFirst();

  const old = await db
    .selectFrom("assets")
    .select(["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key", "duration_ms"])
    .where("deleted_at", "<", new Date(at - BIN_MS).toISOString())
    .execute();
  // a painted part that nothing was made with is of no use to anyone after a week
  const masks = await db
    .selectFrom("assets")
    .select(["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key", "duration_ms"])
    .where("origin", "=", "mask")
    .where("created_at", "<", new Date(at - BIN_MS).toISOString())
    .where("id", "not in", db.selectFrom("generation_inputs").select("asset_id"))
    .execute();
  for (const a of [...old, ...masks]) {
    await storage.delete(a.file_key).catch(() => {});
    if (a.thumb_key) await storage.delete(a.thumb_key).catch(() => {});
    if (a.raw_key) await storage.delete(a.raw_key).catch(() => {});
    if (a.latent_key) await storage.delete(a.latent_key).catch(() => {});
    if (a.fine_latent_key) await storage.delete(a.fine_latent_key).catch(() => {});
    // what the timeline worked out of it (its film strip, its motion, its scene cuts) goes with it
    for (const key of derivedKeys(a)) await storage.delete(key).catch(() => {});
    await db.deleteFrom("assets").where("id", "=", a.id).execute();
  }
  return { binned: Number(binned.numUpdatedRows), erased: old.length };
}
