import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const migration: Migration = {
  async up(db) {
    // what a render sampled per step, for forecasting the next from the renders before it (see forecast.ts). The
    // rows from before are filled in roughly: the result's size, times 24 frames a second of its length for a
    // video, where nothing was enlarged after the sampling; new rows carry the exact figure from the graph
    await db.schema.alterTable("render_stats").addColumn("work", "integer").execute();
    // at least one frame, written as a case: Postgres has no two-argument max (SQLite reads it the same)
    const frames = sql`cast(round(duration_ms / 1000.0 * 24) as integer)`;
    await sql`update render_stats set work = width * height * (case when ${frames} < 1 then 1 else ${frames} end) where kind = 'video' and width is not null and height is not null and duration_ms is not null and (time_key like '%upscale=Off%' or time_key not like '%upscale=%')`.execute(db);
    await sql`update render_stats set work = width * height where kind = 'image' and width is not null and height is not null and time_key not like '%hires=true%' and time_key not like '%upscale=%'`.execute(db);
  },
  async down(db) {
    await db.schema.alterTable("render_stats").dropColumn("work").execute();
  },
};
export default migration;
