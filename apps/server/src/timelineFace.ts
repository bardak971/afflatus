import { plural, type Recipe, type ReferenceValue } from "@afflatus/core";
import { compose, type Look } from "./entities";
import { now } from "./db";
import { httpError } from "./errors";
import { faceOf, lookOf, pictureOwners, renderedWith, sameFace, takeComing } from "./faceCarried";
import type { Placed, TimelineCore } from "./timelineModel";
import { generationOfTake, ownInputIds } from "./timelinePlan";

/**
 * What an H3 clip with a person's picture does with it (card #223), as its form, read_timeline and the editor say it: a
 * continuation with the same person as the clip before (faceOf: the same cast person and picked picture, or the same
 * pictures) carries the face on (sampled without their pictures, Face refine draws the face towards them), any other clip is
 * sampled with them. The clip before is read as a render of this clip reads it (TimelinePlan.carryFace): its take to come,
 * else the render of the take that plays, else (nothing rendered yet) its form, as Render all will send it. Where Face refine
 * cannot run (no face detector, its pack missing), the render samples a carried clip with the pictures after all, and its
 * job says so (card #231).
 */
export interface FaceRoute {
  /** carried: the face comes from Face refine towards the picture; sampled: the clip is sampled with the picture. */
  route: "carried" | "sampled";
  /** Why it is sampled with it: the first clip of a run (nothing before it, a hard cut, a still), or another person than the clip before's. */
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

/** A clip as these read it: its recipe, who its form gives as a person, and who a clip carrying on from it carries on. */
interface Faced {
  clip: Placed["clip"];
  recipe: Recipe<any> | undefined;
  /** Who its form gives as a person (faceOf), its cast worked in; null for a clip that is no H3 clip carrying the face on. */
  face: string[] | null;
  /** Who a clip carrying on from it is compared with (see FaceRoute); null where none carries a face on from it (a still, an import). */
  carries: string[] | null;
  /** Whether its form holds the face on (Hold the face on continuations, card #225). */
  holds: boolean;
}

/** Each clip of a timeline with who its form gives as a person (compose: the clip's cast, else the timeline's) and who it hands on. */
async function facedClips(core: TimelineCore, timelineId: string): Promise<Faced[]> {
  const t = await core.row(timelineId);
  const timelineLook = lookOf(t.look);
  const all = await core.placed(timelineId);
  const owners = await pictureOwners(core.db);
  return Promise.all(all.map(async (p): Promise<Faced> => {
    const { clip } = p;
    const recipe = clip.kind === "video" && clip.recipe_id ? core.registry.recipe(clip.recipe_id) : undefined;
    // any recipe with reference pictures: a render carrying on from a Swap character or Motion transfer clip reads its
    // pictures too (TimelinePlan.carryFace), and the editor said "the first of its run" there (card #231)
    if (!recipe?.inputs.some((i) => i.type === "references" && !i.media && !i.noCast)) return { clip, recipe, face: null, carries: null, holds: false };
    const own = ownInputIds(recipe);
    const typed = Object.fromEntries(Object.entries(JSON.parse(clip.inputs) as Record<string, unknown>).filter(([k]) => own.has(k)));
    const look = lookOf(clip.look) ?? timelineLook;
    const composed = await compose(core.db, recipe, typed, look).catch(() => null);
    const face = faceOf(recipe, composed?.input ?? typed, look, owners);
    const rendered = (await takeComing(core.db, clip.id)) ?? (p.active ? await renderedWith(core.db, generationOfTake(p.active, p.takes)) : undefined);
    const carries = rendered === undefined ? face : rendered ? faceOf(core.registry.recipe(rendered.recipe), rendered.inputs, rendered.look, owners) : null;
    const hold = recipe.traits?.holdFace;
    return { clip, recipe, face: recipe.traits?.faceCarried ? face : null, carries, holds: !hold || typed[hold] !== false };
  }));
}

/** What each clip does with its person's picture, by clip id: only the H3 clips that have one. */
export async function faceRoutes(core: TimelineCore, timelineId: string): Promise<Record<string, FaceRoute>> {
  const faced = await facedClips(core, timelineId);
  const out: Record<string, FaceRoute> = {};
  faced.forEach((f, i) => {
    if (!f.face?.length) return;
    const prior = i > 0 ? faced[i - 1] : undefined;
    if (f.clip.joined !== "continue" || !prior?.carries) return void (out[f.clip.id] = { route: "sampled", why: "first" });
    const old = prior.carries;
    if (sameFace(f.face, old)) return void (out[f.clip.id] = { route: "carried", before: i, ...(f.holds ? {} : { held: false as const }) });
    // the clips after it that carry on, each with the person the clip before had (the old one): to give them this clip's. Not
    // when the clip before had no person: clips with none have no picture of it (card #232)
    let to = i;
    while (old.length && to + 1 < faced.length && faced[to + 1]!.clip.joined === "continue" && sameFace(faced[to + 1]!.face ?? [], old)) to++;
    out[f.clip.id] = { route: "sampled", why: "changed", before: i, ...(to > i ? { keepOld: { from: i + 2, to: to + 1 } } : {}) };
  });
  return out;
}

/** How a clip's route is said in a word or two (read_timeline). */
export function faceRouteSaid(r: FaceRoute): string {
  if (r.route === "carried" && r.held === false) return `sampled without it, a plain continuation of clip ${r.before} (Hold the face on continuations off): the face may drift from it`;
  if (r.route === "carried") return `face refine towards it, carrying the face on from clip ${r.before} (sampled with it where Face refine cannot run)`;
  if (r.why === "changed") return `sampled with it: a new look, another person or picture than clip ${r.before}'s${r.keepOld ? `; clips ${r.keepOld.from}–${r.keepOld.to} still have clip ${r.before}'s` : ""}`;
  return "sampled with it: the first clip of its run";
}

/**
 * Use this one on them too: the clips after `clipId` that carry on with the person it changed from (FaceRoute keepOld) given
 * its own, so that they carry its face on rather than being sampled with the old one again. Each keeps its own look (its
 * place, style, snippets, its people's outfits), its people swapped for this clip's cast people with the picture picked on
 * them; and its form's person pictures for this one's, put first so that none is cut, its other pictures after them as far
 * as the input takes. One step for Undo. The clips changed, counted from 1.
 */
export async function spreadFace(core: TimelineCore, clipId: string): Promise<{ from: number; to: number }> {
  const row = await core.clipRow(clipId);
  const timelineId = row.timeline_id;
  const done = await core.oneAtATime(timelineId, async () => {
    const routes = await faceRoutes(core, timelineId);
    const keepOld = routes[clipId]?.keepOld;
    if (!keepOld) throw httpError("No clip after this one carries on with the picture it changed from.");
    const all = await core.placed(timelineId);
    const timelineLook = lookOf((await core.row(timelineId)).look);
    const at = all.findIndex((p) => p.clip.id === clipId);
    const source = all[at]!.clip;
    const recipeOf = (p: Placed) => core.registry.recipe(p.clip.recipe_id ?? "");
    const refsSpec = (r: Recipe<any> | undefined) => r?.inputs.find((i) => i.type === "references" && !i.media && !i.noCast);
    const theirs = (inputs: Record<string, unknown>, r: Recipe<any> | undefined): ReferenceValue[] => {
      const spec = refsSpec(r);
      return spec && Array.isArray(inputs[spec.id]) ? (inputs[spec.id] as ReferenceValue[]) : [];
    };
    const people = theirs(JSON.parse(source.inputs) as Record<string, unknown>, recipeOf(all[at]!)).filter((r) => r.role === "person");
    const targets = all.slice(keepOld.from - 1, keepOld.to);
    // which of the casts' members are people (a place stays the clip's own)
    const sourceLook = lookOf(source.look) ?? timelineLook;
    const looks = [sourceLook, ...targets.map((p) => lookOf(p.clip.look) ?? timelineLook)];
    const ids = [...new Set(looks.flatMap((l) => l?.cast.map((c) => c.id) ?? []))];
    const persons = new Set(ids.length ? (await core.db.selectFrom("entities").select("id").where("id", "in", ids).where("kind", "=", "person").execute()).map((e) => e.id) : []);
    const cast = (sourceLook?.cast ?? []).filter((c) => persons.has(c.id));
    await core.remember(timelineId, `clip ${at + 1}'s person picture on ${keepOld.from === keepOld.to ? `clip ${keepOld.from}` : `clips ${keepOld.from}–${keepOld.to}`}`);
    await core.db.transaction().execute(async (tx) => {
      for (const p of targets) {
        const spec = refsSpec(recipeOf(p));
        const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
        const refs = spec ? [...people, ...theirs(inputs, recipeOf(p)).filter((r) => r.role !== "person")].slice(0, spec.type === "references" ? spec.max : undefined) : [];
        const was = lookOf(p.clip.look) ?? timelineLook;
        // the clip's own people in this clip's people's place, each with this clip's picked picture (and the outfit it had);
        // a clip whose people are already these keeps its look as it is (the timeline's stays the timeline's)
        const wore = (id: string) => was?.cast.find((x) => x.id === id)?.outfit;
        const swapped: Look | null = was
          ? { ...was, cast: [...cast.map((c) => (wore(c.id) === undefined ? c : { ...c, outfit: wore(c.id) })), ...was.cast.filter((c) => !persons.has(c.id))] }
          : cast.length ? { cast, style: null, snippets: [] } : null;
        const look = swapped && JSON.stringify(swapped) !== JSON.stringify(was) ? JSON.stringify(swapped) : p.clip.look;
        await tx.updateTable("clips").set({
          look,
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
