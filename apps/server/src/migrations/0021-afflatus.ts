import type { Migration } from "kysely/migration";

// the app's earlier name, in the kind of an export job
const migration: Migration = {
  async up(db) {
    await db.updateTable("jobs").set({ recipe_id: "afflatus.export" }).where("recipe_id", "=", "studai.export").execute();
  },
  async down(db) {
    await db.updateTable("jobs").set({ recipe_id: "studai.export" }).where("recipe_id", "=", "afflatus.export").execute();
  },
};
export default migration;
