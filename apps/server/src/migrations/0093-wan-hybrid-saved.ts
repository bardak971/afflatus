import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Wan Turbo's Hybrid turbo off again where a model's saved settings held the old default (card #109). 0.7.0 made it off
 * by default (card #108: the split ghosts from about 1.8 s), but saving a model's settings kept every per-model value,
 * the untouched ones too, and saved values go over the recipe's defaults: anyone who saved a Wan model's settings on 0.6.x
 * kept the split. A "Hybrid turbo: on" chosen on purpose cannot be told from the old default, so every one goes; a saved
 * "off", and every other saved value, stays. A model left with nothing saved loses its row, as Forget saved defaults does.
 *
 * Drafts and timeline clips hold only what differs from the defaults (form.ts `formDefaults`), so one that holds "on" had
 * it turned on by hand: they are left alone, as are the jobs and library items, which are takes already made.
 */
const migration: Migration = {
  async up(db) {
    await hybridOff(db);
  },
  // the old default cannot be put back where it was saved: taken back, the settings stay as this left them
  async down() {},
};
export default migration;

/** The Wan family's id, as the recipes held it on 2026-10-26 (not read from @afflatus/recipes, so the migration stays as it ran). */
const WAN = "wan";
const HYBRID = "turboHybrid";

export async function hybridOff(db: Kysely<any>): Promise<void> {
  const rows = (await db.selectFrom("model_settings").select(["owner_id", "file", "values"]).where("family", "=", WAN).execute()) as Array<{ owner_id: string; file: string; values: string }>;
  for (const r of rows) {
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(r.values) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!values || typeof values !== "object" || values[HYBRID] !== true) continue;
    delete values[HYBRID];
    if (Object.keys(values).length) await db.updateTable("model_settings").set({ values: JSON.stringify(values) }).where("owner_id", "=", r.owner_id).where("family", "=", WAN).where("file", "=", r.file).execute();
    else await db.deleteFrom("model_settings").where("owner_id", "=", r.owner_id).where("family", "=", WAN).where("file", "=", r.file).execute();
  }
}
