import type { Migration } from "kysely/migration";

/**
 * The Motion transfer renders recorded with the work of 4096 frames (2026-10-14: the frame-picking node's length was read
 * as the frames sampled) get the work they sampled: their frame's pixels (the work over 4096) times their largest chunk's
 * frames. Taken at fifty times their work, they said the model kept its usual pace up to frames it never made, so that a
 * slowdown past them could not be learned (forecast.ts forecastFrom) and a large window was said "usual". A row is one of
 * them when its work counts more than eight times the frames its length holds (a part sampled larger than it is filed
 * holds up to a few times its pixels; 4096 frames are fifty times a window's); forecast.ts `workOfRow` leaves such a row out.
 * Each recipe's frames a second, longest chunk and frames carried from the clip before are written here as they were.
 */
const SHAPES: Record<string, { fps: number; chunk: number; carried: number }> = {
  "scail.motion": { fps: 16, chunk: 81, carried: 5 },
  "wananimate.motion": { fps: 24, chunk: 81, carried: 1 },
};

/** The frames of a render's largest chunk: the first, at most a chunk, on the 4n + 1 grid the models sample. */
function largestChunk(timeKey: string, durationMs: number, shape: { fps: number; chunk: number; carried: number }): number {
  const seconds = /(?:^|;)drivingSeconds=([\d.]+)/.exec(timeKey);
  const made = seconds ? Math.round(Number(seconds[1]) * shape.fps) : Math.round((durationMs * shape.fps) / 1000 + 0.25);
  const total = made + (/(?:^|;)previous\+/.test(timeKey) ? shape.carried : 0);
  return Math.min(shape.chunk, Math.floor((Math.max(5, total) - 1) / 4) * 4 + 1);
}

const migration: Migration = {
  async up(db) {
    const rows = await db
      .selectFrom("render_stats")
      .select(["id", "recipe_id", "time_key", "width", "height", "duration_ms", "work"])
      .where("recipe_id", "in", Object.keys(SHAPES))
      .where("work", "is not", null)
      .where("width", "is not", null)
      .where("height", "is not", null)
      .where("duration_ms", "is not", null)
      .execute();
    for (const r of rows) {
      const shape = SHAPES[r.recipe_id as string]!;
      const work = Number(r.work);
      const frames = Math.max(1, Math.round((Number(r.duration_ms) * shape.fps) / 1000 + 0.25));
      if (work % 4096 !== 0 || work <= Number(r.width) * Number(r.height) * frames * 8) continue;
      await db.updateTable("render_stats").set({ work: (work / 4096) * largestChunk(String(r.time_key), Number(r.duration_ms), shape) }).where("id", "=", r.id).execute();
    }
  },
  // the work they were recorded with was never theirs: there is nothing to put back
  async down() {},
};
export default migration;
