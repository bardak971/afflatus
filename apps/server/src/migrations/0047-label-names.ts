import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

// what was sent from no draft with a label of its own (a batch from the API) and filed nameless before such renders were
// named: "<label> 01", "<label> 02"… in the order made. A label that is only its recipe's title (the queue's own) says
// nothing: such a render is named after the first words of its prompt instead, and one with no prompt stays nameless.
// The titles are the built-in recipes' as they were then (copied below, not read from @afflatus/recipes) and the imported
// workflows' as saved; the rules are copied below as autoName.ts held them then. A migration that ran must do the same on
// every database, whatever the app becomes.
const migration: Migration = {
  async up(db) {
    const titles = new Map(BUILT_IN_TITLES);
    for (const w of (await db.selectFrom("workflows").select(["id", "def"]).execute()) as Array<{ id: string; def: string }>) {
      try {
        const title = (JSON.parse(w.def) as { title?: unknown }).title;
        if (typeof title === "string") titles.set(w.id, title);
      } catch { /* a workflow that cannot be read: its id said in words still tells its title apart */ }
    }
    await backfillLabelNames(db, (id) => titles.get(id));
  },
  async down() {},
};
export default migration;

/** The built-in recipes' titles when this migration was written, by recipe id. */
const BUILT_IN_TITLES: Array<[string, string]> = [
  ["sdxl.text-to-picture", "txt2img"],
  ["sdxl.redraw", "img2img"],
  ["sdxl.paint-over", "Inpaint"],
  ["sdxl.outpaint", "Outpaint"],
  ["sdxl.sharper", "Upscale 2x"],
  ["sdxl.fix-face", "Face detailer"],
  ["klein.picture", "txt2img"],
  ["klein.edit", "Edit (instruction)"],
  ["klein.variation", "Variation"],
  ["klein.paint-over", "Inpaint"],
  ["klein.change-shape", "Outpaint"],
  ["klein.sharper", "Upscale 2x"],
  ["klein.fix-face", "Face detailer"],
  ["krea2.text-to-picture", "txt2img"],
  ["krea2.redraw", "img2img"],
  ["krea2.paint-over", "Inpaint"],
  ["krea2.sharper", "Upscale 2x"],
  ["krea2.fix-face", "Face detailer"],
  ["flux.text-to-picture", "txt2img"],
  ["flux.edit", "Edit"],
  ["flux.redraw", "img2img"],
  ["flux.paint-over", "Inpaint"],
  ["flux.outpaint", "Outpaint"],
  ["flux.sharper", "Upscale 2x"],
  ["flux.fix-face", "Face detailer"],
  ["qwen.text-to-picture", "txt2img"],
  ["qwen.edit", "Edit"],
  ["qwen.redraw", "img2img"],
  ["qwen.paint-over", "Inpaint"],
  ["qwen.outpaint", "Outpaint"],
  ["qwen.sharper", "Upscale 2x"],
  ["qwen.fix-face", "Face detailer"],
  ["qwen21.text-to-picture", "txt2img"],
  ["qwen21.edit", "Edit"],
  ["h3.video", "Video with audio"],
  ["wan.video", "Video"],
  ["ltx.video", "Video with audio"],
  ["tools.remove-background", "Remove background"],
  ["tools.seedvr-upscale", "Upscale (SeedVR2)"]
];

// ---------------------------------------------------------------- frozen: autoName.ts as it was when this migration was written

/** The longest name given here: a library tile shows far less, the rest is only read in full in a tooltip. */
const NAME_MAX = 80;

/** Cut to `max` characters at a word when one ends late enough, marked by an ellipsis. */
function capName(text: string, max = NAME_MAX): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:·–-]+$/, "")}…`;
}

/** The first few words of a prompt, without the punctuation a cut leaves at its end: short enough to stand before a number. */
function firstWords(text: string, words = 5, max = 40): string {
  const all = text.trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of all.slice(0, words)) {
    if (out && out.length + 1 + w.length > max) break;
    out = out ? `${out} ${w}` : w;
  }
  return capName(out, max).replace(/[,.;:·–-]+$/, "");
}

/** A recipe id said in words, for when its title is not at hand ("krea2.text-to-picture" → "Text to picture"). */
function recipeWords(id: string): string {
  const what = (id.split(".").pop() ?? id).replace(/[-_]+/g, " ").trim();
  return what ? what[0]!.toUpperCase() + what.slice(1) : id;
}

/** The n-th result of a draft: two digits at least, so that they sort (01 … 99, then 100). */
function numbered(label: string, n: number): string {
  const suffix = ` ${String(n).padStart(2, "0")}`;
  return `${capName(label, NAME_MAX - suffix.length)}${suffix}`;
}

type AnyDb = Kysely<any>;

/** The text of a form's prompt, as a generation's inputs hold it, for the label of a draft that has no title. */
function promptOf(inputs: Record<string, unknown>, promptIds: string[] = ["prompt"]): string {
  for (const id of promptIds) if (typeof inputs[id] === "string" && (inputs[id] as string).trim()) return inputs[id] as string;
  return "";
}

/**
 * The label a job was sent with, when someone gave it one: a job sent without one is labelled with its recipe's title
 * by the queue (queue.ts), which says nothing a name should. Empty when the label is that title, or the recipe id said in words.
 */
function givenLabel(label: string | null | undefined, recipeId: string, recipeTitle?: string): string {
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
function jobLabel(label: string | null | undefined, recipe: { id: string; title?: string }, prompt?: string | null): string {
  return givenLabel(label, recipe.id, recipe.title) || firstWords(prompt ?? "");
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
async function backfillLabelNames(db: AnyDb, recipeTitle: (id: string) => string | undefined): Promise<number> {
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
