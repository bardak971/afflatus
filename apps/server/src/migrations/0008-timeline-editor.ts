import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    const add = (table: "timelines" | "clips", name: string, type: "text" | "integer", fallback?: string | number) =>
      db.schema.alterTable(table).addColumn(name, type, (c) => (fallback === undefined ? c : c.notNull().defaultTo(fallback))).execute();
    await add("timelines", "music_asset_id", "text");
    await add("timelines", "music_volume", "integer", 60);
    await add("timelines", "music_fade_in_ms", "integer", 1000);
    await add("timelines", "music_fade_out_ms", "integer", 3000);
    await add("timelines", "music_duck", "integer", 1);
    await add("timelines", "export_asset_id", "text");
    await add("clips", "kind", "text", "video");
    await add("clips", "still_asset_id", "text");
    await add("clips", "still_ms", "integer", 3000);
    await add("clips", "sound", "text", "own");
    await add("clips", "sound_asset_id", "text");
    await add("clips", "volume", "integer", 100);
    await add("clips", "fill", "integer", 0);
    await db.schema
      .createTable("timeline_history")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("timeline_id", "text", (c) => c.notNull().references("timelines.id").onDelete("cascade"))
      .addColumn("seq", "integer", (c) => c.notNull())
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("snapshot", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("timeline_history_by_timeline").on("timeline_history").columns(["timeline_id", "seq"]).execute();
  },
  async down(db) {
    await db.schema.dropTable("timeline_history").execute();
    for (const c of ["fill", "volume", "sound_asset_id", "sound", "still_ms", "still_asset_id", "kind"]) await db.schema.alterTable("clips").dropColumn(c).execute();
    for (const c of ["export_asset_id", "music_duck", "music_fade_out_ms", "music_fade_in_ms", "music_volume", "music_asset_id"]) await db.schema.alterTable("timelines").dropColumn(c).execute();
  },
};
export default migration;
