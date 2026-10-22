import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * H3 · Swap motion retired (card #42, the owner, 2026-10-22): a source's windows each take their own form, Swap character
 * where a shot opens and Motion transfer where it carries on, which is what Swap motion made by itself.
 *
 * - Motion transfer's source video takes the swap's input ids (driving, drivingStart, drivingSeconds → source, sourceStart,
 *   sourceSeconds), so that a source's windows of either form read their part alike: renamed wherever its inputs are kept.
 * - Swap motion's clips are given those forms in place: a window that opens a shot (its join a cut) becomes Swap character
 *   with its inputs as they are (Swap motion's first window was one); one that carries on becomes Motion transfer, the
 *   prompt it was given (typed, or carried on from clip 1's) moved to Motion transfer's own and the swap's shifts kept.
 *   Marked as carrying on from a swap, Motion transfer renders such a window as Swap motion did (on the swap's model). The
 *   source's own model becomes Swap character. A library item, a job or a draft made by it opens as the form its window
 *   became (one that carried on had a clip before); the takes are not touched.
 * - The same in what a timeline keeps beside its clips: the windows a trim set aside (`source.parked`) and its Undo steps.
 *
 * The rules are copied below as the recipes held them on 2026-10-22 (not read from @afflatus/recipes): a migration that
 * ran must do the same on every database, whatever the recipes become.
 */
const migration: Migration = {
  async up(db) {
    await swapMotionRetired(db);
  },
  async down() {},
};
export default migration;

const RETIRED = "h3.swapMotion";
const MOTION = "h3.motion";
/** The prompts a swap form starts on (swap.ts STARTED_ON): read as empty, not as typed. */
const SWAP_CAPTION = "Swap the person in <Video 1> with the character in <Picture 1>.";
const STARTED_ON = new Set([SWAP_CAPTION, `${SWAP_CAPTION} Keep the motion, the gestures and the lip movements of <Video 1>. Keep the room of <Video 1> exactly as it is.`]);
/** Motion transfer's source video, as its ids were and are. */
const RENAMED: Record<string, string> = { driving: "source", drivingStart: "sourceStart", drivingSeconds: "sourceSeconds" };

type Inputs = Record<string, unknown>;

/** Motion transfer's inputs with the swap's ids for its source video. */
export const renamedMotion = (inputs: Inputs): Inputs => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [RENAMED[k] ?? k, v]));

/** A Swap motion window's form and inputs once retired: Swap character when it opens a shot, else Motion transfer. */
export function migratedWindow(inputs: Inputs, opens: boolean): { recipe: "h3.swap" | "h3.motion"; inputs: Inputs } {
  if (opens) return { recipe: "h3.swap", inputs };
  const who = typeof inputs.who === "string" ? inputs.who.trim() : "";
  const typed = Boolean(who) && !STARTED_ON.has(who);
  return {
    recipe: MOTION,
    inputs: {
      ...inputs,
      // carrying on from the swap, on its model, with no Picture of its own (Motion transfer's afterSwap)
      afterSwap: true,
      ...(typed ? { description: who } : {}),
      // the swap's own shifts, which Swap motion's windows took and Motion transfer's defaults are not (11 / 4)
      ...(inputs.shiftVideo === undefined ? { shiftVideo: 12 } : {}),
      ...(inputs.shiftAudio === undefined ? { shiftAudio: 3 } : {}),
    },
  };
}

/** A form and its inputs as they are after the retirement; null when neither is touched. `opens`: whether it opens a shot. */
export function retired(recipe: string | null | undefined, inputs: Inputs, opens: boolean): { recipe: string; inputs: Inputs } | null {
  if (recipe === RETIRED) return migratedWindow(inputs, opens);
  if (recipe === MOTION && Object.keys(inputs).some((k) => k in RENAMED)) return { recipe, inputs: renamedMotion(inputs) };
  return null;
}

const parse = (text: unknown): Inputs | null => {
  try {
    const v = typeof text === "string" && text ? (JSON.parse(text) as unknown) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Inputs) : null;
  } catch {
    return null;
  }
};

/** A clip row (a table's, or one kept in a snapshot or set aside) as it is after; null when untouched. */
function clipRow(row: Inputs): Inputs | null {
  const inputs = parse(row.inputs);
  const to = inputs ? retired(row.recipe_id as string | null, inputs, row.joined !== "continue") : null;
  return to ? { ...row, recipe_id: to.recipe, inputs: JSON.stringify(to.inputs) } : null;
}

/** A timeline's source plan (its text) as it is after; null when untouched. */
function sourceText(text: unknown): string | null {
  const plan = parse(text);
  if (!plan) return null;
  let changed = false;
  const next: Inputs = { ...plan };
  if (plan.recipe === RETIRED) {
    next.recipe = "h3.swap";
    changed = true;
  }
  if (plan.recipe === MOTION && plan.inputs && typeof plan.inputs === "object" && Object.keys(plan.inputs).some((k) => k in RENAMED)) {
    next.inputs = renamedMotion(plan.inputs as Inputs);
    changed = true;
  }
  if (Array.isArray(plan.parked)) {
    next.parked = plan.parked.map((p: { clip?: Inputs }) => {
      const clip = p?.clip && typeof p.clip === "object" ? clipRow(p.clip) : null;
      if (!clip) return p;
      changed = true;
      return { ...p, clip };
    });
  }
  return changed ? JSON.stringify(next) : null;
}

export async function swapMotionRetired(db: Kysely<any>): Promise<void> {
  const clips = (await db.selectFrom("clips").select(["id", "recipe_id", "inputs", "joined"]).where("recipe_id", "in", [RETIRED, MOTION]).execute()) as Inputs[];
  for (const c of clips) {
    const to = clipRow(c);
    if (to) await db.updateTable("clips").set({ recipe_id: to.recipe_id, inputs: to.inputs }).where("id", "=", c.id as string).execute();
  }
  const timelines = (await db.selectFrom("timelines").select(["id", "source"]).where((eb) => eb.or([eb("source", "like", `%${RETIRED}%`), eb("source", "like", `%${MOTION}%`)])).execute()) as Array<{ id: string; source: string | null }>;
  for (const t of timelines) {
    const source = sourceText(t.source);
    if (source) await db.updateTable("timelines").set({ source }).where("id", "=", t.id).execute();
  }
  // a library item, a job: opened or finished again in its form (the window that carried on had a clip before)
  for (const table of ["generations", "jobs"]) {
    const rows = (await db.selectFrom(table).select(["id", "recipe_id", "inputs"]).where("recipe_id", "in", [RETIRED, MOTION]).execute()) as Inputs[];
    for (const r of rows) {
      const inputs = parse(r.inputs);
      const to = inputs ? retired(r.recipe_id as string, inputs, !inputs.previous) : null;
      if (to) await db.updateTable(table).set({ recipe_id: to.recipe, inputs: JSON.stringify(to.inputs) }).where("id", "=", r.id as string).execute();
    }
  }
  // a draft's forms, one a recipe: Swap motion's opens as Swap character (unless the draft has one already)
  const drafts = (await db.selectFrom("drafts").select(["id", "recipe_id", "forms"]).where((eb) => eb.or([eb("forms", "like", `%${RETIRED}%`), eb("forms", "like", `%${MOTION}%`), eb("recipe_id", "=", RETIRED)])).execute()) as Array<{ id: string; recipe_id: string | null; forms: string | null }>;
  for (const d of drafts) {
    const forms = parse(d.forms) ?? {};
    const next: Inputs = { ...forms };
    const motion = parse(JSON.stringify(forms[MOTION] ?? null));
    if (motion) next[MOTION] = renamedMotion(motion);
    if (forms[RETIRED] !== undefined) {
      if (next["h3.swap"] === undefined) next["h3.swap"] = forms[RETIRED];
      delete next[RETIRED];
    }
    await db.updateTable("drafts").set({ forms: JSON.stringify(next), ...(d.recipe_id === RETIRED ? { recipe_id: "h3.swap" } : {}) }).where("id", "=", d.id).execute();
  }
  // the Undo and Redo steps: the clips and the source each one brings back
  for (const table of ["timeline_history", "timeline_future"]) await stepsRetired(db, table);
}

async function stepsRetired(db: Kysely<any>, table: string): Promise<void> {
  const steps = (await db.selectFrom(table).select(["id", "snapshot"]).where((eb) => eb.or([eb("snapshot", "like", `%${RETIRED}%`), eb("snapshot", "like", `%${MOTION}%`)])).execute()) as Array<{ id: string; snapshot: string }>;
  for (const s of steps) {
    const snap = parse(s.snapshot);
    if (!snap) continue;
    let changed = false;
    const next: Inputs = { ...snap };
    if (Array.isArray(snap.clips)) {
      next.clips = snap.clips.map((c: Inputs) => {
        const to = c && typeof c === "object" ? clipRow(c) : null;
        if (to) changed = true;
        return to ?? c;
      });
    }
    const timeline = snap.timeline && typeof snap.timeline === "object" ? (snap.timeline as Inputs) : null;
    const source = timeline ? sourceText(timeline.source) : null;
    if (timeline && source) {
      next.timeline = { ...timeline, source };
      changed = true;
    }
    if (changed) await db.updateTable(table).set({ snapshot: JSON.stringify(next) }).where("id", "=", s.id).execute();
  }
}
