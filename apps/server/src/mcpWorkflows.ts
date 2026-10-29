import { plural, type InputSpec, type Recipe } from "@afflatus/core";
import { guessModel, type Bindings, type Inspection } from "@afflatus/workflows";
import { z } from "zod";
import { itemEmbedded } from "./embedded-api";
import { readEmbedded } from "./embedded";
import { httpError } from "./errors";
import { seen, shownInputs } from "./mcpForms";
import { renderForm } from "./mcpRender";
import { tool } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { assertPublicUrl, fetchPublic } from "./outbound";
import { waitingWords } from "./registry";
import type { Services } from "./services";
import { reachOf } from "./workflowReach";
import { createWorkflow, inspectWorkflow, listed, saveWorkflow } from "./workflows";

/**
 * Imported ComfyUI workflows, from outside (MCP): listed, imported, run. An import goes through the web's own two steps
 * (workflows.ts inspectWorkflow, then createWorkflow with its checks and its build), with the mapping the web's import
 * starts from (what inspect suggests, or the one a workflow shared from another Afflatus carries) unless the agent says
 * otherwise. A saved workflow is a form like any other (`workflow.<slug>`): run_workflow is the render tool's own path
 * (mcpRender.ts renderForm), with its money rules: a token without Spend never lands on a rented pod.
 *
 * Installing a node pack or a model stays in Afflatus (Workflows, Settings › Models): what is missing is said, not fetched.
 */

/** The most a workflow file may weigh, fetched or pasted: the largest editor files are a few MB, a picture carrying one a little more. */
const WORKFLOW_MAX_BYTES = 16 * 2 ** 20;

/** An input as these tools list it: describe_form says the rest (its "?" note, options, range, presets). */
const inputBrief = (i: InputSpec) => ({ id: i.id, type: i.type, label: i.label, ...(i.advanced ? { advanced: true } : {}) });

const listWorkflows = tool({
  name: "list_workflows",
  scope: "look",
  title: "Workflows",
  description: "The ComfyUI workflows the user imported (Studio › Workflows), as that page lists them: each one's form id (workflow.<slug>, what run_workflow, describe_form, new_draft and render take), title, model, the file it came from, what it makes, how many nodes, whether a machine has what it needs, and its inputs by id. One that cannot be built any more says why (problem). One an agent imported that the user has not approved yet says so (waiting: the token's name, and its nodes that read or write a path or fetch an address); it renders once the user approves it in Afflatus. describe_form gives an input in full.",
  async run(_args, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    const items = s.registry.workflows().map((d) => {
      const recipe: Recipe<any> | undefined = s.registry.recipe(d.id);
      return {
        ...listed(s, d),
        ready: at.machines.some((m) => m.scan?.recipes.find((r) => r.id === d.id)?.ready),
        inputs: recipe ? shownInputs(recipe).map(inputBrief) : [],
      };
    });
    ctx.said(`Listed the workflows: ${plural(items.length, "workflow")}`);
    return { workflows: items };
  },
});

/** A workflow file's bytes, from a public https address, held to WORKFLOW_MAX_BYTES as they come. */
async function fetchWorkflow(asked: string): Promise<Uint8Array> {
  const url = assertPublicUrl(asked);
  // plain http could be answered by anyone on the way, and what comes back is run on the user's machines
  if (url.protocol !== "https:") throw httpError("Only https addresses are fetched for a workflow.");
  const res = await fetchPublic(url.href, { headers: { "User-Agent": "afflatus", Accept: "application/json,image/*,video/*,*/*" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw httpError(`${url.hostname} answered ${res.status}: nothing was imported.`, 502);
  }
  const tooLarge = () => httpError(`This file is larger than ${WORKFLOW_MAX_BYTES / 2 ** 20} MB, the most a workflow file takes.`, 413);
  if (Number(res.headers.get("content-length") ?? 0) > WORKFLOW_MAX_BYTES) {
    await res.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const parts: Uint8Array[] = [];
  let bytes = 0;
  // counted as it comes: an address that says no length (or a wrong one) is held to the most all the same
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > WORKFLOW_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      throw tooLarge();
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** The workflow in a file's bytes: its JSON, else the one a picture or a video ComfyUI saved carries. */
async function workflowInBytes(bytes: Uint8Array): Promise<unknown> {
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      throw httpError("This file could not be parsed as JSON. A workflow is a .json file, or a picture or video ComfyUI saved with its workflow inside.");
    }
  }
  const { workflow } = await readEmbedded(bytes);
  if (!workflow) throw httpError("This file carries no workflow: it is no .json, and no picture or video ComfyUI saved with its workflow inside.");
  return workflow;
}

/** The name a workflow from a file or an address starts with, as the web's import gives it: its file name, without ".json" and " (API)". */
const titleOf = (name: string) => name.replace(/\.(json|png|jpe?g|webp|mp4|webm|mov|m4v|mkv)$/i, "").replace(/\s*\(API\)$/i, "").trim().slice(0, 120);

/** A workflow shared from another Afflatus: the graph with its mapping already made (Workflows' Export). */
type Shared = { graph: unknown; wiring?: unknown; bindings: unknown; title?: unknown; model?: unknown };
const sharedOf = (json: unknown): Shared | null => (json && typeof json === "object" && "graph" in json && "bindings" in json ? (json as Shared) : null);

/** Why a workflow has no output to map, as the web's import says it: the missing node types first, they are the news. */
function noOutput(found: Inspection): Error {
  const missing = found.missingNodes;
  if (missing.length) {
    const packs = [...new Set(Object.values(found.packs))];
    const some = missing.slice(0, 4).join(", ") + (missing.length > 4 ? ` and ${missing.length - 4} more` : "");
    return httpError(`This ComfyUI is missing ${plural(missing.length, "node type")} this workflow uses (${some})${packs.length ? `, from ${packs.join(", ")}` : ""}. Install ${packs.length > 1 ? "those packs" : "the pack"} (Studio › Workflows in Afflatus, or ComfyUI-Manager's "Install missing custom nodes"), restart ComfyUI, then import again.`);
  }
  return httpError("This workflow has no output: no Save or Preview node for an image, a video or audio.");
}

const importWorkflow = tool({
  name: "import_workflow",
  scope: "make",
  title: "Import a workflow",
  description: "A ComfyUI workflow made into a form of Afflatus, as Studio › Workflows imports one: from its JSON (the file ComfyUI's editor saves, one saved with Export (API), or one shared from another Afflatus), from a public https address (a .json, or a picture or video ComfyUI saved with its workflow inside; at most 16 MB), or from a picture or video of the library that carries one. It is read against ComfyUI's node list, then kept with the mapping the import would start from (the prompt, seeds, size, length, pictures, LoRAs, switches and controls inspect suggests; a shared one keeps its own), unless `bindings` changes parts of it. Answers the new form's id (run_workflow and render take it), its inputs, the other settings that could be controls (addControls), and what is missing on this ComfyUI: node types and the packs they come from, model files (with where else they are, and where to get them when known), choices it lacks. Installing those stays in Afflatus. A workflow runs its nodes' code on the user's machines: import only what the user asked for. It waits for the user's approval (Studio › Workflows › Approve, in Afflatus) before it renders; the answer lists its nodes that read or write a path or fetch an address (reaches), which the user sees there too.",
  input: {
    json: z.string().max(WORKFLOW_MAX_BYTES).optional().describe("The workflow's JSON as text."),
    url: z.string().trim().url().max(2000).optional().describe("Or a public https address of the file."),
    item: z.string().min(1).optional().describe("Or a library item's id (search_library): a picture or video ComfyUI saved with its workflow inside."),
    title: z.string().trim().min(1).max(120).optional().describe("Its name (the form's id comes from it); left out: the shared one's, else the file's name."),
    model: z.string().trim().min(1).max(60).optional().describe("The model it runs, which groups it with its family in Create (\"Wan 2.2\"); left out: the shared one's, else guessed from its loaders and files."),
    bindings: z.record(z.string(), z.unknown()).optional().describe("Parts of the mapping to use instead of the suggested ones, by key (prompt, negative, seeds, size, length, startImage, endImage, loras, toggles, controls, result, skip, sections): each key given replaces that part whole, null leaves it out."),
    addControls: z.array(z.string().min(1)).max(100).optional().describe("Ids of other settings to put on the form too, from a previous import's moreControls (or inspect's candidates)."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const given = [a.json, a.url, a.item].filter((x) => x !== undefined).length;
    if (given !== 1) throw refusal("Give the workflow one way: json, url or item.");
    let json: unknown;
    let name = "";
    let from = "";
    if (a.json !== undefined) {
      json = await workflowInBytes(Buffer.from(a.json, "utf8"));
    } else if (a.url !== undefined) {
      const url = new URL(a.url);
      json = await workflowInBytes(await fetchWorkflow(a.url));
      name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
      from = url.hostname;
    } else {
      const row = await s.db.selectFrom("assets").select(["name", "kind"]).where("id", "=", a.item!).where("deleted_at", "is", null).executeTakeFirst();
      if (!row) throw httpError("There is no such item in the library: search_library gives the ids.", 404);
      const { workflow } = await itemEmbedded(s, a.item!);
      if (!workflow) throw httpError(`This ${row.kind === "video" ? "video" : row.kind === "image" ? "picture" : "item"} carries no workflow. ComfyUI writes one into what it saves; a file from elsewhere has none.`);
      json = workflow;
      name = row.name;
    }
    const shared = sharedOf(json);
    // the web's import, step 1: read against ComfyUI's node list, the workflow answered in the form Afflatus keeps
    const found = await inspectWorkflow(s, shared ? { graph: shared.graph, wiring: shared.wiring } : json);
    const start = (shared?.bindings as Bindings | undefined) ?? found.suggested;
    if (!start) throw noOutput(found);
    const candidates = found.candidates as Inspection["candidates"];
    const added = (a.addControls ?? []).map((id) => {
      const c = candidates.find((x) => x.id === id);
      if (!c) throw httpError(`There is no setting “${id}” to put on the form: moreControls lists them.`);
      const { classType: _c, title: _t, suggested: _s, byAuthor: _a, off: _o, offers: _f, ...control } = c;
      return control;
    });
    const bindings = { ...start } as Bindings & Record<string, unknown>;
    // a part set to null is left out (no negative prompt on the form, say), as unticking it in the web's mapping does
    for (const [key, value] of Object.entries(a.bindings ?? {})) {
      if (value === null) delete bindings[key];
      else bindings[key] = value;
    }
    if (added.length) bindings.controls = [...(bindings.controls ?? []).filter((c) => !added.some((x) => x.id === c.id)), ...added];
    const title = a.title ?? (typeof shared?.title === "string" ? shared.title : titleOf(name));
    if (!title) throw refusal("Name it (title): nothing in the workflow says what it is called.");
    const model = a.model ?? (typeof shared?.model === "string" ? shared.model : guessModel(found.graph as Parameters<typeof guessModel>[0]));
    if (!model) throw refusal("Name the model it runs (model): nothing in the workflow says.");
    // the web's import, step 2: kept as mapped, with the same checks and the same build
    // kept waiting for the user's approval: it runs code on their machines, and an agent may have been steered by what it read
    const saved = await createWorkflow(s, { title, model, source: (name || from).slice(0, 200), graph: found.graph, wiring: "wiring" in found ? found.wiring : undefined, editor: "editor" in found ? found.editor : undefined, bindings }, { token: ctx.token.id, name: ctx.token.name });
    s.queue.events.emit("setup");
    const def = s.registry.workflow(saved.id)!;
    const recipe: Recipe<any> | undefined = s.registry.recipe(saved.id);
    const onForm = new Set(bindings.controls?.map((c) => c.id) ?? []);
    const packs = [...new Set(Object.values(found.packs))];
    const elsewhere = found.elsewhere as Record<string, string[]>;
    ctx.said(`Imported the workflow “${saved.title}”${from ? ` from ${from}` : ""}`);
    return {
      form: saved.id, title: saved.title, model: saved.model, makes: saved.output, nodes: saved.nodes,
      waitsForApproval: "The user approves it once in Afflatus (Studio › Workflows › Approve) before it renders: run_workflow and render refuse it until then.",
      reaches: reachOf(def),
      inputs: recipe ? shownInputs(recipe).map(inputBrief) : [],
      moreControls: candidates.filter((c) => !onForm.has(c.id)).slice(0, 80).map((c) => ({ id: c.id, label: c.label, node: c.title, ...(c.off ? { off: true } : {}) })),
      missing: {
        nodes: found.missingNodes,
        ...(found.missingWhenOn.length ? { nodesWhenSwitchedOn: found.missingWhenOn } : {}),
        ...(packs.length ? { packs } : {}),
        files: found.missingFiles.map((f) => ({ file: f.file, for: f.label, node: f.classType, ...(elsewhere[f.file] ? { inOtherFolders: elsewhere[f.file] } : {}), ...(f.url ? { url: f.url } : {}), ...(f.source ? { source: f.source } : {}) })),
        choices: found.missingChoices.map((c) => ({ node: c.title, value: c.value, ...(c.nearest ? { nearest: c.nearest } : {}) })),
      },
      ...(found.notes.length ? { notes: found.notes } : {}),
      ...(found.links.length ? { authorLinks: found.links } : {}),
    };
  },
});

/** A saved workflow by its form id, its slug or its title, whatever its state. */
function savedWorkflow(s: Services, asked: string) {
  const all = s.registry.workflows();
  const d = all.find((w) => w.id === asked) ?? all.find((w) => w.id === `workflow.${asked}`) ?? all.find((w) => w.title.toLowerCase() === asked.trim().toLowerCase());
  if (!d) throw httpError(`There is no workflow called ${asked}: list_workflows gives the ids.`, 404);
  return d;
}

/** A saved workflow to run, by its form id, its slug or its title: refused when it cannot be built, or waits for the user's approval. */
function workflowOf(s: Services, asked: string): string {
  const d = savedWorkflow(s, asked);
  const problem = s.registry.problem(d.id);
  if (problem) throw httpError(`“${d.title}” cannot be run as it is: ${problem}`);
  if (s.registry.pending(d.id)) throw refusal(waitingWords(d.title));
  return d.id;
}

const runWorkflow = tool({
  name: "run_workflow",
  scope: "make",
  title: "Run a workflow",
  description: "Render a saved workflow with values: the same as render with its form (workflow.<slug>), through Create's own path and refusals. One an agent imported renders only once the user approved it in Afflatus (list_workflows says waiting). Inputs by id (list_workflows, describe_form); the rest start as the form starts them. The token's renders-an-hour limit holds; a rented pod needs Spend (a token without it never lands on one) and stays within the token's spend cap. Answers the job ids (job, queue_status follow them) and what it may cost.",
  input: {
    workflow: z.string().min(1).describe("The workflow's form id (list_workflows), its slug, or its title."),
    values: z.record(z.string(), z.unknown()).optional().describe("Its inputs by id."),
    takes: z.number().int().min(1).max(8).optional().describe("How many takes (1–8); 1 when left out."),
    machine: z.string().optional().describe("A machine's id or name (overview); left out, the queue picks among those this token may use."),
    label: z.string().max(200).optional(),
  },
  run: (a, ctx) => renderForm({ form: workflowOf(ctx.s, a.workflow), values: a.values ?? {}, takes: a.takes, machine: a.machine, label: a.label }, ctx),
});

const workflowArg = z.string().min(1).describe("The workflow's form id (list_workflows), its slug, or its title.");

const readWorkflow = tool({
  name: "read_workflow",
  scope: "look",
  title: "Read a workflow's mapping",
  description: "A saved workflow's mapping, as Studio › Workflows › Edit shows it: which node and input the prompt, negative, seeds, size, length, opening and ending pictures, LoRAs, switches (toggles), controls and result are, what is left out (skip), how the form is laid out (sections); with its nodes by id, each one's type and title, and what it reaches (its nodes that read or write a path or fetch an address). edit_workflow changes the mapping.",
  input: { workflow: workflowArg },
  async run(a, ctx) {
    const d = savedWorkflow(ctx.s, a.workflow);
    const waits = ctx.s.registry.pending(d.id);
    ctx.said(`Read the mapping of “${d.title}”`);
    return {
      form: d.id, title: d.title, model: d.model, bindings: d.bindings, reaches: reachOf(d),
      nodes: Object.fromEntries(Object.entries(d.graph).map(([id, n]) => [id, { type: n.class_type, ...(typeof (n._meta as { title?: unknown } | undefined)?.title === "string" ? { title: (n._meta as { title: string }).title } : {}) }])),
      ...(waits ? { waiting: `imported by ${waits.name}: it renders once the user approves it in Afflatus` } : {}),
    };
  },
});

const editWorkflow = tool({
  name: "edit_workflow",
  scope: "make",
  title: "Edit a workflow's mapping",
  description: "Change a saved workflow's mapping (read_workflow gives it), as Studio › Workflows › Edit saves it: each key of `bindings` given replaces that part whole (prompt, negative, seeds, size, length, startImage, endImage, loras, toggles, controls, result, skip, sections), null leaves it out; its title and model too. Checked as the page checks it (every node and input named is in the workflow, ids unique) and built once before it is kept; its graph stays as it is. What a form sets is part of what a workflow reaches: once an agent changed it, it waits for the user's approval again (Studio › Workflows › Approve, in Afflatus) before it renders, even one the user imported. Approving stays the user's.",
  input: {
    workflow: workflowArg,
    bindings: z.record(z.string(), z.unknown()).optional().describe("Parts of the mapping by key, each replacing that part whole; null leaves it out."),
    title: z.string().trim().min(1).max(120).optional().describe("Its name in Create. Its form id stays."),
    model: z.string().trim().min(1).max(60).optional().describe("The model it runs, which groups it with its family in Create."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const d = savedWorkflow(s, a.workflow);
    if (!a.bindings && a.title === undefined && a.model === undefined) throw httpError("Say what to change: bindings, title or model.");
    const bindings = { ...d.bindings } as Bindings & Record<string, unknown>;
    for (const [key, value] of Object.entries(a.bindings ?? {})) {
      if (value === null) delete bindings[key];
      else bindings[key] = value;
    }
    const saved = await saveWorkflow(s, d.id, { title: a.title ?? d.title, model: a.model ?? d.model, source: d.source, graph: d.graph, wiring: d.wiring, editor: d.editor, bindings }, { token: ctx.token.id, name: ctx.token.name });
    s.queue.events.emit("setup");
    const recipe: Recipe<any> | undefined = s.registry.recipe(saved.id);
    ctx.said(`Changed the mapping of “${saved.title}”${a.bindings ? `: ${Object.keys(a.bindings).join(", ")}` : ""}`);
    return {
      form: saved.id, title: saved.title, model: saved.model,
      waitsForApproval: "The user approves it again in Afflatus (Studio › Workflows › Approve) before it renders: run_workflow and render refuse it until then.",
      reaches: reachOf(s.registry.workflow(saved.id)!),
      inputs: recipe ? shownInputs(recipe).map(inputBrief) : [],
    };
  },
});

const deleteWorkflow = tool({
  name: "delete_workflow",
  scope: "make",
  title: "Delete a workflow",
  description: "Delete a saved workflow, as Studio › Workflows' Delete does: its form goes from Create. What was made with it stays in the library; drafts on it stay too, and say it is gone. It does not come back but by importing it again.",
  input: { workflow: workflowArg },
  async run(a, ctx) {
    const { s } = ctx;
    const d = savedWorkflow(s, a.workflow);
    if (!(await s.registry.remove(d.id))) throw httpError("this workflow was not found", 404);
    s.queue.events.emit("setup");
    ctx.said(`Deleted the workflow “${d.title}”`);
    return { deleted: d.id, title: d.title };
  },
});

export const WORKFLOW_TOOLS = [listWorkflows, importWorkflow, runWorkflow, readWorkflow, editWorkflow, deleteWorkflow];
