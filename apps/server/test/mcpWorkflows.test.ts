import type { AddressInfo } from "node:net";
import { crc32 } from "node:zlib";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makePng, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wan } from "../../../packages/workflows/test/fixtures";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Imported workflows from outside (mcpWorkflows.ts), through the SDK's own client over HTTP as Claude Code reaches /mcp,
 * against a pretend ComfyUI: listed as Workflows lists them, imported from text, an address or a library picture through
 * the web's own inspect and save, refused where the web refuses (and for a token that only looks, or a plain http
 * address), and run as a render of their form, the job sent by the token, a rented pod refused without Spend.
 */

// an address on the internet that answers a workflow, without the internet: the rest of outbound.ts as it is
const WF_URL = "https://workflows.example/zz-test/Wan%20picture%20to%20video%20(API).json";
const BIG_URL = "https://workflows.example/zz-test/big.json";
vi.mock("../src/outbound", async (actual) => {
  const real = await actual<typeof import("../src/outbound")>();
  return {
    ...real,
    fetchPublic: vi.fn(async (url: string, ...rest: Parameters<typeof real.fetchPublic> extends [string, ...infer R] ? R : never) =>
      url === WF_URL ? new Response(JSON.stringify(wan), { headers: { "content-type": "application/json" } })
        : url === BIG_URL ? new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(2 ** 20).fill(32)); } }))
          : real.fetchPublic(url, ...rest)),
  };
});

/** A PNG with text chunks in it, as ComfyUI writes its workflow into the pictures it saves. */
function pngWith(texts: Record<string, string>): Uint8Array {
  const png = Buffer.from(makePng(8, 8, [10, 20, 30], [40, 50, 60]));
  const end = png.length - 12;
  const chunks = Object.entries(texts).map(([key, text]) => {
    const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(text, "utf8")]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write("tEXt", 4, "latin1");
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, sum]);
  });
  return new Uint8Array(Buffer.concat([png.subarray(0, end), ...chunks, png.subarray(end)]));
}

let fake: FakeComfy;
let t: TestApp;

async function made(start: "look" | "make" | "spend"): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
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
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r));
};
const refused = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};

describe("workflows from outside", () => {
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

  it("imports one from its text through the web's inspect and save, with what inspect suggests, and lists it as Workflows does", async () => {
    const c = await connect((await made("make")).token);
    expect((await ok(c, "list_workflows")).workflows).toEqual([]);
    const got = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "Wan 2.2 · Picture to video" });
    expect(got).toMatchObject({ form: "workflow.wan-2-2-picture-to-video", title: "Wan 2.2 · Picture to video", makes: "video", nodes: 12, missing: { nodes: [], files: [] } });
    expect(got.model).toBeTruthy();
    expect(got.inputs.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(["prompt", "seconds"]));
    // the same mapping the web's import starts from: the form the web would make
    const web = (await post(t.app, "/api/workflows/inspect", wan)).json();
    expect((await get(t.app, `/api/workflows/${got.form}`)).json().bindings).toEqual(web.suggested);
    const listed = (await ok(c, "list_workflows")).workflows;
    const { items } = (await get(t.app, "/api/workflows")).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(items[0]);
    expect(listed[0].inputs.map((i: { id: string }) => i.id)).toContain("prompt");
    // a second import of the same title gets a second id, as from the web
    expect((await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "Wan 2.2 · Picture to video" })).form).toBe("workflow.wan-2-2-picture-to-video-2");
    await c.close();
  });

  it("changes parts of the mapping and adds settings to the form when asked", async () => {
    const c = await connect((await made("make")).token);
    const first = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test plain" });
    const extra = first.moreControls[0] as { id: string };
    expect(first.inputs.map((i: { id: string }) => i.id)).not.toContain(extra.id);
    const got = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test changed", bindings: { negative: null }, addControls: [extra.id] });
    const def = (await get(t.app, `/api/workflows/${got.form}`)).json();
    expect(def.bindings.negative ?? null).toBeNull();
    expect(got.inputs.map((i: { id: string }) => i.id)).toContain(extra.id);
    await refused(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test bad", addControls: ["nope"] }, /no setting “nope”/);
    await refused(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test bad", bindings: { prompt: { node: "6", input: "nope" } } }, /not in the workflow/);
    expect((await get(t.app, "/api/workflows")).json().items).toHaveLength(2);
    await c.close();
  });

  it("imports one from a public https address, named from the file, and refuses a plain http one, one inside the network, and one too large", async () => {
    const c = await connect((await made("make")).token);
    const got = await ok(c, "import_workflow", { url: WF_URL });
    expect(got).toMatchObject({ form: "workflow.wan-picture-to-video", title: "Wan picture to video", makes: "video" });
    expect((await get(t.app, `/api/workflows/${got.form}`)).json().source).toBe("Wan picture to video (API).json");
    await refused(c, "import_workflow", { url: "http://workflows.example/a.json" }, /Only https/);
    await refused(c, "import_workflow", { url: "https://192.168.1.20/a.json" }, /inside your own network/);
    await refused(c, "import_workflow", { url: BIG_URL }, /larger than 16 MB/);
    await refused(c, "import_workflow", { url: WF_URL, json: "{}" }, /one way/);
    expect((await get(t.app, "/api/workflows")).json().items).toHaveLength(1);
    await c.close();
  });

  it("imports the workflow a library picture carries, and refuses one that carries none", async () => {
    const c = await connect((await made("make")).token);
    const up = async (name: string, bytes: Uint8Array) => (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}`, headers: { "content-type": "image/png" }, payload: Buffer.from(bytes) })).json() as { id: string };
    const withIt = await up("zz-test harbour", pngWith({ prompt: JSON.stringify(wan) }));
    const got = await ok(c, "import_workflow", { item: withIt.id, model: "Wan 2.2" });
    expect(got).toMatchObject({ form: "workflow.zz-test-harbour", model: "Wan 2.2", makes: "video" });
    const plain = await up("zz-test plain", makePng(8, 8, [1, 2, 3], [4, 5, 6]));
    await refused(c, "import_workflow", { item: plain.id }, /carries no workflow/);
    await refused(c, "import_workflow", { item: "nope" }, /no such item/);
    await c.close();
  });

  it("refuses what is no workflow, as the web does, and keeps nothing", async () => {
    const c = await connect((await made("make")).token);
    await refused(c, "import_workflow", { json: "not json", title: "zz-test" }, /could not be parsed|carries no workflow/);
    await refused(c, "import_workflow", { json: JSON.stringify({ hello: "world" }), title: "zz-test" }, /does not look like a ComfyUI workflow/);
    expect((await get(t.app, "/api/workflows")).json().items).toEqual([]);
    await c.close();
  });

  it("is listed to a token that looks, which cannot import or run", async () => {
    const maker = await connect((await made("make")).token);
    const { form } = await ok(maker, "import_workflow", { json: JSON.stringify(wan), title: "zz-test wan" });
    await maker.close();
    const look = await connect((await made("look")).token);
    expect((await ok(look, "list_workflows")).workflows.map((w: { id: string }) => w.id)).toEqual([form]);
    await refused(look, "import_workflow", { json: JSON.stringify(wan), title: "zz-test again" }, /needs Make/);
    await refused(look, "run_workflow", { workflow: form, values: { prompt: "zz-test" } }, /needs Make/);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    await look.close();
  });

  it("keeps one an agent imported waiting for the user's approval: refused on every way in until Approve, named by its token", async () => {
    await t.services.queue.start();
    const c = await connect((await made("make")).token);
    const got = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test wan" });
    expect(got.waitsForApproval).toMatch(/Approve/);
    expect(got.reaches).toEqual([]);
    const listed = (await ok(c, "list_workflows")).workflows[0];
    expect(listed.waiting).toEqual({ by: "zz-test make", reaches: [] });
    expect((await get(t.app, "/api/workflows")).json().items[0].waiting).toEqual({ by: "zz-test make", reaches: [] });
    const values = { prompt: "zz-test she waves", seconds: 3 };
    await refused(c, "run_workflow", { workflow: got.form, values }, /waits for the user's approval/);
    await refused(c, "render", { form: got.form, values }, /waits for the user's approval/);
    // from the page too: the user approves it once, where it is listed, before anything renders it
    const web = await post(t.app, "/api/jobs", { recipe: got.form, input: values });
    expect(web.statusCode).toBe(409);
    expect(web.json().error ?? web.json().message).toMatch(/Studio › Workflows › Approve/);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    expect((await post(t.app, `/api/workflows/${got.form}/approve`, {})).statusCode).toBe(200);
    expect((await post(t.app, "/api/workflows/workflow.nope/approve", {})).statusCode).toBe(404);
    expect((await get(t.app, "/api/workflows")).json().items[0].waiting).toBeUndefined();
    expect((await ok(c, "run_workflow", { workflow: got.form, values })).jobs).toHaveLength(1);
    await until(() => fake.prompts.size === 1);
    // the user's own edit of an approved one keeps it approved; the user's own import never waits
    const def = (await get(t.app, `/api/workflows/${got.form}`)).json();
    const { id: _id, ...body } = def;
    expect((await t.app.inject({ method: "PUT", url: `/api/workflows/${got.form}`, payload: body })).statusCode).toBe(200);
    expect((await post(t.app, "/api/workflows", { ...body, title: "zz-test mine" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/workflows")).json().items.map((w: { waiting?: unknown }) => w.waiting)).toEqual([undefined, undefined]);
    await c.close();
  });

  it("names what a waiting workflow reads, writes or fetches: VideoHelperSuite's path loaders, path inputs, addresses typed in", async () => {
    const c = await connect((await made("make")).token);
    const reaching = {
      ...wan,
      "90": { class_type: "VHS_LoadVideoPath", inputs: { video: "C:/Users/someone/secret.mp4", force_rate: 0, frame_load_cap: 0 }, _meta: { title: "zz-test reader" } },
      "91": { class_type: "Some Loader", inputs: { image_url: "https://lan.example/x.png", ckpt_name: "model.safetensors", seed: 1 } },
      "92": { class_type: "Some Saver", inputs: { output_path: ["90", 0], filename_prefix: "ComfyUI" } },
    };
    const got = await ok(c, "import_workflow", { json: JSON.stringify(reaching), title: "zz-test reach" });
    expect(got.reaches).toEqual([
      { node: "90", type: "VHS_LoadVideoPath", title: "zz-test reader", inputs: [{ input: "video", value: "C:/Users/someone/secret.mp4" }] },
      { node: "91", type: "Some Loader", inputs: [{ input: "image_url", value: "https://lan.example/x.png" }] },
      { node: "92", type: "Some Saver", inputs: [{ input: "output_path", from: "90" }] },
    ]);
    expect((await get(t.app, "/api/workflows")).json().items[0].waiting.reaches).toEqual(got.reaches);
    await c.close();
  });

  it("runs a saved one as a render of its form: the job is the token's, the values go into the workflow", async () => {
    await t.services.queue.start();
    const { token, id } = await made("make");
    const c = await connect(token);
    const { form } = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test wan" });
    await post(t.app, `/api/workflows/${form}/approve`, {});
    const r = await ok(c, "run_workflow", { workflow: "zz-test-wan", values: { prompt: "zz-test she waves at the boat", seconds: 3 } });
    expect(r.jobs).toHaveLength(1);
    const rows = await t.db.selectFrom("jobs").select(["recipe_id", "mcp_token_id"]).where("id", "in", r.jobs).execute();
    expect(rows).toEqual([{ recipe_id: form, mcp_token_id: id }]);
    await until(() => fake.prompts.size === 1);
    expect([...fake.prompts.values()][0]!["6"]!.inputs.text).toBe("zz-test she waves at the boat");
    await refused(c, "run_workflow", { workflow: "nope" }, /no workflow called nope/);
    await refused(c, "run_workflow", { workflow: form, values: { seconds: 3 } }, /Fill in the prompt/);
    await c.close();
  });
});

describe("running a workflow where money is at stake", () => {
  const KEY = "rpa_test_key_0123456789";
  let home: FakeComfy;
  let a: FakeComfy;
  let runpod: FakeRunpod;
  let pod: string;

  beforeEach(async () => {
    home = await makeFake();
    a = await makeFake();
    a.packVersion = "0.13.0";
    runpod = await startFakeRunpod({ key: KEY, bootMs: 30, pods: [{ name: "pod-a", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: a }] });
    vi.stubEnv("RUNPOD_API_URL", runpod.url);
    vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
    vi.spyOn(console, "log").mockImplementation(() => {});
    t = await makeApp({ comfyUrl: home.url });
    t.services.rented.everyMs = 60_000;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
    pod = (await post(t.app, "/api/runpod/add", { pod: runpod.pods[0]!.id })).json().id as string;
    expect((await post(t.app, `/api/machines/${pod}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await t.services.rented.poll();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
    vi.unstubAllEnvs();
    await Promise.all([home, a, runpod].map((x) => x.close().catch(() => {})));
  });

  it("refuses a token without Spend a run pinned to a rented pod, and queues nothing", async () => {
    const { token, id } = await made("make");
    const c = await connect(token);
    const { form } = await ok(c, "import_workflow", { json: JSON.stringify(wan), title: "zz-test wan" });
    await post(t.app, `/api/workflows/${form}/approve`, {});
    await refused(c, "run_workflow", { workflow: form, values: { prompt: "zz-test" }, machine: pod }, /cannot spend on rented GPUs, and .* is one/);
    expect(await t.db.selectFrom("jobs").select("id").where("mcp_token_id", "=", id).execute()).toEqual([]);
    // left to the queue, it is sent to the user's own machine only
    const r = await ok(c, "run_workflow", { workflow: form, values: { prompt: "zz-test" } });
    expect(r.on).toMatch(/user's own machines/);
    await t.services.queue.cancel(r.jobs[0]);
    await c.close();
  });

  it("reads and changes a workflow's mapping, which then waits for the user's approval again, even the user's own, and deletes one", async () => {
    const c = await connect((await made("make")).token);
    // the user's own import: approved from the start
    const inspected = (await post(t.app, "/api/workflows/inspect", wan)).json();
    const mine = (await post(t.app, "/api/workflows", { title: "zz-test mine", model: "Wan 2.2", graph: inspected.graph, bindings: inspected.suggested })).json();
    const read = await ok(c, "read_workflow", { workflow: mine.id });
    expect(read).toMatchObject({ form: mine.id, title: "zz-test mine", bindings: inspected.suggested, reaches: [] });
    expect(read.waiting).toBeUndefined();
    expect(Object.keys(read.nodes)).toHaveLength(12);
    await refused(c, "edit_workflow", { workflow: mine.id, bindings: { prompt: { node: "6", input: "nope" } } }, /not in the workflow/);
    expect(t.services.registry.pending(mine.id)).toBeUndefined();
    const edited = await ok(c, "edit_workflow", { workflow: mine.id, bindings: { negative: null }, title: "zz-test mine, no negative" });
    expect(edited).toMatchObject({ form: mine.id, title: "zz-test mine, no negative" });
    expect(edited.waitsForApproval).toMatch(/Approve/);
    expect(edited.inputs.map((i: { id: string }) => i.id)).not.toContain("negative");
    expect((await get(t.app, `/api/workflows/${mine.id}`)).json().bindings.negative ?? null).toBeNull();
    expect((await ok(c, "list_workflows")).workflows[0].waiting).toMatchObject({ by: "zz-test make" });
    await refused(c, "run_workflow", { workflow: mine.id, values: { prompt: "zz-test" } }, /waits for the user's approval/);
    // approving stays the user's: no tool does it
    expect((await c.listTools()).tools.map((x) => x.name).filter((n) => /approve/.test(n))).toEqual([]);
    await refused(c, "edit_workflow", { workflow: mine.id }, /Say what to change/);
    expect(await ok(c, "delete_workflow", { workflow: "zz-test mine, no negative" })).toMatchObject({ deleted: mine.id });
    expect((await get(t.app, "/api/workflows")).json().items).toEqual([]);
    await refused(c, "delete_workflow", { workflow: mine.id }, /no workflow called/);
    const look = await connect((await made("look")).token);
    await refused(look, "edit_workflow", { workflow: "x", title: "y" }, /needs Make/);
    await refused(look, "delete_workflow", { workflow: "x" }, /needs Make/);
    await look.close();
    await c.close();
  });
});
