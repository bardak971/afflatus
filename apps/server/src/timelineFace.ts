import { plural, type Recipe, type ReferenceValue } from "@afflatus/core";
import { compose, type Look } from "./entities";
import { now } from "./db";
import { httpError } from "./errors";
import { personPictures } from "./faceCarried";
import type { Placed, TimelineCore } from "./timelineModel";
import { ownInputIds } from "./timelinePlan";

/**
 * What an H3 clip with a person's picture does with it (card #223), as its form, read_timeline and the editor say it: a
 * continuation with the same person pictures as the clip before carries the face on (sampled without them, Face refine draws
 * the face towards them), any other clip is sampled with them. Read from the clips' forms with their cast worked in, as
 * Render all will send them in order; the render itself reads the take before it (TimelinePlan.carryFace), which is the same
 * once the clip before is rendered from its form.
 */
export interface FaceRoute {
  /** carried: the face comes from Face refine towards the picture; sampled: the clip is sampled with the picture. */
  route: "carried" | "sampled";
  /** Why it is sampled with it: the first clip of a run (nothing before it, a hard cut, a still), or other pictures than the clip before's. */
  why?: "first" | "changed";
  /** The clip it carries on from or changes from, counted from 1. */
  before?: number;
  /** A carried clip with Hold the face on continuations off (card #225): sampled without the pictures, and no pass after it. */
  held?: false;
  /**
   * A clip whose picture changed: the clips after it that carry on with the picture before the change, counted from 1. They
   * would be sampled with the old face again; Use this one on them too (spreadFace) gives them this clip's.
   */
  keepOld?: { from: number; to: number };
}

/** A clip as these read it: its H3 recipe that carries the face on (traits.faceCarried) and the person pictures its form sends. */
interface Faced {
  clip: Placed["clip"];
  recipe: Recipe<any> | undefined;
  /** Its person pictures, its cast worked in; null for a clip that is no such H3 clip (a still, an import, another model). */
  pictures: string[] | null;
  /** Whether its form holds the face on (Hold the face on continuations, card #225). */
  holds: boolean;
}

const lookOf = (json: string | null): Look | null => (json ? (JSON.parse(json) as Look) : null);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Each clip of a timeline with the person pictures its form sends (compose: the clip's cast, else the timeline's). */
async function facedClips(core: TimelineCore, timelineId: string): Promise<Faced[]> {
  const t = await core.row(timelineId);
  const timelineLook = lookOf(t.look);
  const all = await core.placed(timelineId);
  return Promise.all(all.map(async ({ clip }): Promise<Faced> => {
    const recipe = clip.kind === "video" && clip.recipe_id ? core.registry.recipe(clip.recipe_id) : undefined;
    if (!recipe?.traits?.faceCarried) return { clip, recipe, pictures: null, holds: false };
    const own = ownInputIds(recipe);
    const typed = Object.fromEntries(Object.entries(JSON.parse(clip.inputs) as Record<string, unknown>).filter(([k]) => own.has(k)));
    const composed = await compose(core.db, recipe, typed, lookOf(clip.look) ?? timelineLook).catch(() => null);
    const hold = recipe.traits.holdFace;
    return { clip, recipe, pictures: personPictures(recipe, composed?.input ?? typed), holds: !hold || typed[hold] !== false };
  }));
}

/** What each clip does with its person's picture, by clip id: only the H3 clips that have one. */
export async function faceRoutes(core: TimelineCore, timelineId: string): Promise<Record<string, FaceRoute>> {
  const faced = await facedClips(core, timelineId);
  const out: Record<string, FaceRoute> = {};
  faced.forEach((f, i) => {
    if (!f.pictures?.length) return;
    const prior = i > 0 ? faced[i - 1] : undefined;
    const carries = f.clip.joined === "continue" && prior?.pictures !== null && prior !== undefined;
    if (!carries) return void (out[f.clip.id] = { route: "sampled", why: "first" });
    if (same(f.pictures, prior.pictures!)) return void (out[f.clip.id] = { route: "carried", before: i, ...(f.holds ? {} : { held: false as const }) });
    // the clips after it that carry on, each with the clip before's pictures (the old ones): to give this clip's
    let to = i;
    while (to + 1 < faced.length && faced[to + 1]!.clip.joined === "continue" && faced[to + 1]!.pictures !== null && same(faced[to + 1]!.pictures!, prior.pictures!)) to++;
    out[f.clip.id] = { route: "sampled", why: "changed", before: i, ...(to > i ? { keepOld: { from: i + 2, to: to + 1 } } : {}) };
  });
  return out;
}

/** How a clip's route is said in a word or two (read_timeline). */
export function faceRouteSaid(r: FaceRoute): string {
  if (r.route === "carried" && r.held === false) return `sampled without it, a plain continuation of clip ${r.before} (Hold the face on continuations off): the face may drift from it`;
  if (r.route === "carried") return `face refine towards it, carrying the face on from clip ${r.before}`;
  if (r.why === "changed") return `sampled with it: a new look, its person pictures differ from clip ${r.before}'s${r.keepOld ? `; clips ${r.keepOld.from}–${r.keepOld.to} still have clip ${r.before}'s` : ""}`;
  return "sampled with it: the first clip of its run";
}

/**
 * Use this one on them too: the clips after `clipId` that carry on with the person pictures it changed from (FaceRoute
 * keepOld) given its own, so that they carry its face on rather than being sampled with the old one again. Each takes this
 * clip's cast (its own, or the timeline's) and its form's person pictures in place of theirs, their other pictures kept. One
 * step for Undo. The clips changed, counted from 1.
 */
export async function spreadFace(core: TimelineCore, clipId: string): Promise<{ from: number; to: number }> {
  const row = await core.clipRow(clipId);
  const timelineId = row.timeline_id;
  const done = await core.oneAtATime(timelineId, async () => {
    const routes = await faceRoutes(core, timelineId);
    const keepOld = routes[clipId]?.keepOld;
    if (!keepOld) throw httpError("No clip after this one carries on with the picture it changed from.");
    const all = await core.placed(timelineId);
    const at = all.findIndex((p) => p.clip.id === clipId);
    const source = all[at]!.clip;
    const recipeOf = (p: Placed) => core.registry.recipe(p.clip.recipe_id ?? "");
    const refsSpec = (r: Recipe<any> | undefined) => r?.inputs.find((i) => i.type === "references" && !i.media);
    const theirs = (inputs: Record<string, unknown>, r: Recipe<any> | undefined): ReferenceValue[] => {
      const spec = refsSpec(r);
      return spec && Array.isArray(inputs[spec.id]) ? (inputs[spec.id] as ReferenceValue[]) : [];
    };
    const people = theirs(JSON.parse(source.inputs) as Record<string, unknown>, recipeOf(all[at]!)).filter((r) => r.role === "person");
    await core.remember(timelineId, `clip ${at + 1}'s person picture on ${keepOld.from === keepOld.to ? `clip ${keepOld.from}` : `clips ${keepOld.from}–${keepOld.to}`}`);
    await core.db.transaction().execute(async (tx) => {
      for (const p of all.slice(keepOld.from - 1, keepOld.to)) {
        const spec = refsSpec(recipeOf(p));
        const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
        const refs = spec ? [...theirs(inputs, recipeOf(p)).filter((r) => r.role !== "person"), ...people].slice(0, spec.type === "references" ? spec.max : undefined) : [];
        await tx.updateTable("clips").set({
          look: source.look,
          ...(spec ? { inputs: JSON.stringify({ ...inputs, [spec.id]: refs }) } : {}),
          updated_at: now(),
        }).where("id", "=", p.clip.id).execute();
      }
    });
    return keepOld;
  });
  await core.touch(timelineId);
  core.events.emit("timeline");
  return done;
}

/** What spreadFace did, in a few words (the editor's toast, MCP). */
export const spreadSaid = (r: { from: number; to: number }) => `${r.from === r.to ? `Clip ${r.from} takes` : `${plural(r.to - r.from + 1, "clip")} (${r.from}–${r.to}) take`} this clip's person picture.`;
