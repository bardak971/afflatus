import type { Migration } from "kysely/migration";

/**
 * The Prompt kit's cut-outs are gone (2026-10-13: on grey, H3 painted a grey mesh behind the person in 2 of 4 renders,
 * and no likeness was gained). A person's `cutout` switch and `cutouts` map come out of their definition (which no
 * longer takes them), and the cut-out pictures go to the bin. jobs.kit_for (0057) goes in 0060.
 */
const migration: Migration = {
  async up(db) {
    const at = new Date().toISOString();
    const people: Array<{ id: string; def: string }> = await db.selectFrom("entities").select(["id", "def"]).where("kind", "=", "person").execute();
    for (const p of people) {
      const def = JSON.parse(p.def) as Record<string, unknown>;
      if (!("cutout" in def) && !("cutouts" in def)) continue;
      const made = Object.values((def.cutouts ?? {}) as Record<string, unknown>).filter((x): x is string => typeof x === "string");
      delete def.cutout;
      delete def.cutouts;
      await db.updateTable("entities").set({ def: JSON.stringify(def) }).where("id", "=", p.id).execute();
      if (made.length) await db.updateTable("assets").set({ deleted_at: at }).where("id", "in", made).where("origin", "=", "kit").where("deleted_at", "is", null).execute();
    }
  },
  async down() {},
};
export default migration;
