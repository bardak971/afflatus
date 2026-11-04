import type { Migration } from "kysely/migration";

/**
 * X/Y/Z grids (card #21): a grid is one row here, its axes as the board says them (each setting's name and its values'
 * labels, JSON), the draft and the recipe it was sent from, its count; each cell is a job of its own, tagged with the grid and
 * where it sits (`grid_cell`, "x.y.z"), and what it makes carries both, so that the board finds its cells among the library's
 * items however they are filed. `drafts.grid` is the set-up a draft keeps (its axes as typed), to open on it again.
 */
const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("grids")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("owner_id", "text", (c) => c.notNull())
      .addColumn("draft_id", "text")
      .addColumn("recipe_id", "text", (c) => c.notNull())
      .addColumn("axes", "text", (c) => c.notNull())
      .addColumn("count", "integer", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("grids_draft").on("grids").columns(["draft_id", "created_at"]).execute();
    await db.schema.alterTable("jobs").addColumn("grid_id", "text").execute();
    await db.schema.alterTable("jobs").addColumn("grid_cell", "text").execute();
    await db.schema.createIndex("jobs_grid").on("jobs").column("grid_id").execute();
    await db.schema.alterTable("assets").addColumn("grid_id", "text").execute();
    await db.schema.alterTable("assets").addColumn("grid_cell", "text").execute();
    await db.schema.createIndex("assets_grid").on("assets").column("grid_id").execute();
    await db.schema.alterTable("drafts").addColumn("grid", "text").execute();
  },
  async down(db) {
    await db.schema.dropIndex("assets_grid").execute();
    await db.schema.alterTable("assets").dropColumn("grid_cell").execute();
    await db.schema.alterTable("assets").dropColumn("grid_id").execute();
    await db.schema.dropIndex("jobs_grid").execute();
    await db.schema.alterTable("jobs").dropColumn("grid_cell").execute();
    await db.schema.alterTable("jobs").dropColumn("grid_id").execute();
    await db.schema.alterTable("drafts").dropColumn("grid").execute();
    await db.schema.dropTable("grids").execute();
  },
};
export default migration;
