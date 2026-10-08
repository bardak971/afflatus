import type { Kysely } from "kysely";

/**
 * The names a render is given when it is made, so that the library does not fill with nameless files: a take
 * of a timeline clip is "<timeline> · c<clip> · t<take>", what a draft made is "<draft> 01", "<draft> 02"…
 * A name that is already there is never replaced: one given by hand wins. Migration 0046 names the
 * results made before this with the same rules, from what the database still says.
 */

/** The longest name given here: a library tile shows far less, the rest is only read in full in a tooltip. */
export const NAME_MAX = 80;

/** Cut to `max` characters at a word when one ends late enough, marked by an ellipsis. */
export function capName(text: string, max = NAME_MAX): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:·–-]+$/, "")}…`;
}

/** The first few words of a prompt, without the punctuation a cut leaves at its end: short enough to stand before a number. */
export function firstWords(text: string, words = 5, max = 40): string {
  const all = text.trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of all.slice(0, words)) {
    if (out && out.length + 1 + w.length > max) break;
    out = out ? `${out} ${w}` : w;
  }
  return capName(out, max).replace(/[,.;:·–-]+$/, "");
}

/** A take of a timeline clip: the timeline is cut short before the clip and take numbers are. */
export function takeName(timeline: string, clip: number, take: number): string {
  const suffix = ` · c${clip} · t${take}`;
  return `${capName(timeline.trim() || "Timeline", NAME_MAX - suffix.length)}${suffix}`;
}

/** The finished version of a take: its draft's name, said finished once (a finish of a finish is not "finished · finished"). */
export function finishedName(of: string): string {
  const suffix = " · finished";
  const base = of.trim().replace(/ · finished$/, "") || "video";
  return `${capName(base, NAME_MAX - suffix.length)}${suffix}`;
}

/** A recipe id said in words, for when its title is not at hand ("krea2.text-to-picture" → "Text to picture"). */
export function recipeWords(id: string): string {
  const what = (id.split(".").pop() ?? id).replace(/[-_]+/g, " ").trim();
  return what ? what[0]!.toUpperCase() + what.slice(1) : id;
}

/**
 * What a draft's results are called before their number: its own name, else the start of what was written in it
 * (its title, or the prompt it was sent with), else what it makes (the recipe).
 */
export function draftLabel(d: { name?: string | null; title?: string | null; prompt?: string | null; recipe: string }): string {
  if (d.name?.trim()) return d.name.trim();
  const words = firstWords(d.title ?? "") || firstWords(d.prompt ?? "");
  return words || d.recipe.trim() || "Render";
}

/** The n-th result of a draft: two digits at least, so that they sort (01 … 99, then 100). */
export function numbered(label: string, n: number): string {
  const suffix = ` ${String(n).padStart(2, "0")}`;
  return `${capName(label, NAME_MAX - suffix.length)}${suffix}`;
}

/** The highest number already given after `label` among these names, to carry on from it. */
function highestOf(label: string, names: string[]): number {
  let high = 0;
  for (const name of names) {
    if (!name.startsWith(`${label} `)) continue;
    const n = Number(name.slice(label.length + 1));
    if (Number.isInteger(n) && n > high) high = n;
  }
  return high;
}

type AnyDb = Kysely<any>;
type TakeLine = { id: string; clip_id: string; asset_id: string; finished_from: string | null };

/** Clips are counted in the order the timeline plays them, takes in the order they were made: as the timeline's inspector numbers them. */
async function clipNumbers(db: AnyDb, timelineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!timelineIds.length) return out;
  const clips = (await db.selectFrom("clips").select(["id", "timeline_id"]).where("timeline_id", "in", timelineIds).orderBy("position").orderBy("created_at").execute()) as Array<{ id: string; timeline_id: string }>;
  const seen = new Map<string, number>();
  for (const c of clips) {
    const n = (seen.get(c.timeline_id) ?? 0) + 1;
    seen.set(c.timeline_id, n);
    out.set(c.id, n);
  }
  return out;
}

/**
 * The name of each of these takes, from its timeline, its clip's place and its own place among the clip's takes. A
 * finished take is its draft's name (as it stands, or as it would be named), finished. `names` holds the assets' names.
 */
function namesOfTakes(
  takes: TakeLine[], siblings: Map<string, TakeLine[]>, clipNo: Map<string, number>, timelineOf: Map<string, string>, names: Map<string, string>,
): Map<string, string> {
  const byId = new Map<string, TakeLine>();
  for (const list of siblings.values()) for (const t of list) byId.set(t.id, t);
  const plain = (t: TakeLine) => {
    const own = siblings.get(t.clip_id) ?? [];
    return takeName(timelineOf.get(t.clip_id) ?? "", clipNo.get(t.clip_id) ?? 1, own.findIndex((s) => s.id === t.id) + 1);
  };
  const out = new Map<string, string>();
  for (const t of takes) {
    let root = t;
    for (let i = 0; i < 4 && root.finished_from && byId.has(root.finished_from); i++) root = byId.get(root.finished_from)!;
    if (root === t) out.set(t.id, plain(t));
    else out.set(t.id, finishedName(names.get(root.asset_id) || out.get(root.id) || plain(root)));
  }
  return out;
}

/** Of the clips these takes are on: all their takes in order, each clip's number on its timeline, its timeline's name. */
async function contextOf(db: AnyDb, clipIds: string[]) {
  const siblings = new Map<string, TakeLine[]>();
  const timelineOf = new Map<string, string>();
  if (!clipIds.length) return { siblings, timelineOf, clipNo: new Map<string, number>() };
  const all = (await db.selectFrom("takes").select(["id", "clip_id", "asset_id", "finished_from"]).where("clip_id", "in", clipIds).orderBy("created_at").execute()) as TakeLine[];
  for (const t of all) siblings.set(t.clip_id, [...(siblings.get(t.clip_id) ?? []), t]);
  const clips = (await db.selectFrom("clips").innerJoin("timelines", "timelines.id", "clips.timeline_id").select(["clips.id as id", "clips.timeline_id as timeline_id", "timelines.name as name"]).where("clips.id", "in", clipIds).execute()) as Array<{ id: string; timeline_id: string; name: string }>;
  for (const c of clips) timelineOf.set(c.id, c.name);
  return { siblings, timelineOf, clipNo: await clipNumbers(db, [...new Set(clips.map((c) => c.timeline_id))]) };
}

/** A take just placed: its video is named after its timeline, clip and take, when it has no name yet. */
export async function nameTake(db: AnyDb, takeId: string): Promise<void> {
  const take = (await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["takes.id as id", "takes.clip_id as clip_id", "takes.asset_id as asset_id", "takes.finished_from as finished_from", "assets.name as name"]).where("takes.id", "=", takeId).executeTakeFirst()) as (TakeLine & { name: string }) | undefined;
  if (!take || take.name.trim()) return;
  const { siblings, timelineOf, clipNo } = await contextOf(db, [take.clip_id]);
  const roots = (siblings.get(take.clip_id) ?? []).map((s) => s.asset_id);
  const names = new Map(((await db.selectFrom("assets").select(["id", "name"]).where("id", "in", roots).execute()) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const name = namesOfTakes([take], siblings, clipNo, timelineOf, names).get(take.id);
  if (name) await db.updateTable("assets").set({ name }).where("id", "=", take.asset_id).where("name", "=", "").execute();
}

/**
 * The names of `count` results a draft is about to file: its label, numbered on from what it made before (counting
 * them, and past the highest number already given, so that a result thrown away is not named again). Null when the draft is gone.
 */
export async function draftNames(db: AnyDb, draftId: string, count: number, sent: { prompt?: string | null; recipe: string }): Promise<string[] | null> {
  const draft = (await db.selectFrom("drafts").select(["name", "title"]).where("id", "=", draftId).executeTakeFirst()) as { name: string | null; title: string } | undefined;
  if (!draft) return null;
  const label = draftLabel({ ...draft, ...sent });
  const made = ((await db.selectFrom("assets").innerJoin("generations", "generations.id", "assets.generation_id").select("assets.name as name").where("generations.draft_id", "=", draftId).execute()) as Array<{ name: string }>).map((a) => a.name);
  const from = Math.max(made.length, highestOf(label, made));
  return Array.from({ length: count }, (_, i) => numbered(label, from + i + 1));
}

/** The text of a form's prompt, as a generation's inputs hold it, for the label of a draft that has no title. */
export function promptOf(inputs: Record<string, unknown>, promptIds: string[] = ["prompt"]): string {
  for (const id of promptIds) if (typeof inputs[id] === "string" && (inputs[id] as string).trim()) return inputs[id] as string;
  return "";
}

/**
 * Every nameless video, picture and sound that a timeline or a draft made, named as it would be named today: first the
 * takes (from the clips' places now: where they were when rendered is not kept), then what drafts made (numbered in the
 * order they were made), then the frames taken out of a named video. Names already given are left alone. Returns how many were named.
 */
export async function backfillNames(db: AnyDb, recipeTitle: (id: string) => string = recipeWords): Promise<number> {
  const names = new Map(((await db.selectFrom("assets").select(["id", "name"]).execute()) as Array<{ id: string; name: string | null }>).map((a) => [a.id, a.name ?? ""]));
  const given = new Map<string, string>();
  const give = (assetId: string, name: string) => {
    if ((names.get(assetId) ?? "x").trim() || !name) return;
    names.set(assetId, name);
    given.set(assetId, name);
  };

  // the takes: a video on two clips (a clip copied) is named after the first it was placed on
  const takes = (await db.selectFrom("takes").select(["id", "clip_id", "asset_id", "finished_from"]).orderBy("created_at").execute()) as TakeLine[];
  const nameless = takes.filter((t) => !(names.get(t.asset_id) ?? "x").trim());
  if (nameless.length) {
    const { siblings, timelineOf, clipNo } = await contextOf(db, [...new Set(nameless.map((t) => t.clip_id))]);
    // the drafts before their finishes: a finish is named after its draft's name
    for (const pass of [false, true]) {
      const these = nameless.filter((t) => Boolean(t.finished_from) === pass);
      for (const [id, name] of namesOfTakes(these, siblings, clipNo, timelineOf, names)) give(these.find((t) => t.id === id)!.asset_id, name);
    }
  }

  // what drafts made, numbered in the order it was made; a draft deleted since leaves its results as they are
  const made = (await db.selectFrom("assets").innerJoin("generations", "generations.id", "assets.generation_id")
    .innerJoin("drafts", "drafts.id", "generations.draft_id")
    .select(["assets.id as id", "generations.draft_id as draft_id", "generations.inputs as inputs", "generations.recipe_id as recipe_id", "drafts.name as draft_name", "drafts.title as title"])
    .orderBy("assets.created_at").orderBy("assets.id").execute()) as Array<{ id: string; draft_id: string; inputs: string; recipe_id: string; draft_name: string | null; title: string }>;
  const counted = new Map<string, number>();
  for (const m of made) {
    const n = (counted.get(m.draft_id) ?? 0) + 1;
    counted.set(m.draft_id, n);
    if ((names.get(m.id) ?? "x").trim()) continue;
    let inputs: Record<string, unknown> = {};
    try {
      inputs = JSON.parse(m.inputs) as Record<string, unknown>;
    } catch { /* a record that cannot be read: named without its prompt */ }
    give(m.id, numbered(draftLabel({ name: m.draft_name, title: m.title, prompt: promptOf(inputs), recipe: recipeTitle(m.recipe_id) }), n));
  }

  // a frame taken out of a video that has a name now: named as timelineMedia names a new one
  const frames = (await db.selectFrom("assets").select(["id", "source_id"]).where("origin", "=", "frame").where("source_id", "is not", null).execute()) as Array<{ id: string; source_id: string }>;
  for (const f of frames) {
    const source = names.get(f.source_id)?.trim();
    if (source) give(f.id, capName(`${source}, a frame`));
  }

  for (const [id, name] of given) await db.updateTable("assets").set({ name }).where("id", "=", id).where("name", "=", "").execute();
  return given.size;
}
