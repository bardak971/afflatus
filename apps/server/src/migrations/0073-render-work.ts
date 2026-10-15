import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The work of the renders recorded before their recipes said it (the forecast review of 2026-10-15, F-11 and F-14).
 *
 * A Qwen Image 2.1 edit or Motion transfer picture, a Face detailer and a background removal have no node that says a
 * size: they were recorded with no work, and the forecast never learned from them (a Face detailer with its checkpoint in
 * memory was told 74 s, from its cold renders, and took 10). Their work is read back as their recipes now say it: an
 * edit's canvas (its result's size) with each picture it read at 0.4 of it a step, a detailer's face guide size squared,
 * a background removal's picture.
 *
 * A picture redrawn in tiles was recorded at the whole picture's size while its measured step is one tile's: it is
 * recorded now at its first pass's canvas (a tile for an upscale, the first size for a hires fix). An SDXL one recorded
 * with one tile's steps gets every tile's, as its progress now counts them.
 *
 * The rules are copied below as the recipes held them on 2026-10-15 (not read from @afflatus/recipes): a migration that
 * ran must do the same on every database, whatever the recipes become.
 */
const migration: Migration = {
  async up(db) {
    await workOfRecorded(db);
  },
  async down() {},
};
export default migration;

/** What a picture read beside an edit's canvas costs a step, against the canvas (qwen21 PICTURE_COST). */
const PICTURE_COST = 0.4;
/** The largest picture each upscale goes over whole, on Auto; past it, in tiles. */
const SHARPER_WHOLE: Record<string, number> = { "sdxl.sharper": 4.2e6, "klein.sharper": 2.6e6 };
const FLOW_SHARPER_WHOLE = 3.2e6;
/** The largest hires picture each text-to-picture redraws whole, on Auto (four times its area). */
const HIRES_WHOLE: Record<string, number> = { "sdxl.text-to-picture": 4 * 1024 * 1024, "krea2.text-to-picture": 4 * 1.1 * 1024 * 1024, "klein.picture": 2.6e6 };

interface Row {
  id: string;
  recipe_id: string;
  time_key: string;
  width: number | null;
  height: number | null;
  steps: number;
  work: number | null;
  inputs: string | null;
}

export async function workOfRecorded(db: Kysely<any>): Promise<void> {
  const rows = (await db
    .selectFrom("render_stats as r")
    .leftJoin("jobs as j", "j.id", "r.id")
    .leftJoin("assets as a", "a.id", "r.asset_id")
    .leftJoin("generations as g", "g.id", "a.generation_id")
    .select(["r.id", "r.recipe_id", "r.time_key", "r.width", "r.height", "r.steps", "r.work", (eb) => eb.fn.coalesce("j.inputs", "g.inputs").as("inputs")])
    .where("r.width", "is not", null)
    .where("r.height", "is not", null)
    .where((eb) => eb.or([eb("r.time_key", "like", "%tiles=%"), eb("r.recipe_id", "in", ["qwen21.edit", "qwen21.motion-picture", "sdxl.fix-face", "tools.remove-background"])]))
    .execute()) as Row[];
  for (const r of rows) {
    const got = workOf(r);
    if (got && (got.work !== r.work || got.steps !== r.steps)) await db.updateTable("render_stats").set({ work: got.work, steps: got.steps }).where("id", "=", r.id).execute();
  }
}

/** A recorded render's work (and steps) as its recipe says them now; null when it is not one of those, or not to be told. */
function workOf(r: Row): { work: number; steps: number } | null {
  const w = r.width!;
  const h = r.height!;
  const key = settingsOf(r.time_key);
  const inputs = parsed(r.inputs);
  const count = (field: string, max: number) => (Array.isArray(inputs?.[field]) ? Math.min(max, (inputs![field] as unknown[]).length) : null);
  if (!r.work) {
    if (r.recipe_id === "qwen21.edit") return { work: Math.round(w * h * (1 + PICTURE_COST * (1 + (count("references", 9) ?? (key.has("references+") ? 1 : 0))))), steps: r.steps };
    if (r.recipe_id === "qwen21.motion-picture") return { work: Math.round(w * h * (1 + PICTURE_COST * (1 + (count("people", 3) ?? 1)))), steps: r.steps };
    if (r.recipe_id === "sdxl.fix-face") {
      const size = Number(key.get("faceSize") ?? 1024);
      return size > 0 ? { work: size * size, steps: r.steps } : null;
    }
    if (r.recipe_id === "tools.remove-background") return { work: w * h, steps: r.steps };
    return null;
  }
  const tileSize = Number(key.get("tileSize"));
  const overlapAsked = Number(key.get("tileOverlap"));
  if (!(tileSize > 0) || !(overlapAsked >= 0)) return null;
  const tiled = (whole: number | undefined) => key.get("tiles") === "Tiles" || (key.get("tiles") === "Auto" && whole !== undefined && w * h > whole);
  const tile = Math.min(tileSize, Math.max(w, h));
  const overlap = Math.min(overlapAsked, Math.floor(tile / 4));
  const along = (side: number) => (side <= tile ? 1 : Math.ceil((side - overlap) / (tile - overlap)));
  const tiles = along(w) * along(h);
  if (r.recipe_id.endsWith(".sharper") && key.get("refine") !== "false" && tiled(SHARPER_WHOLE[r.recipe_id] ?? FLOW_SHARPER_WHOLE)) {
    const work = Math.min(tile, w) * Math.min(tile, h);
    // SDXL's light pass: half the steps asked, 6 at least, 30 at most asked; recorded alone, it was one tile's
    const light = Math.max(6, Math.round(Math.min(30, Number(key.get("steps"))) * 0.5));
    return { work, steps: r.recipe_id === "sdxl.sharper" && r.steps === light ? light * tiles : r.steps };
  }
  if (key.get("hires") === "true" && tiled(HIRES_WHOLE[r.recipe_id])) {
    const size = /^(\d+)x(\d+)$/.exec(key.get("size") ?? "");
    if (!size) return null;
    const first = Number(key.get("steps"));
    const hires = Number(key.get("hiresSteps"));
    return { work: Number(size[1]) * Number(size[2]), steps: r.recipe_id === "sdxl.text-to-picture" && r.steps === first + hires ? first + hires * tiles : r.steps };
  }
  return null;
}

/** A time key's settings by name ("size=640x640;tiles=Tiles;source+" → size, tiles, and "source+" as a name of its own). */
function settingsOf(timeKey: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of timeKey.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) out.set(part, "");
    else out.set(part.slice(0, at), part.slice(at + 1));
  }
  return out;
}

function parsed(json: string | null): Record<string, unknown> | null {
  try {
    const v = json ? JSON.parse(json) : null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
