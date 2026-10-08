import type { Migration } from "kysely/migration";
import { recipes } from "@afflatus/recipes";
import { backfillLabelNames } from "../autoName";

// what was sent from no draft with a label of its own (a batch from the API) and filed nameless before such renders were
// named: "<label> 01", "<label> 02"… in the order made. A label that is only its recipe's title (the queue's own) says
// nothing: such a render is named after the first words of its prompt instead, and one with no prompt stays nameless.
// The titles are the built-in recipes' and the imported workflows' as saved (autoName.ts holds the rules)
const migration: Migration = {
  async up(db) {
    const titles = new Map(recipes.map((r) => [r.id, r.title]));
    for (const w of (await db.selectFrom("workflows").select(["id", "def"]).execute()) as Array<{ id: string; def: string }>) {
      try {
        const title = (JSON.parse(w.def) as { title?: unknown }).title;
        if (typeof title === "string") titles.set(w.id, title);
      } catch { /* a workflow that cannot be read: its id said in words still tells its title apart */ }
    }
    await backfillLabelNames(db, (id) => titles.get(id));
  },
  async down() {},
};
export default migration;
