import { fileKey, graphFiles, parseInput, type GraphFile, type InputSpec, type LoraValue } from "@afflatus/core";
import { now, type Db } from "./db";
import type { Services } from "./services";

/**
 * Which model files Afflatus's jobs used (Settings › Model files): from 0.8.2 each job's built graph, as it was sent to
 * ComfyUI, one row per file it loads (graphFiles: the same files a pod is sent for it); for the jobs from before, a
 * backfill from what was kept of them. Renders made straight in ComfyUI are never seen: the page says "not used by
 * Afflatus since", never "unused".
 */

/**
 * A use's file, by its folder and its name as ComfyUI lists it (its sub-folder too), lower case: two copies of a file in two
 * sub-folders are two files, each its own uses. (fileKey, a pod's and a preset's, leaves the sub-folder out.)
 */
export const usedKey = (f: { folder: string; file: string }) => `${f.folder}|${f.file.replace(/\\/g, "/").toLowerCase()}`;

/** The settings key that says the backfill was done (its value: when). */
const BACKFILLED = "modelUses.backfilled";
/** The generations read by the backfill in one page; a turn of the event loop between two of them. */
const PAGE = 200;

/** The hashes of these files as model_hashes has them now, by `folder|file`. */
async function hashesOf(db: Db, files: ReadonlyArray<{ folder: string; file: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const folders = [...new Set(files.map((f) => f.folder))];
  if (!folders.length) return out;
  const rows = await db.selectFrom("model_hashes").select(["folder", "file", "sha256"]).where("folder", "in", folders).execute();
  const wanted = new Set(files.map((f) => `${f.folder}|${f.file.replace(/\\/g, "/")}`));
  for (const r of rows) if (wanted.has(`${r.folder}|${r.file}`)) out.set(`${r.folder}|${r.file}`, r.sha256);
  return out;
}

/** The uses of one job (or one generation, `gen:<id>`), written once: a job submitted again after a restart is not counted twice. */
async function writeUses(db: Db, at: { job: string; generation: string | null; machine: string | null; at: string }, files: ReadonlyArray<{ folder: string; file: string; exact: boolean }>): Promise<void> {
  if (!files.length) return;
  const hashes = await hashesOf(db, files);
  for (const f of files) {
    await db
      .insertInto("model_uses")
      .values({
        job_id: at.job, folder: f.folder, file: f.file, name_key: usedKey(f), sha256: hashes.get(`${f.folder}|${f.file.replace(/\\/g, "/")}`) ?? null,
        generation_id: at.generation, machine_id: at.machine, exact: f.exact ? 1 : 0, used_at: at.at,
      })
      .onConflict((oc) => oc.columns(["job_id", "folder", "file"]).doNothing())
      .execute();
  }
}

/** What a job's built graph loads, noted as it is sent (queueSubmit.submit). Only a note: a write that fails never fails the job. */
export async function recordUses(db: Db, job: { id: string; machine_id?: string | null }, files: readonly GraphFile[]): Promise<void> {
  await writeUses(db, { job: job.id, generation: null, machine: job.machine_id ?? null, at: now() }, files.map((f) => ({ folder: f.folder, file: f.file, exact: true }))).catch((err: Error) => console.warn("[model uses]", err.message));
}

/** A job's uses told the generation it made: its takes are what was "made with" each of its files. */
export async function linkUses(db: Db, jobId: string, generationId: string): Promise<void> {
  await db.updateTable("model_uses").set({ generation_id: generationId }).where("job_id", "=", jobId).execute().catch((err: Error) => console.warn("[model uses]", err.message));
}

/** The model files a form chose itself (its model and LoRA inputs): what a backfill knows exactly. */
export function chosenFiles(inputs: readonly InputSpec[], input: Record<string, unknown>): Array<{ folder: string; file: string }> {
  const out: Array<{ folder: string; file: string }> = [];
  for (const spec of inputs) {
    const value = input[spec.id];
    if (spec.type === "model" && typeof value === "string" && value) out.push({ folder: spec.folder, file: value });
    if (spec.type === "loras" && Array.isArray(value)) for (const l of value as LoraValue[]) if (l?.file) out.push({ folder: "loras", file: l.file });
  }
  return out;
}

/**
 * The uses of the renders from before 0.8.2, read once: every generation (kept for good, unlike the jobs) not counted yet.
 * Its form's own model and LoRAs are exact; what else its graph loads (the text encoder, the VAE, an upscaler) is read from
 * the graph today's recipe builds of the same form, so it is marked approximate. Done in pages, in the background; not
 * started while ComfyUI does not answer (the graph needs its node list), tried again at the next start.
 */
export async function backfillUses(s: Pick<Services, "db" | "registry" | "queue" | "comfy">): Promise<number> {
  const done = await s.db.selectFrom("settings").select("value").where("key", "=", BACKFILLED).executeTakeFirst();
  if (done) return 0;
  const catalog = await (await s.comfy()).catalog().catch(() => null);
  if (!catalog) return 0;
  let n = 0;
  let after = { at: "", id: "" };
  for (;;) {
    const page = await s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "resolved", "created_at"])
      .where("created_at", ">=", after.at)
      .where((eb) => eb.or([eb("created_at", ">", after.at), eb("id", ">", after.id)]))
      .orderBy("created_at").orderBy("id").limit(PAGE).execute();
    if (!page.length) break;
    after = { at: page.at(-1)!.created_at, id: page.at(-1)!.id };
    const ids = page.map((g) => g.id);
    const counted = new Set((await s.db.selectFrom("model_uses").select("generation_id").where("generation_id", "in", ids).execute()).map((r) => r.generation_id));
    const jobs = new Map((await s.db.selectFrom("jobs").select(["id", "generation_id", "machine_id"]).where("generation_id", "in", ids).execute()).map((j) => [j.generation_id, j]));
    for (const g of page) {
      if (counted.has(g.id)) continue;
      const recipe = s.registry.recipe(g.recipe_id);
      if (!recipe) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(g.inputs) as Record<string, unknown>;
      } catch {
        continue;
      }
      let input: Record<string, unknown> = raw;
      try {
        input = parseInput(recipe, raw) as Record<string, unknown>;
      } catch {
        // a form of an older shape: what it says is still read as it was written
      }
      const chosen = chosenFiles(recipe.inputs as InputSpec[], input);
      const exact = new Set(chosen.map(fileKey));
      const seed = (JSON.parse(g.resolved || "{}") as { seed?: number }).seed;
      const built = await s.queue.builtOf(g.recipe_id, raw, { catalog, ...(typeof seed === "number" ? { seed } : {}) }).catch(() => null);
      const files = new Map(chosen.map((f) => [fileKey(f), { ...f, exact: true }]));
      for (const f of built ? graphFiles(built.graph) : []) if (!files.has(fileKey(f))) files.set(fileKey(f), { folder: f.folder, file: f.file, exact: exact.has(fileKey(f)) });
      const job = jobs.get(g.id);
      await writeUses(s.db, { job: job?.id ?? `gen:${g.id}`, generation: g.id, machine: job?.machine_id ?? null, at: g.created_at }, [...files.values()]);
      n++;
      await new Promise((go) => setImmediate(go));
    }
  }
  await s.db.insertInto("settings").values({ key: BACKFILLED, value: now(), updated_at: now() }).onConflict((oc) => oc.column("key").doUpdateSet({ value: now(), updated_at: now() })).execute();
  return n;
}

/** One file's uses, as Model files shows them. */
export interface Uses {
  /** Jobs that loaded it. */
  count: number;
  last: string | null;
  /** Some of them were counted by the backfill from today's recipe (≈). */
  approx: boolean;
  /** Uses by month ("2026-10" → n), the last twelve. */
  months: Record<string, number>;
  /** The generations that used it: what was made with it. */
  generations: string[];
}

/** The uses of a file, by its use key (usedKey) and its hash when it has one. */
export type UsesOf = (file: { key: string; sha256: string | null }) => Uses | null;

/**
 * Every file's uses. A use is its own file's, by the name it was used under; one whose file is no longer here (`present`:
 * the use keys of the files listed) is the file's of the same hash now (moved or renamed, the same bytes). `machines`: only
 * uses on these (null: anywhere). `since`: the first use kept, before which nothing is known.
 */
export async function readUses(db: Db, machines: readonly string[] | null, present: ReadonlySet<string>): Promise<{ usesOf: UsesOf; since: string | null }> {
  const rows = await db.selectFrom("model_uses").select(["name_key", "sha256", "generation_id", "machine_id", "exact", "used_at"]).execute();
  const byName = new Map<string, Uses>();
  const moved = new Map<string, Uses>();
  const add = (m: Map<string, Uses>, key: string, r: (typeof rows)[number]) => {
    let u = m.get(key);
    if (!u) m.set(key, (u = { count: 0, last: null, approx: false, months: {}, generations: [] }));
    u.count++;
    if (!u.last || r.used_at > u.last) u.last = r.used_at;
    if (!r.exact) u.approx = true;
    const month = r.used_at.slice(0, 7);
    u.months[month] = (u.months[month] ?? 0) + 1;
    if (r.generation_id && !u.generations.includes(r.generation_id)) u.generations.push(r.generation_id);
  };
  let since: string | null = null;
  for (const r of rows) {
    if (!since || r.used_at < since) since = r.used_at;
    // a backfilled use knows no machine: it counts here, where nearly every render was made before machines were kept
    if (machines && r.machine_id && !machines.includes(r.machine_id)) continue;
    if (present.has(r.name_key)) add(byName, r.name_key, r);
    else if (r.sha256) add(moved, r.sha256, r);
  }
  const merged = (a: Uses | undefined, b: Uses | undefined): Uses | null => {
    if (!a || !b) return a ?? b ?? null;
    const months = { ...a.months };
    for (const [m, n] of Object.entries(b.months)) months[m] = (months[m] ?? 0) + n;
    return { count: a.count + b.count, last: !a.last || (b.last && b.last > a.last) ? b.last : a.last, approx: a.approx || b.approx, months, generations: [...new Set([...a.generations, ...b.generations])] };
  };
  // the uses of a hash whose file moved go to one file of that hash only, the first asked: copies do not each get them
  const given = new Set<string>();
  return {
    usesOf: ({ key, sha256 }) => {
      const mine = byName.get(key);
      if (!sha256 || given.has(sha256)) return mine ?? null;
      given.add(sha256);
      return merged(mine, moved.get(sha256));
    },
    since,
  };
}
