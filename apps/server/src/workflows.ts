import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelIndex } from "./comfy";
import { httpError } from "./errors";
import { ComfyUnreachable } from "@afflatus/comfy";
import { isRef, type Graph } from "@afflatus/core";
import { bindings, fromEditor, graph as graphSchema, inspect, isEditorFormat, slug, toEditor, wiring as wiringSchema, workflowDef, type Bindings, type WorkflowDef } from "@afflatus/workflows";
import type { Services } from "./services";
import { openInComfy } from "./comfyOpen";

/**
 * Importing a ComfyUI workflow: read it, show what was found, save it with the mapping the user
 * confirmed. From then on it is a recipe like any other.
 */

const saveBody = z.strictObject({
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(60),
  source: z.string().max(200).default(""),
  graph: graphSchema,
  wiring: wiringSchema.optional(),
  editor: z.unknown().optional(),
  bindings,
});

/** A workflow Afflatus already holds (saved, or shared as a file): its nodes, and what its editor file knew. */
const heldBody = z.object({ graph: graphSchema, wiring: wiringSchema.optional() });


/** An exported workflow: nodes by id, each with its type and inputs. */
function mustBeWorkflow(body: unknown): Graph {
  const parsed = graphSchema.safeParse(body);
  if (!parsed.success || !Object.keys(parsed.data).length) throw httpError("This does not look like a ComfyUI workflow. Use the file ComfyUI saves, or one saved with Export (API).");
  return parsed.data as Graph;
}

/** Every place the mapping points at must exist in the workflow. */
function checkBindings(graph: Graph, b: Bindings): void {
  const at = (what: string, t: { node: string; input: string } | undefined) => {
    if (t && !(t.input in (graph[t.node]?.inputs ?? {}))) throw httpError(`${what} points at node ${t.node}, input "${t.input}", which is not in the workflow`);
  };
  at("The prompt", b.prompt);
  at("The negative prompt", b.negative);
  b.seeds.forEach((s) => at("A seed", s));
  at("The width", b.size?.width);
  at("The height", b.size?.height);
  at("The length", b.length?.target);
  at("The opening picture", b.startImage?.target);
  at("The ending picture", b.endImage?.target);
  b.controls.forEach((c) => at(`The control "${c.label}"`, c.target));
  if (!graph[b.result.node]) throw httpError(`the result points at node ${b.result.node}, which is not in the workflow`);
  for (const p of b.loras) if (!graph[p.node]) throw httpError(`LoRAs point at node ${p.node}, which is not in the workflow`);
  for (const t of b.toggles) for (const e of t.effects) for (const n of e.nodes) if (!graph[n]) throw httpError(`the switch "${t.label}" points at node ${n}, which is not in the workflow`);
  for (const c of b.controls) if (isRef(graph[c.target.node]!.inputs[c.target.input])) throw httpError(`the control "${c.label}" points at an input that is linked, not typed in`);
  const ids = [...b.controls.map((c) => c.id), ...b.toggles.map((t) => t.id)];
  if (new Set(ids).size !== ids.length) throw httpError("two controls have the same id");
}

const brief = (d: WorkflowDef) => ({ id: d.id, title: d.title, model: d.model, source: d.source, output: d.bindings.result.kind, nodes: Object.keys(d.graph).length });

export function registerWorkflows(app: FastifyInstance, s: Services): void {
  /**
   * What Afflatus finds in a workflow, before anything is saved. Takes the file ComfyUI's editor saves, a
   * workflow saved with Export (API), or one Afflatus already holds. Reads ComfyUI's node list, nothing else.
   * The answer carries the workflow in the form Afflatus keeps: that is what gets saved.
   */
  app.post("/api/workflows/inspect", async (req) => {
    const body = req.body;
    // what the file is gets settled first: a file that is no workflow is refused without asking ComfyUI
    const fromFile = isEditorFormat(body);
    const held = !fromFile && body && typeof body === "object" && "graph" in body ? heldBody.safeParse(body) : null;
    const exported = fromFile || held?.success ? null : mustBeWorkflow(body);
    let catalog;
    try {
      catalog = await (await s.comfy()).catalog();
    } catch (err) {
      if (err instanceof ComfyUnreachable) throw httpError("ComfyUI has to be running to read a workflow: its node list says what each setting is.", 503);
      throw err;
    }
    /** For each file that is missing: the other model folders of ComfyUI that hold a file of that name. */
    const withElsewhere = async <T extends ReturnType<typeof inspect>>(found: T) => {
      if (!found.missingFiles.length) return { ...found, elsewhere: {} as Record<string, string[]> };
      const index = await modelIndex(await s.comfy());
      const elsewhere: Record<string, string[]> = {};
      for (const m of found.missingFiles) {
        const hits = index.find(m.file).map((hit) => hit.folder);
        if (hits.length) elsewhere[m.file] = hits;
      }
      return { ...found, elsewhere };
    };
    if (fromFile) {
      const read = fromEditor(body, catalog);
      if (!Object.keys(read.graph).length) throw httpError("No node that ComfyUI can run was found in this file.");
      return { ...(await withElsewhere(inspect(read.graph, catalog, read.wiring, read.notes))), graph: read.graph, wiring: read.wiring, editor: body };
    }
    if (held?.success) return { ...(await withElsewhere(inspect(held.data.graph as Graph, catalog, held.data.wiring))), graph: held.data.graph, wiring: held.data.wiring };
    return { ...(await withElsewhere(inspect(exported!, catalog))), graph: exported };
  });

  app.get("/api/workflows", async () => ({ items: s.registry.workflows().map(brief) }));

  /** The whole thing: for editing, and for sharing as a file. */
  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    const def = s.registry.workflow(req.params.id);
    if (!def) throw httpError("this workflow was not found", 404);
    return def;
  });

  app.post("/api/workflows", async (req) => {
    const body = saveBody.parse(req.body);
    checkBindings(body.graph as Graph, body.bindings);
    // the id comes from the title and stays: generations and drafts refer to it
    const base = `workflow.${slug(body.title)}`;
    let id = base;
    for (let n = 2; s.registry.recipe(id); n++) id = `${base}-${n}`;
    const def = workflowDef.parse({ id, ...body });
    await s.registry.save(def);
    return brief(def);
  });

  app.put<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    const current = s.registry.workflow(req.params.id);
    if (!current) throw httpError("this workflow was not found", 404);
    const body = saveBody.parse(req.body);
    checkBindings(body.graph as Graph, body.bindings);
    const def = workflowDef.parse({ id: current.id, ...body });
    await s.registry.save(def);
    return brief(def);
  });

  /**
   * Show the workflow in ComfyUI's editor (see comfyOpen.ts for how): the editor's own file when the
   * import kept it, else the graph Afflatus runs written as the editor writes a file.
   */
  app.post<{ Params: { id: string } }>("/api/workflows/:id/open", async (req) => {
    const def = s.registry.workflow(req.params.id);
    if (!def) throw httpError("this workflow was not found", 404);
    const comfy = await s.comfy();
    let file = def.editor;
    if (!file) {
      const titles = Object.fromEntries(Object.entries(def.graph).flatMap(([id, n]) => (typeof n._meta === "object" && n._meta && typeof (n._meta as { title?: unknown }).title === "string" ? [[id, (n._meta as { title: string }).title]] : [])));
      file = toEditor(def.graph as Graph, await comfy.catalog(), { titles });
    }
    return openInComfy(s, def.id.replace(/^workflow\./, ""), def.title, file);
  });

  /** What was made with it stays in the library; drafts on it stay too, and say the workflow is gone. */
  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    if (!(await s.registry.remove(req.params.id))) throw httpError("this workflow was not found", 404);
    return { ok: true };
  });
}
