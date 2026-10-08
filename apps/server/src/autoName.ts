import { sql, type Kysely } from "kysely";
import { clockOf } from "./timelineModel";

/**
 * The names a render is given when it is made, so that the library does not fill with nameless files: a take
 * of a timeline clip is "<timeline> · c<clip> · t<take>", what a draft made is "<draft> 01", "<draft> 02"…, what was
 * sent from no draft "<label> 01" after the label it was given, else after the first words of its prompt.
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

/** A name without the extension of a media file ("harbour.mp4" → "harbour"): what comes after it reads on from the name. */
const stem = (name: string) => name.trim().replace(/\.(mp4|webm|mov|mkv|m4v|avi|gif|png|jpe?g|webp|m4a|mp3|wav|flac|ogg)$/i, "");

/**
 * The finished version of a take: its draft's name, said finished once (a finish of a finish is not "finished · finished"),
 * with how many times bigger it was made when it was ("Big Air · c2 · t5 · finished ×2").
 */
export function finishedName(of: string, by?: number | null): string {
  const suffix = by && by !== 1 ? ` · finished ×${Math.round(by * 10) / 10}` : " · finished";
  const base = stem(of).replace(/ · finished(?: ×[\d.]+)?(?: \([^)]*\))?$/, "") || "video";
  return `${capName(base, NAME_MAX - suffix.length)}${suffix}`;
}

/** What was taken out of a named item: its name, cut short before what it is of it ("Big Air · c2 · t5 · 0:01–0:02"). */
export function fromName(source: string, suffix: string): string {
  return `${capName(stem(source) || "video", NAME_MAX - suffix.length)}${suffix}`;
}

/** A frame of a video: "Big Air · c2 · t5 · frame 0:03.2" (without the moment when it is not known). */
export const frameName = (source: string, atMs?: number) => fromName(source, ` · frame${atMs === undefined ? "" : ` ${clockOf(atMs)}`}`);

/** The sound of a video, as a sound of its own: "Big Air · c2 · t5 · audio". */
export const soundName = (source: string) => fromName(source, " · audio");

/**
 * A name that says nothing of what it is named: none, or one that older code gave when the video it came from had no
 * name ("video · 0:01–0:02", "video · finished ×2 (upscale model)", "Audio extracted from a video"). Such an item is
 * shown under a name from where it came from (shownNames); its own is never written over.
 */
export function saysNothing(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return !n || n.startsWith("video · ") || n === "Audio extracted from a video";
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

/**
 * The label a job was sent with, when someone gave it one: a job sent without one is labelled with its recipe's title
 * by the queue (queue.ts), which says nothing a name should. Empty when the label is that title, or the recipe id said in words.
 */
export function givenLabel(label: string | null | undefined, recipeId: string, recipeTitle?: string): string {
  const clean = (label ?? "").trim().replace(/\s+/g, " ");
  // compared without case, dashes or underscores: an imported workflow deleted since is only known by its id ("workflow.harbor-walk")
  const plain = (a: string) => a.trim().replace(/[\s_-]+/g, " ").toLowerCase();
  const same = (a: string) => plain(a) === plain(clean);
  if (!clean || same(recipeId) || same(recipeWords(recipeId)) || (recipeTitle !== undefined && same(recipeTitle))) return "";
  return clean;
}

/** The number after `label` in a name numbered from it (capped as numbered() caps it), else 0. */
function numberAfter(label: string, name: string): number {
  const m = / (\d+)$/.exec(name);
  if (!m) return 0;
  const n = Number(m[1]);
  return numbered(label, n) === name ? n : 0;
}

/**
 * The highest number already given after each of these labels, among every asset's name. Read by the start the names
 * share however they were cut (a cut is never before the middle of NAME_MAX): code points, as SQLite and Postgres count.
 */
async function highestAfter(db: AnyDb, labels: string[]): Promise<Map<string, number>> {
  const out = new Map(labels.map((l) => [l, 0]));
  const starts = new Map<string, string[]>();
  for (const l of labels) {
    const start = [...capName(l)].slice(0, 30).join("");
    starts.set(start, [...(starts.get(start) ?? []), l]);
  }
  const list = [...starts.keys()];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const rows = (await db.selectFrom("assets").select("name").where((eb) => eb.or(chunk.map((s) => eb(sql`substr(name, 1, ${[...s].length})`, "=", s)))).execute()) as Array<{ name: string }>;
    for (const { name } of rows) {
      for (const s of chunk) {
        if (!name.startsWith(s)) continue;
        for (const l of starts.get(s)!) out.set(l, Math.max(out.get(l)!, numberAfter(l, name)));
      }
    }
  }
  return out;
}

/**
 * What the results of a job sent from no draft and for no clip are called before their number: the label it was given,
 * else the first words of its prompt (as a draft with no title is labelled). Empty when it has neither.
 */
export function jobLabel(label: string | null | undefined, recipe: { id: string; title?: string }, prompt?: string | null): string {
  return givenLabel(label, recipe.id, recipe.title) || firstWords(prompt ?? "");
}

/**
 * The names of `count` results of a job sent from no draft and for no clip, from the label it was given or the start of its
 * prompt: numbered on past the highest number already given after that label (so that one thrown away is not named again).
 * Empty when the label is only the recipe's title and there is no prompt.
 */
export async function labelNames(db: AnyDb, label: string | null | undefined, count: number, recipe: { id: string; title: string }, prompt?: string | null): Promise<string[]> {
  const given = jobLabel(label, recipe, prompt);
  if (!given) return [];
  const from = (await highestAfter(db, [given])).get(given) ?? 0;
  return Array.from({ length: count }, (_, i) => numbered(given, from + i + 1));
}

/** Names written many at a time: one statement per two hundred, and never over a name already there. */
async function writeNames(db: AnyDb, given: Map<string, string>): Promise<void> {
  const all = [...given];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const cases = sql.join(chunk.map(([id, name]) => sql`when ${id} then ${name}`), sql` `);
    await db.updateTable("assets").set({ name: sql`case id ${cases} end` }).where("id", "in", chunk.map(([id]) => id)).where("name", "=", "").execute();
  }
}

/**
 * Every nameless result of a job sent from no draft and for no clip, whose job is still in the queue's list: named
 * "<label> NN" after the label given to it, else after the first words of its prompt, numbered in the order they were
 * made, past the numbers that label already has. `recipeTitle` says a recipe's title (undefined when not known), to tell
 * a given label from the queue's own. Returns how many were named.
 */
export async function backfillLabelNames(db: AnyDb, recipeTitle: (id: string) => string | undefined): Promise<number> {
  const rows = (await db.selectFrom("assets").innerJoin("generations", "generations.id", "assets.generation_id")
    .innerJoin("jobs", "jobs.generation_id", "generations.id")
    .select(["assets.id as id", "jobs.label as label", "jobs.recipe_id as recipe_id", "generations.inputs as inputs"])
    .where("assets.name", "=", "").where("generations.draft_id", "is", null).where("jobs.draft_id", "is", null).where("jobs.clip_id", "is", null)
    .orderBy("assets.created_at").orderBy("assets.id").execute()) as Array<{ id: string; label: string; recipe_id: string; inputs: string }>;
  const promptIn = (inputs: string) => {
    try {
      return promptOf(JSON.parse(inputs) as Record<string, unknown>);
    } catch {
      return ""; // a record that cannot be read: named after its label only
    }
  };
  const labelled = rows.map((r) => ({ id: r.id, label: jobLabel(r.label, { id: r.recipe_id, title: recipeTitle(r.recipe_id) }, promptIn(r.inputs)) })).filter((r) => r.label);
  if (!labelled.length) return 0;
  const next = await highestAfter(db, [...new Set(labelled.map((r) => r.label))]);
  const given = new Map<string, string>();
  for (const r of labelled) {
    if (given.has(r.id)) continue;
    const n = next.get(r.label)! + 1;
    next.set(r.label, n);
    given.set(r.id, numbered(r.label, n));
  }
  await writeNames(db, given);
  return given.size;
}

/** What an item's name is worked out from when it says nothing (saysNothing): its row, as the assets table holds it. */
export type NamedRow = { id: string; name: string | null; kind: string; origin: string; generation_id: string | null; source_id: string | null; source_range: string | null };

const NAMED_COLUMNS = ["id", "name", "kind", "origin", "generation_id", "source_id", "source_range"] as const;

/**
 * The names these items are shown under when their own says nothing (saysNothing), worked out from where they came from,
 * as they would be named when made today: a take after its timeline, clip and take (a finished one after its draft); what
 * a draft made after the draft (without its number); a frame, a cut, a sound or a mirrored picture after the item it was
 * taken from, worked out the same way when that one has no name either. Nothing is written: an item that was named by
 * older code, or never, keeps its row as it is. Items with nothing to go on are left out. `recipeTitle` says a recipe's title.
 */
export async function shownNames(db: AnyDb, rows: NamedRow[], recipeTitle: (id: string) => string | undefined = recipeWords, depth = 0): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = rows.filter((r) => saysNothing(r.name));
  if (!wanted.length) return out;
  const ids = wanted.map((r) => r.id);

  // what each was taken from, by the name it goes by (its own, or worked out a few steps back)
  const sourceIds = [...new Set(wanted.map((r) => r.source_id).filter((id): id is string => Boolean(id)))];
  const sources = sourceIds.length ? ((await db.selectFrom("assets").select([...NAMED_COLUMNS]).where("id", "in", sourceIds).execute()) as NamedRow[]) : [];
  const sourceName = new Map(sources.filter((s) => !saysNothing(s.name)).map((s) => [s.id, s.name!.trim()]));
  if (depth < 3) for (const [id, name] of await shownNames(db, sources, recipeTitle, depth + 1)) sourceName.set(id, name);

  // the takes: as nameTake names them, a finish after its draft's name when that one says something
  const takeNames = new Map<string, string>();
  const takes = (await db.selectFrom("takes").select(["id", "clip_id", "asset_id", "finished_from"]).where("asset_id", "in", ids).orderBy("created_at").execute()) as TakeLine[];
  if (takes.length) {
    const { siblings, timelineOf, clipNo } = await contextOf(db, [...new Set(takes.map((t) => t.clip_id))]);
    const roots = [...new Set([...siblings.values()].flat().map((s) => s.asset_id))];
    const names = new Map(((await db.selectFrom("assets").select(["id", "name"]).where("id", "in", roots).execute()) as Array<{ id: string; name: string }>).map((a) => [a.id, saysNothing(a.name) ? "" : a.name]));
    const byTake = namesOfTakes(takes, siblings, clipNo, timelineOf, names);
    // a video on two clips (a clip copied) goes by the first it was placed on
    for (const t of takes) if (!takeNames.has(t.asset_id) && byTake.get(t.id)) takeNames.set(t.asset_id, byTake.get(t.id)!);
  }

  // what was rendered from a draft: the draft's label; from no draft, the label the job was given, else the start of its prompt
  const genNames = new Map<string, string>();
  const gens = [...new Set(wanted.map((r) => r.generation_id).filter((id): id is string => Boolean(id)))];
  if (gens.length) {
    const found = (await db.selectFrom("generations").leftJoin("drafts", "drafts.id", "generations.draft_id").leftJoin("jobs", "jobs.generation_id", "generations.id")
      .select(["generations.id as id", "generations.recipe_id as recipe_id", "generations.inputs as inputs", "drafts.id as draft", "drafts.name as draft_name", "drafts.title as title", "jobs.label as label"])
      .where("generations.id", "in", gens).execute()) as Array<{ id: string; recipe_id: string; inputs: string; draft: string | null; draft_name: string | null; title: string | null; label: string | null }>;
    const byGen = new Map<string, string>();
    for (const g of found) {
      if (byGen.has(g.id)) continue;
      let prompt = "";
      try {
        prompt = promptOf(JSON.parse(g.inputs) as Record<string, unknown>);
      } catch { /* a record that cannot be read: named without its prompt */ }
      const title = recipeTitle(g.recipe_id);
      const label = g.draft ? draftLabel({ name: g.draft_name, title: g.title, prompt, recipe: title ?? recipeWords(g.recipe_id) }) : jobLabel(g.label, { id: g.recipe_id, title }, prompt);
      if (label) byGen.set(g.id, label);
    }
    for (const r of wanted) if (r.generation_id && byGen.has(r.generation_id)) genNames.set(r.id, byGen.get(r.generation_id)!);
  }

  for (const r of wanted) {
    const src = r.source_id ? sourceName.get(r.source_id) : undefined;
    const old = (r.name ?? "").trim();
    const name =
      // an older "video · …" name: what it says after "video" holds (the range, the factor), said after the source's name, without the upscale route
      (src && old.startsWith("video · ") ? fromName(src, ` · ${old.slice("video · ".length).replace(/ \([^)]*\)$/, "")}`) : "")
      || takeNames.get(r.id) || genNames.get(r.id)
      || (src ? fromSource(r, src) : "");
    if (name) out.set(r.id, name);
  }
  return out;
}

/** A nameless item taken out of another, after that one's name: a frame, a sound, a mirrored picture, a range. */
function fromSource(r: NamedRow, source: string): string {
  if (r.origin === "frame") return frameName(source);
  if (r.kind === "audio") return soundName(source);
  if (r.origin === "edited") return fromName(source, ", mirrored");
  const [a, b] = (r.source_range ?? "").split("-").map(Number);
  return r.source_range && Number.isFinite(a) && Number.isFinite(b) ? fromName(source, ` · ${clockOf(a!)}–${clockOf(b!)}`) : "";
}

/** The name an item goes by, for what is made from it to be named after: its own when it says something, else one worked out from where it came from ("" when there is none). */
export async function nameOf(db: AnyDb, row: NamedRow): Promise<string> {
  if (!saysNothing(row.name)) return row.name!.trim();
  return (await shownNames(db, [row])).get(row.id) ?? "";
}
