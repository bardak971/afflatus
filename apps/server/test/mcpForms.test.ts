import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { OWN_MODEL } from "@afflatus/core";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverFor } from "../src/mcp";
import type { DraftEdit } from "../src/mcpDrafts";
import { tool } from "../src/mcpTool";
import { CHECKPOINT, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * MCP phase 2 (mcpForms.ts, mcpDrafts.ts, mcpRender.ts, mcpSee.ts) through the SDK's own client over HTTP, as Claude Code
 * reaches it, against a pretend ComfyUI: the forms described from their InputSpec, drafts made and edited as the form
 * validates them with a "draft" live event for the open page, a render of a draft followed to what it made, seen as
 * pictures, compared; and a server failure written in the activity as failed, not refused.
 */

const RECIPE = "sdxl.text-to-picture";
let t: TestApp;
let fake: FakeComfy;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

async function made(start: "look" | "make" | "spend" | "all" = "make", name = "Cursor"): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name, start } });
  return { token: res.json().token as string, id: res.json().view.id as string };
}

async function connect(token: string): Promise<Client> {
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")!.text!;
const json = (r: Called) => {
  if (r.isError) throw new Error(textOf(r));
  return JSON.parse(textOf(r));
};
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

/** A real picture (the helpers' PNG is a header only, which no image library opens). */
const picture = (color: string, width = 64, height = 96) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

/** Make the fake ComfyUI finish a prompt with a picture that opens. */
async function finish(promptId: string, color = "#c33"): Promise<void> {
  const graph = fake.prompts.get(promptId)!;
  const out = Object.entries(graph).find(([, n]) => n.class_type === "PreviewImage")![0];
  fake.files[`${promptId}.png`] = new Uint8Array(await picture(color));
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { images: [{ filename: `${promptId}.png`, subfolder: "", type: "temp" }] } } };
}

/** A picture put in the library as an upload would put it: its id. */
async function uploaded(color: string): Promise<string> {
  const bytes = await picture(color);
  const res = await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "image/png", "x-filename": "zz-test.png" }, payload: bytes });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { id: string }).id;
}

describe("the forms", () => {
  it("lists every form by family, generated from the recipes, with what each makes and whether it is ready", async () => {
    const c = await connect((await made("look")).token);
    const forms = json(await call(c, "list_forms"));
    const sdxl = forms.families.find((f: { family: string }) => f.family === "sdxl");
    expect(sdxl.forms.find((f: { id: string }) => f.id === RECIPE)).toMatchObject({ title: expect.any(String), makes: "image", ready: true });
    await c.close();
  });

  it("describes a form from its InputSpec: inputs, presets, the designer's guide, and the files each machine has", async () => {
    await post(t.app, "/api/entities", { kind: "preset", name: "zz-test noir", def: { recipe: RECIPE, inputs: { steps: 31 } } });
    const c = await connect((await made("look")).token);
    const d = json(await call(c, "describe_form", { form: RECIPE }));
    const prompt = d.inputs.find((i: { type: string }) => i.type === "prompt");
    expect(prompt).toMatchObject({ id: "prompt", label: expect.any(String), style: "tags", value: "text" });
    expect(d.inputs.find((i: { id: string }) => i.id === "steps")).toMatchObject({ type: "number", min: expect.any(Number), max: expect.any(Number), default: expect.any(Number) });
    expect(d.inputs.some((i: { internal?: boolean }) => i.internal)).toBe(false);
    expect(d.presets.kit).toEqual([expect.objectContaining({ name: "zz-test noir", sets: ["steps"] })]);
    expect(d.prompt.guide.length).toBeGreaterThan(200);
    expect(d.prompt.from).toBe("the family's guide");
    expect(d.machines[0]).toMatchObject({ online: true, ready: true });
    expect(d.machines[0].models.checkpoint).toContain(CHECKPOINT);
    // the user's own guide from Settings is the one the designer uses, and so the one said
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { designerGuides: { sdxl: "zz-test: tags, the subject first." } } });
    const own = json(await call(c, "describe_form", { form: RECIPE }));
    expect(own.prompt).toMatchObject({ guide: "zz-test: tags, the subject first.", from: expect.stringMatching(/user's own/) });
    expect((await call(c, "describe_form", { form: "zz.none" })).isError).toBe(true);
    await c.close();
  });
});

describe("the drafts", () => {
  it("makes a draft and edits it as the form validates, saved through the drafts' save, said as a draft event with what was before", async () => {
    const { token } = await made("make");
    const c = await connect(token);
    const d = json(await call(c, "new_draft", { form: RECIPE, values: { prompt: "zz-test a lighthouse" }, name: "zz-test lighthouse" }));
    expect(d).toMatchObject({ form: RECIPE, values: { prompt: "zz-test a lighthouse" }, name: "zz-test lighthouse" });
    const heard: DraftEdit[] = [];
    t.services.queue.events.on("draft", (e: DraftEdit) => heard.push(e));
    const edited = json(await call(c, "edit_draft", { draft: d.id, set: { prompt: "zz-test a lighthouse at dusk", steps: 24, checkpoint: CHECKPOINT }, takes: 3 }));
    expect(edited.changed.sort()).toEqual(["checkpoint", "prompt", "steps", "takes"].sort());
    // written where the page reads it
    const row = (await t.app.inject({ method: "GET", url: `/api/drafts/${d.id}` })).json();
    expect(row.forms[RECIPE]).toMatchObject({ prompt: "zz-test a lighthouse at dusk", steps: 24 });
    expect(row.count).toBe(3);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ id: d.id, by: "Cursor", count: { was: 1, now: 3 } });
    expect(heard[0]!.fields).toEqual(expect.arrayContaining([
      { form: RECIPE, input: "prompt", had: true, was: "zz-test a lighthouse", now: "zz-test a lighthouse at dusk" },
      { form: RECIPE, input: "steps", had: false, now: 24 },
    ]));
    // taken out: it follows the form's start again
    json(await call(c, "edit_draft", { draft: d.id, set: { steps: null } }));
    expect(heard[1]!.fields).toEqual([{ form: RECIPE, input: "steps", had: true, was: 24, gone: true }]);
    await c.close();
  });

  it("refuses what the form refuses: an input it has not, a value out of range, a file no machine has, an item of the wrong kind", async () => {
    const c = await connect((await made("make")).token);
    const d = json(await call(c, "new_draft", { form: RECIPE }));
    const refused = async (args: Record<string, unknown>, said: RegExp) => {
      const r = await call(c, "edit_draft", { draft: d.id, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r)).toMatch(said);
    };
    await refused({ set: { nonsense: 1 } }, /has no input nonsense: its inputs are .*prompt/);
    // every value refused is said at once, and none of the others is kept
    await refused({ set: { prompt: "zz-test kept?", steps: -5, nonsense: 1, checkpoint: "zz-test-missing.safetensors" } }, /^3 values refused, nothing changed:\n- .*steps.*\n- .*has no input nonsense.*\n- .*no machine has zz-test-missing/s);
    expect(json(await call(c, "read_draft", { draft: d.id })).values.prompt).toBeUndefined();
    await refused({ set: { steps: 100_000 } }, /steps/i);
    await refused({ set: { checkpoint: "zz-test-missing.safetensors" } }, /no machine has zz-test-missing/);
    // the clip's own model only where the input offers it (Face refine's): on a checkpoint it named no file, and the job failed at its submit
    await refused({ set: { checkpoint: OWN_MODEL } }, /checkpoint.*"Clip's own model" is not offered here/);
    await refused({ loras: [{ file: "zz-test-nowhere.safetensors", weight: 0.8 }] }, /no machine has the LoRA/);
    await refused({ cast: ["Nobody Here"] }, /Nobody called Nobody Here/);
    await refused({ draft: "0".repeat(32), set: { steps: 20 } }, /no such draft/);
    // a file in another folder by the same name is the same file, named as the machines name it
    const ok = json(await call(c, "edit_draft", { draft: d.id, set: { checkpoint: `sub\\${CHECKPOINT}` } }));
    expect(ok.draft.values.checkpoint).toBe(CHECKPOINT);
    await c.close();
  });

  it("puts library items in media slots by id, refusing a sound or a video where a picture goes", async () => {
    const c = await connect((await made("make")).token);
    const img = await uploaded("#2a6");
    const redraw = t.services.registry.recipes().find((r) => r.family === "sdxl" && r.inputs.some((i) => i.type === "image" && i.role === "source"))!;
    const slot = redraw.inputs.find((i) => i.type === "image")!.id;
    const d = json(await call(c, "new_draft", { form: redraw.id }));
    expect(json(await call(c, "edit_draft", { draft: d.id, set: { [slot]: img } })).draft.values[slot]).toBe(img);
    expect(textOf(await call(c, "edit_draft", { draft: d.id, set: { [slot]: "f".repeat(32) } }))).toMatch(/no library item/);
    await c.close();
  });

  it("applies a Prompt kit preset as Create does, and lists and reads the drafts", async () => {
    const p = (await post(t.app, "/api/entities", { kind: "preset", name: "zz-test sharp", def: { recipe: RECIPE, inputs: { steps: 33, cfg: 6 } } })).json();
    const c = await connect((await made("make")).token);
    const d = json(await call(c, "new_draft", { form: RECIPE, values: { prompt: "zz-test a fox" } }));
    const applied = json(await call(c, "apply_preset", { draft: d.id, preset: "zz-test sharp" }));
    expect(applied).toMatchObject({ applied: "zz-test sharp", draft: { values: { prompt: "zz-test a fox", steps: 33, cfg: 6 } } });
    expect(json(await call(c, "apply_preset", { draft: d.id, preset: p.id })).changed).toEqual([]);
    const list = json(await call(c, "list_drafts"));
    expect(list.find((x: { id: string }) => x.id === d.id)).toMatchObject({ form: RECIPE, name: "zz-test a fox" });
    const read = json(await call(c, "read_draft", { draft: d.id }));
    expect(read.whole).toMatchObject({ prompt: "zz-test a fox", steps: 33, checkpoint: expect.any(String) });
    await c.close();
  });

  it("deletes a draft nothing was made from, and refuses one something was made from", async () => {
    const c = await connect((await made("make")).token);
    const d = json(await call(c, "new_draft", { form: RECIPE, name: "zz-test a try", values: { prompt: "zz-test a try" } }));
    expect(json(await call(c, "delete_draft", { draft: d.id }))).toEqual({ deleted: d.id, name: "zz-test a try" });
    expect(textOf(await call(c, "read_draft", { draft: d.id }))).toMatch(/no such draft/);
    const used = json(await call(c, "new_draft", { form: RECIPE, values: { prompt: "zz-test a door", checkpoint: CHECKPOINT } }));
    const job = json(await call(c, "render", { draft: used.id })).jobs[0];
    const r = await call(c, "delete_draft", { draft: used.id });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Something was made from this draft/);
    expect(json(await call(c, "read_draft", { draft: used.id })).id).toBe(used.id);
    json(await call(c, "cancel", { job }));
    await t.services.queue.idle();
    await c.close();
  });

  it("refuses a look token everything that changes a draft", async () => {
    const c = await connect((await made("look")).token);
    for (const name of ["new_draft", "edit_draft", "apply_preset", "delete_draft", "render", "cancel", "retry", "load_model", "pause_machine"]) {
      const r = await call(c, name, { form: RECIPE, draft: "x", preset: "x", job: "x" });
      expect(r.isError, name).toBe(true);
      expect(textOf(r), name).toMatch(/needs Make/);
    }
    await c.close();
  });
});

describe("render, follow and see", () => {
  it("renders a draft through Render's path, follows the job to what it made, views it and compares two", async () => {
    const { token, id } = await made("make");
    const c = await connect(token);
    const d = json(await call(c, "new_draft", { form: RECIPE, values: { prompt: "zz-test a red door", checkpoint: CHECKPOINT } }));
    const est = json(await call(c, "estimate", { draft: d.id, takes: 2 }));
    expect(est).toMatchObject({ takes: 2, modelSet: "the files go together", refused: null });
    const r = json(await call(c, "render", { draft: d.id, takes: 2 }));
    expect(r.jobs).toHaveLength(2);
    const rows = await t.db.selectFrom("jobs").select(["mcp_token_id", "draft_id", "label"]).where("id", "in", r.jobs).execute();
    expect(rows.every((x) => x.mcp_token_id === id && x.draft_id === d.id)).toBe(true);
    // the status bar's words: who queued it, and how many of its renders wait or run
    const st = (await t.app.inject({ method: "GET", url: "/api/queue" })).json();
    expect([st.running, ...st.waiting].filter(Boolean)[0].by).toEqual({ name: "Cursor", jobs: 2 });
    await until(() => fake.prompts.size >= 1);
    // job's wait: still going after a second, it answers as it stands; it answers the end as soon as the job ends
    const t0 = Date.now();
    expect(json(await call(c, "job", { job: r.jobs[0], wait: 1 })).status).toMatch(/running|waiting/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const waited = call(c, "job", { job: r.jobs[0], wait: 30 });
    await finish([...fake.prompts.keys()][0]!, "#c33");
    expect(json(await waited)).toMatchObject({ status: "done", made: [expect.objectContaining({ kind: "image" })] });
    await until(() => fake.prompts.size >= 2);
    await finish([...fake.prompts.keys()][1]!, "#33c");
    await t.services.queue.idle();
    const done = json(await call(c, "job", { job: r.jobs[0] }));
    expect(done).toMatchObject({ status: "done", made: [expect.objectContaining({ kind: "image" })] });
    const item = done.made[0].item as string;
    const seen = await call(c, "view_item", { item });
    const parts = seen.content as Array<{ type: string; text?: string; mimeType?: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
    expect(parts[1]!.mimeType).toBe("image/jpeg");
    expect(JSON.parse(parts[0]!.text!).madeWith).toMatchObject({ form: RECIPE, model: CHECKPOINT, prompts: { prompt: "zz-test a red door" }, seed: expect.any(Number) });
    const other = json(await call(c, "job", { job: r.jobs[1] })).made[0].item as string;
    const both = await call(c, "compare", { items: [item, other] });
    const said = JSON.parse(textOf(both));
    expect(said.differs.seed).toHaveLength(2);
    expect((both.content as Array<{ type: string }>).filter((p) => p.type === "image")).toHaveLength(1);
    const qs = json(await call(c, "queue_status"));
    // read from the queue's last status (statusRecent), as the Queue screen's pages are
    expect(qs).toMatchObject({ paused: false, machines: [expect.objectContaining({ id: "m1", name: "this PC's ComfyUI", paused: false })], waiting: expect.any(Array) });
    await c.close();
  });

  it("refuses to render a form with an input it cannot do without, as Render does", async () => {
    const c = await connect((await made("make")).token);
    const redraw = t.services.registry.recipes().find((r) => r.family === "sdxl" && r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional))!;
    const d = json(await call(c, "new_draft", { form: redraw.id, values: { prompt: "zz-test" } }));
    const r = await call(c, "render", { draft: d.id });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Select the .* first/);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    await c.close();
  });

  it("cancels its own jobs and the user's, not another token's", async () => {
    await t.app.inject({ method: "POST", url: "/api/queue/pause" });
    const a = await made("make", "zz-test A");
    const b = await made("make", "zz-test B");
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    const mine = json(await call(ca, "render", { form: RECIPE, values: { prompt: "zz-test", checkpoint: CHECKPOINT } })).jobs[0];
    const users = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "zz-test", checkpoint: CHECKPOINT } })).json().ids[0];
    const theirs = await call(cb, "cancel", { job: mine });
    expect(theirs.isError).toBe(true);
    expect(textOf(theirs)).toMatch(/queued by another token \(zz-test A\)/);
    expect(json(await call(ca, "cancel", { job: mine }))).toMatchObject({ cancelled: mine });
    expect(json(await call(cb, "cancel", { job: users }))).toMatchObject({ cancelled: users });
    await ca.close();
    await cb.close();
  });
});

describe("the activity", () => {
  it("writes a server failure as failed, and a refusal as refused", async () => {
    const { token } = await made("make");
    const view = (await t.services.mcp.tokens.list())[0]!;
    const broken = tool({ name: "broken", scope: "look", title: "Broken", description: "Fails.", async run() { throw new Error("disk on fire"); } });
    const fiveHundred = tool({ name: "busy", scope: "look", title: "Busy", description: "503.", async run() { throw Object.assign(new Error("ComfyUI did not answer"), { statusCode: 503 }); } });
    const needs = tool({ name: "spendy", scope: "spend", title: "Spendy", description: "Spend.", async run() { return "ok"; } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = serverFor(t.services, view, "127.0.0.1", [broken, fiveHundred, needs]);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "zz-test", version: "1" });
    await c.connect(b);
    for (const name of ["broken", "busy", "spendy"]) await c.callTool({ name });
    const lines = await t.services.mcp.tokens.activity(view.id);
    expect(lines.map((l) => [l.tool, l.refused, l.failed])).toEqual([["spendy", true, false], ["busy", false, true], ["broken", false, true]]);
    expect(lines[1]!.why).toBe("ComfyUI did not answer");
    expect(lines[2]!.why).toBe("something went wrong on the server");
    expect(token).toBeTruthy();
    await c.close();
  });
});
