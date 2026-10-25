import { expandWildcards, movedSeed, typedSeed, type InputSpec, type Recipe } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compose, lookSchema } from "./entities";
import { httpError, notFound } from "./errors";
import type { Services } from "./services";
import { draftLabel, promptOf } from "./autoName";
import { findDraft, writeDraft } from "./drafts";
import { paged } from "./queueView";
import { refusedSaid } from "./modelSetCheck";

/** The queue: jobs sent to it, models loaded ahead, and the queue's own controls (pause, order, retry, cancel, previews). */

const jobBody = z.strictObject({
  recipe: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  label: z.string().max(200).optional(),
  /** "Make 4 pictures": the same job this many times. Each draws its own seed when the seed is random. */
  count: z.number().int().min(1).max(8).default(1),
  /** A typed seed that moves: each copy takes the next seed up or down from the one sent (the form's "+1" / "−1"). */
  seedMode: z.enum(["up", "down"]).optional(),
  /** Who is in it and how it looks: worked into the form before it is queued. */
  look: lookSchema.optional(),
  /** The draft it is sent from, and the folder that is open: its results are filed there. */
  draft: z.string().max(64).optional(),
  folder: z.string().max(64).optional(),
  /** The machine it renders on (a Machine's id), pinned there; left out, whichever would end it first (Generate's machine slice). */
  machine: z.string().min(1).max(40).optional(),
});
/** A form as it stands, to load its models ahead or to ask whether they are loaded. */
/** A form whose models are loaded ahead: on the machine named (a Machine's id), else where its render would run. */
const warmBody = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()), look: lookSchema.optional(), machine: z.string().min(1).max(40).optional() });

/** A form's texts with their {a|b|c} choices settled. */
function settledTexts(recipe: Recipe<any>, input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const spec of recipe.inputs as InputSpec[]) if (spec.type === "prompt" && typeof out[spec.id] === "string") out[spec.id] = expandWildcards(out[spec.id] as string);
  return out;
}

/** What the cast changed in a form, as it was before (undefined: it was not there): the job keeps the person's own form with it. */
export function askedOf(own: Record<string, unknown>, composed: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(own), ...Object.keys(composed)])) {
    if (JSON.stringify(own[key]) !== JSON.stringify(composed[key])) changed[key] = own[key];
  }
  return changed;
}

export function registerJobs(app: FastifyInstance, s: Services): void {
  app.post("/api/jobs", async (req) => {
    const body = jobBody.parse(req.body);
    const recipe = s.registry.recipe(body.recipe);
    // a job pinned to a machine there is not would wait for ever
    if (body.machine && !(await s.machines()).some((m) => m.machine.id === body.machine)) throw httpError("there is no ComfyUI with that id");
    // a mix of files known to give black frames is refused before it is queued; the job checks again on the machine it runs on
    const found = await s.queue.setCheck(body.recipe, body.input);
    if (found.some((f) => f.black)) throw httpError(refusedSaid(found));
    const ids: string[] = [];
    const seed = typedSeed(body.input.seed);
    // sent from a blank draft: it is written now, so that what comes out is filed under it
    if (body.draft) await writeDraft(s.db, body.draft);
    // a job with no label of its own is said by the draft it came from ("Portrait done"), as its results are named
    // (autoName.ts), rather than by its recipe's title ("txt2img done"), which every draft on that model shares
    let label = body.label;
    if (!label?.trim() && body.draft && recipe) {
      const d = await findDraft(s.db, body.draft);
      const prompts = (recipe.inputs as InputSpec[]).filter((i) => i.type === "prompt" && !i.optional).map((i) => i.id);
      if (d) label = draftLabel({ name: d.name, title: d.title, prompt: promptOf(body.input, prompts), recipe: recipe.title });
    }
    for (let i = 0; i < body.count; i++) {
      // with a cast: each copy's {a|b} choices settled before it is worked in, so that what was asked and what renders pick the same
      const own = recipe && body.look ? settledTexts(recipe, body.input) : body.input;
      const input = recipe && body.look ? (await compose(s.db, recipe, own, body.look)).input : own;
      const each = body.seedMode && seed !== null ? { ...input, seed: movedSeed(seed, body.seedMode, i) } : input;
      ids.push(await s.queue.enqueue(body.recipe, each, { label, draft: body.draft, folder: body.folder, look: body.look, asked: input === own ? undefined : askedOf(own, input), machine: body.machine ?? null }));
    }
    return { ids };
  });

  /**
   * Load the models a form would render with, ahead of the render: a job in the queue like any other,
   * that makes nothing. Asked for while the prompt is still being written.
   */
  // the cast is worked in as for a render: a person with reference pictures can call for another model
  const withCast = async (body: z.infer<typeof warmBody>) => {
    const recipe = s.registry.recipe(body.recipe);
    return recipe && body.look ? (await compose(s.db, recipe, body.input, body.look).catch(() => null))?.input ?? body.input : body.input;
  };
  app.post("/api/jobs/warm", async (req) => {
    const body = warmBody.parse(req.body);
    // loading a model on a machine there is not would wait for ever, as a render pinned there would (/api/jobs)
    if (body.machine && !(await s.machines()).some((m) => m.machine.id === body.machine)) throw httpError("there is no ComfyUI with that id");
    return { id: await s.queue.enqueue(body.recipe, await withCast(body), { label: `Load the model: ${s.registry.recipe(body.recipe)?.title ?? body.recipe}`, warm: true, machine: body.machine ?? null }) };
  });

  /**
   * Whether a form's files go together (modelSetCheck.ts): what the form says under its fields, each finding by the field or
   * family file it is about. A warning lets the render go; one marked `black` is refused at Render.
   */
  app.post("/api/form/set-check", async (req) => {
    const body = warmBody.parse(req.body);
    return { findings: await s.queue.setCheck(body.recipe, await withCast(body)) };
  });

  /** Whether the models a form would render with are the ones ComfyUI was last asked to load. */
  app.post("/api/comfy/loaded", async (req) => {
    const body = warmBody.parse(req.body);
    const input = await withCast(body);
    // with several ComfyUIs, which of them holds it (`on`); `loaded` stays the first one's, as the screens that know one read it
    const [loaded, on] = await Promise.all([s.queue.isLoaded(body.recipe, input), s.queue.loadedOn(body.recipe, input)]);
    return { loaded, on };
  });

  // the first waiting jobs whole, the others in a few figures (queueView.ts paged); the whole rows of those a page at a time.
  // `have`: the hashes of the waiting rows the page holds, which are not sent again while they are unchanged
  app.get("/api/queue", async (req) => {
    const { have } = z.object({ have: z.string().max(200).optional() }).parse(req.query);
    return paged(await s.queue.status(), undefined, new Set(have?.split(",").filter(Boolean)));
  });
  app.get("/api/queue/waiting", async (req) => {
    const q = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const waiting = (await s.queue.statusRecent()).waiting;
    return { items: waiting.slice(q.offset, q.offset + q.limit), count: waiting.length };
  });
  /** The finished jobs with what they made: the queue's history, filtered and paged. */
  app.get("/api/jobs", async (req) => {
    const q = z.object({
      status: z.enum(["done", "failed", "cancelled"]).optional(),
      q: z.string().max(200).optional(),
      model: z.string().max(300).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      after: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      // these jobs only, by id (comma-separated): a box that follows its own, whatever else ran since
      ids: z.string().regex(/^[0-9a-f]{32}(,[0-9a-f]{32}){0,59}$/).optional(),
    }).parse(req.query);
    const { ids, ...rest } = q;
    return s.queue.history({ ...rest, ...(ids ? { ids: ids.split(",") } : {}) });
  });
  /** Pause or go on: all of them, or one machine on its own (`machine`, a machine's id), which finishes what it runs and takes nothing new. */
  const onMachine = z.strictObject({ machine: z.string().min(1).max(40).optional() });
  app.post("/api/queue/pause", async (req) => {
    await s.queue.setPaused(true, onMachine.parse(req.body ?? {}).machine);
    return paged(await s.queue.status());
  });
  app.post("/api/queue/resume", async (req) => {
    await s.queue.setPaused(false, onMachine.parse(req.body ?? {}).machine);
    return paged(await s.queue.status());
  });
  /** Every other machine paused, this one going: everything waiting goes to it. */
  app.post("/api/queue/use-only", async (req) => {
    await s.queue.useOnly(z.strictObject({ machine: z.string().min(1).max(40) }).parse(req.body).machine);
    return paged(await s.queue.status());
  });
  /** A waiting job pinned to a machine (dragged onto its lane, "Run on"), or back to whichever the queue picks (`machine: null`). */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/machine", async (req) => {
    const ok = await s.queue.pin(req.params.id, z.strictObject({ machine: z.string().min(1).max(40).nullable() }).parse(req.body).machine);
    if (!ok) throw httpError("only a waiting job can be moved to another machine");
    return paged(await s.queue.status());
  });

  /**
   * A waiting job's node packs: installed on the machine it waits on (Install and restart: ComfyUI restarts once nothing
   * renders there), or run without (its options done without, said on the job).
   */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/packs", async (req) => {
    const b = z.strictObject({ do: z.enum(["install", "without"]), packs: z.array(z.string().min(1).max(120)).min(1).max(12) }).parse(req.body);
    if (!(await s.queue.sayPacks(req.params.id, b.do, b.packs))) throw httpError("only a waiting job can be told what to do about its node packs");
    return paged(await s.queue.status());
  });

  /** Unload the models now (the GPU's memory is wanted for something else): on one machine, or on every one that is not rendering. */
  app.post("/api/comfy/free", async (req) => {
    await s.queue.freeMemory(onMachine.parse(req.body ?? {}).machine);
    return { ok: true };
  });

  /** The waiting jobs, in the order they should run. */
  app.post("/api/queue/order", async (req) => {
    await s.queue.reorder(z.strictObject({ ids: z.array(z.string()).max(500) }).parse(req.body).ids);
    return paged(await s.queue.status());
  });
  /** A finished job again, with some of its inputs changed when `input` is given. */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    const body = z.strictObject({ input: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    return { id: await s.queue.again(req.params.id, body.input) };
  });
  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    if (!(await s.queue.dismiss(req.params.id))) throw notFound("a finished job");
    return { ok: true };
  });

  /** Every waiting job cancelled in one request ("Cancel all waiting"); with `ids`, only those of them that still wait. The running job goes on. */
  app.post("/api/queue/cancel-waiting", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1).max(64)).max(500).optional() }).parse(req.body ?? {});
    return { cancelled: await s.queue.cancelWaiting(ids) };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    if (!(await s.queue.cancel(req.params.id))) throw notFound("a job to cancel");
    return { ok: true };
  });

  app.get<{ Params: { id: string; n: string } }>("/api/jobs/:id/stage/:n", async (req, reply) => {
    const p = await s.queue.stage(req.params.id, z.coerce.number().int().min(0).max(99).parse(req.params.n));
    if (!p) throw notFound("that stage");
    return reply.header("Content-Type", p.mime).header("Cache-Control", "no-store").send(Buffer.from(p.bytes));
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/preview", async (req, reply) => {
    const p = await s.queue.preview(req.params.id);
    if (!p) throw notFound("a preview");
    return reply.header("Content-Type", p.mime).header("Cache-Control", "no-store").send(Buffer.from(p.bytes));
  });
}
