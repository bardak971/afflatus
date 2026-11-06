import { GRID_AXES, gridAxes, gridJobs, parseInput, PROMPT_SR, randomSeed, usdFor, worstOf, type GridAxisValues, type GridJob, type InputSpec, type Recipe } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetLookup } from "./assets-api";
import { newId, now, OWNER, type Db } from "./db";
import { httpError, notFound } from "./errors";
import { lookSchema } from "./entities";
import { queueRender, type GridCellJob } from "./jobs-api";
import { cellsTotal, cellTimes, podsOf, type Prices } from "./podPrices";
import { runwayNeed } from "./rentedBilling";
import type { Services } from "./services";
import { gridSheet, makeThumb, readPicture } from "./thumbs";

/**
 * X/Y/Z grids (card #21): every combination of an axis's values rendered, each cell a job of its own through the queue as
 * Render sends one (caps, pods, an MCP token's limits all hold), tagged with the grid and its place on the board, so that a
 * failed cell fails alone. The board reads its cells back here and among the library's items (a list filtered by `grid`);
 * "Save as a picture" makes one labelled sheet of a page, as A1111's grid image.
 */

export const gridBody = z.strictObject({
  recipe: z.string().min(1),
  /** The whole form as Render would send it: each cell is it with its axes' values put in. */
  input: z.record(z.string(), z.unknown()),
  /** X, Y and Z, as typed (A1111's forms); an axis with no field is not used. */
  axes: z.array(z.strictObject({ field: z.string().max(600), values: z.string().max(4000) })).min(1).max(GRID_AXES.length),
  /** The lists the form offers by input id (a model's files, a sampler's names), for a typed value to be found in. */
  options: z.record(z.string(), z.array(z.string().max(600)).max(5000)).optional(),
  look: lookSchema.optional(),
  draft: z.string().max(64).optional(),
  folder: z.string().max(64).optional(),
  machine: z.string().min(1).max(40).optional(),
  /** One per click of Queue grid: the same grid sent again (a request replayed) is answered as it was, not queued twice. */
  key: z.string().min(8).max(64).optional(),
});

/** What the grid card asks to have priced: the grid as it would be queued, on the machine picked (none: Auto). */
export const planBody = gridBody.pick({ recipe: true, input: true, axes: true, options: true, machine: true });

/** A grid as the board reads it: its axes as said, where it came from, and each cell's job while the queue holds it. */
export interface GridView {
  id: string;
  draftId: string | null;
  recipe: string;
  axes: Array<{ field: string; label: string; labels: string[] }>;
  count: number;
  createdAt: string;
  /** By cell ("x.y.z"): its job, while the queue holds it (a job dismissed from it is gone; what it made stays in the library). */
  jobs: Record<string, { id: string; status: string; error: string | null }>;
}

/** A grid read on its form: its recipe, its axes worked out, and every cell's job (core gridJobs), with one seed for all. */
export interface GridRead {
  recipe: Recipe<any>;
  axes: GridAxisValues[];
  jobs: GridJob[];
}

/**
 * A grid's axes read on the form and its cells made, a seed the form draws anew drawn once here for every cell: what is
 * priced (planGrid, MCP render_grid's cap) and what is queued are these same cells.
 */
export function readGrid(s: Services, body: Pick<z.output<typeof gridBody>, "recipe" | "input" | "axes" | "options">): GridRead {
  const recipe = s.registry.recipe(body.recipe);
  if (!recipe) throw notFound("this model");
  if (recipe.output !== "image") throw httpError("a grid is made of pictures: this model makes another kind of thing");
  // the form as the queue will take it, before any cell is made of it: its prompts within their limit, its values readable
  parseInput(recipe, body.input);
  const specs = recipe.inputs as InputSpec[];
  const read = gridAxes(specs, body.input, { axes: body.axes }, body.options);
  if ("error" in read) throw httpError(`${GRID_AXES[read.axis] ?? "X"}: ${read.error}`);
  if (!read.axes.length) throw httpError("a grid needs at least one axis with values");
  return { recipe, axes: read.axes, jobs: gridJobs(specs, body.input, read.axes, randomSeed()) };
}

/**
 * A grid queued: its cells (readGrid, or those the caller priced), the grid written and every cell queued, or none (a
 * refusal of one refuses the grid, and its row goes).
 */
export async function queueGrid(s: Services, body: z.output<typeof gridBody>, by: { mcpToken?: string } = {}, read: GridRead = readGrid(s, body)): Promise<{ id: string; count: number; jobs: string[] }> {
  const { recipe } = read;
  const id = newId();
  const cells: GridCellJob[] = read.jobs.map((j) => ({ input: j.input, label: j.label, grid: { id, cell: j.key } }));
  await s.db.insertInto("grids").values({ id, owner_id: OWNER, draft_id: body.draft ?? null, recipe_id: recipe.id, axes: JSON.stringify(read.axes.map(said)), count: cells.length, created_at: now() }).execute();
  try {
    const jobs = await queueRender(s, { recipe: body.recipe, input: body.input, count: 1, look: body.look, draft: body.draft, folder: body.folder, machine: body.machine }, by, cells);
    return { id, count: cells.length, jobs };
  } catch (err) {
    await s.db.deleteFrom("grids").where("id", "=", id).execute();
    throw err;
  }
}

/** What a grid will take, as its card says it and its ask weighs it (planGrid). */
export interface GridPlanView {
  count: number;
  /** All of it on the machine picked, else as the queue shares it between its machines (Auto); null when a cell is not known. */
  ms: number | null;
  /**
   * On the rented pods it may go to, at worst (the dearest, the slowest): null when none may take it. `usd` is the plain
   * forecast, said on the card; `most` what it may cost with each unsure cell counted half again (rentedBilling.ts
   * runwayNeed), the figure an MCP token's render_grid is held to (mcpRender.ts gridCostOn) and the one the card asks on.
   */
  pod: { ms: number | null; usd: number | null; most: number | null } | null;
}

/**
 * What a grid will take before it is queued, each cell priced at its own settings (podPrices.ts cellTimes, the figure MCP's
 * render_grid is held to): the time on the machine picked or on Auto, and on the rented pods it may go to, the money at
 * their rates. On Auto every pod set up counts, a stopped one too: a grid queued while it is stopped runs there once it is
 * started. A money path: a pod whose rate or a cell whose time is not known says null, which the card asks about.
 */
export async function planGrid(s: Services, body: z.output<typeof planBody>): Promise<GridPlanView> {
  const read = readGrid(s, body);
  const inputs = read.jobs.map((j) => j.input);
  const machines = (await s.machines()).map((m) => m.machine);
  const prices: Prices = new Map();
  const picked = body.machine ? machines.find((m) => m.id === body.machine) : undefined;
  const ms = picked
    ? cellsTotal(await cellTimes(s, read.recipe.id, inputs, picked.id, prices))
    : (await s.queue.total(inputs.map((input) => ({ recipe: read.recipe.id, input }))).catch(() => ({ ms: null }))).ms;
  const pods = (picked ? [picked] : machines).filter((m) => m.rented);
  if (!pods.length) return { count: read.jobs.length, ms, pod: null };
  const rates = podsOf(s, pods);
  const each = await Promise.all(pods.map(async (p) => {
    const times = await cellTimes(s, read.recipe.id, inputs, p.id, prices);
    const t = cellsTotal(times);
    const rate = rates.get(p.id)?.rate;
    if (t === null || rate === null || rate === undefined) return { ms: t, usd: null, most: null };
    // a cell with no forecast at all leaves it unknown here (the card asks), where MCP prices it at runwayNeed's floor
    return { ms: t, usd: usdFor(t, rate), most: usdFor(times.reduce((n, c) => n + runwayNeed({ renderMs: c.ms, fetchMs: 0, sure: c.sure }), 0), rate) };
  }));
  // said at its worst: an amount not known on any of them is not known
  return { count: read.jobs.length, ms, pod: { ms: worstOf(each.map((e) => e.ms)), usd: worstOf(each.map((e) => e.usd)), most: worstOf(each.map((e) => e.most)) } };
}

/**
 * The grids queued by key, a while: a request replayed (a network retry, a double send) gets the grid it queued rather
 * than up to GRID_MOST renders more. Kept ten minutes, which outlasts any retry.
 */
const KEPT_MS = 10 * 60_000;
type Queued = { id: string; count: number; jobs: string[] };
const queuedByKey = new Map<string, { at: number; got: Promise<Queued> }>();
function onceByKey(key: string | undefined, run: () => Promise<Queued>): Promise<Queued> {
  if (!key) return run();
  const at = Date.now();
  for (const [k, v] of queuedByKey) if (at - v.at > KEPT_MS) queuedByKey.delete(k);
  const had = queuedByKey.get(key);
  if (had) return had.got;
  const got = run();
  queuedByKey.set(key, { at, got });
  // a grid refused may be sent again once what refused it is fixed
  got.catch(() => queuedByKey.delete(key));
  return got;
}

/** An axis as the board says it: its setting, its name and its values' labels (not the values, which the cells keep). */
const said = (a: GridAxisValues) => ({ field: a.field, label: a.label, labels: a.labels });

/** A grid with its cells' jobs; null when there is none of that id. */
export async function gridView(db: Db, id: string): Promise<GridView | null> {
  const g = await db.selectFrom("grids").selectAll().where("id", "=", id).executeTakeFirst();
  if (!g) return null;
  const rows = await db.selectFrom("jobs").select(["id", "status", "error", "grid_cell", "created_at"]).where("grid_id", "=", id).orderBy("created_at").execute();
  // a cell done again (Retry) is two jobs: the later one says where it stands
  const jobs: GridView["jobs"] = {};
  for (const r of rows) if (r.grid_cell) jobs[r.grid_cell] = { id: r.id, status: r.status, error: r.error };
  return { id: g.id, draftId: g.draft_id, recipe: g.recipe_id, axes: JSON.parse(g.axes) as GridView["axes"], count: g.count, createdAt: g.created_at, jobs };
}

/** A value as a sheet heads its column or row: "Steps 20", a Prompt S/R value alone (its words are the label). */
const valueSaid = (axis: { field: string; label: string }, value: string) => (axis.field === PROMPT_SR ? value : `${axis.label} ${value}`);

/** The widest a sheet is made, and a cell in it at most: a 10-column grid of 1024 px pictures stays a picture one can open. */
const SHEET_WIDTH = 4096;
const SHEET_CELL = 1024;

export function registerGrids(app: FastifyInstance, s: Services): void {
  const lookup = assetLookup(s);
  app.post("/api/grids", async (req) => {
    const body = gridBody.parse(req.body);
    return onceByKey(body.key, () => queueGrid(s, body));
  });

  /** What a grid will take before it is queued, each cell at its own settings (planGrid): the card's figure and its ask. */
  app.post("/api/grids/plan", async (req) => planGrid(s, planBody.parse(req.body)));

  /** A draft's grids, the newest first: the board opens on the last one, and the draft column shows them. */
  app.get("/api/grids", async (req) => {
    const { draft } = z.object({ draft: z.string().max(64) }).parse(req.query);
    const rows = await s.db.selectFrom("grids").select(["id", "axes", "count", "created_at"]).where("draft_id", "=", draft).orderBy("created_at", "desc").limit(20).execute();
    return { items: rows.map((r) => ({ id: r.id, axes: (JSON.parse(r.axes) as GridView["axes"]).map((a) => a.label).filter(Boolean), count: r.count, createdAt: r.created_at })) };
  });

  app.get<{ Params: { id: string } }>("/api/grids/:id", async (req) => (await gridView(s.db, req.params.id)) ?? Promise.reject(notFound("this grid")));

  /**
   * One page of a grid (`z`) as a labelled sheet, saved as a new picture beside its first cell, kept: what A1111's grid
   * image is. The cells binned or not made are left blank in their place.
   */
  app.post<{ Params: { id: string } }>("/api/grids/:id/sheet", async (req) => {
    const { z: page } = z.strictObject({ z: z.number().int().min(0).default(0) }).parse(req.body ?? {});
    const g = await gridView(s.db, req.params.id);
    if (!g) throw notFound("this grid");
    const cells = (await s.db.selectFrom("assets").selectAll().where("grid_id", "=", g.id).where("deleted_at", "is", null).where("kind", "=", "image").orderBy("created_at").execute())
      .map((a) => ({ a, at: (a.grid_cell ?? "0.0.0").split(".").map(Number) }))
      .filter((c) => (c.at[2] ?? 0) === page);
    if (!cells.length) throw httpError("no picture of this page is left to put on a sheet");
    // an axis kept only for its place (Y left empty under a Z) heads nothing
    const [x, y, zAxis] = [g.axes[0], g.axes[1], g.axes[2]].map((a) => (a?.field ? a : undefined));
    const cols = x?.labels ?? g.axes[0]?.labels ?? [""];
    const rows = y?.labels ?? g.axes[1]?.labels ?? [""];
    const first = cells[0]!.a;
    const width = Math.min(SHEET_CELL, first.width ?? SHEET_CELL, Math.floor(SHEET_WIDTH / Math.max(1, cols.length)));
    const height = Math.round(width * ((first.height ?? width) / (first.width ?? width)));
    const title = [g.axes.slice(0, 2).map((a) => a.label).filter(Boolean).join(" × "), zAxis ? `${zAxis.label}: ${zAxis.labels[page] ?? ""}` : ""].filter(Boolean).join(" · ");
    const bytes = await gridSheet({
      title, cols: x ? cols.map((c) => valueSaid(x, c)) : cols, rows: y ? rows.map((r) => valueSaid(y, r)) : rows, cell: { width, height },
      cells: await Promise.all(cells.map(async (c) => ({ x: c.at[0] ?? 0, y: c.at[1] ?? 0, bytes: await s.storage.get(c.a.file_key).catch(() => null) }))),
    });
    if (!bytes) throw httpError("the sheet could not be made: the image library did not load on this machine");
    const size = await readPicture(bytes);
    return lookup.addBeside(first, { bytes, ext: "png", thumb: await makeThumb(bytes) }, {
      kind: "image", origin: "edited", name: `Grid · ${title}`.slice(0, 200), mime: "image/png", width: size?.width ?? null, height: size?.height ?? null, duration_ms: null, fps: null, has_sound: 0,
    });
  });
}
