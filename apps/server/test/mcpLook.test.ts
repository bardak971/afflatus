import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER } from "../src/db";
import { HIDDEN, scrubbed, secretsOf } from "../src/logScrub";
import { checkAgain } from "../src/mcpRender";
import type { ShowEvent } from "../src/mcpShow";
import { readSettings, updateSettings } from "../src/settings";
import { complete, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * What an agent reads to find out why something went wrong and looks up as it writes (mcpLook.ts), and show_page
 * (mcpShow.ts), through the SDK's client over HTTP: ComfyUI's log and a pod's boot log without a secret or a folder on a disk,
 * a running job's stages and live preview, the render times, the volumes, a model file's page and words, the prompts, and a
 * page asked to go somewhere (gone, asked while the user types, none open, none in front).
 */

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

async function connect(scopes: string[]): Promise<Client> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test look", start: "look" } });
  expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${res.json().view.id as string}`, payload: { scopes } })).statusCode).toBe(200);
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${res.json().token as string}` } } }));
  return client;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r)) as Record<string, any>;
};
const refused = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  return textOf(r);
};

const CIVITAI = "0123456789abcdef0123456789abcdef";
const HF = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const LOCK = "zz-lock-token-Q9w8E7r6T5y4U3i2";
const PATH_WIN = "C:\\Users\\someone\\ComfyUI\\custom_nodes\\zz-pack\\nodes.py";
const PATH_UNIX = "/home/someone/ComfyUI/models/loras/zz-test.safetensors";

/** The lines a log may say that hold a secret or a folder on a disk. */
const DIRTY = [
  `Downloading https://civitai.com/api/download/models/1?type=Model&token=${CIVITAI}`,
  `Civitai key ${CIVITAI} refused`,
  `HF_TOKEN=${HF}`,
  `AFFLATUS_LOCK_TOKEN=${LOCK}`,
  `lock token is ${LOCK}`,
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
  "https://zz-user:zz-password-1234@example.com/file",
  "https://bucket.s3.example.com/x?X-Amz-Credential=AKIAZZTEST&X-Amz-Signature=deadbeefdeadbeef",
  "afl_mcp_ZZtestTokenZZtestTokenZZtestTokenZZtestTo",
  `  File "${PATH_WIN}", line 12, in run`,
  `Loading ${PATH_UNIX}`,
  "tokenizer: loaded",
];
const SECRETS = [CIVITAI, HF, LOCK, "abcdefghijklmnopqrstuvwxyz0123", "zz-password-1234", "deadbeefdeadbeef", "AKIAZZTEST", "afl_mcp_ZZ", "someone"];

async function withSecrets(): Promise<void> {
  await updateSettings(t.db, (cur) => ({ civitaiKey: CIVITAI, huggingFaceToken: HF, machines: cur.machines.map((m) => ({ ...m, token: LOCK })) }));
}

describe("scrubbed", () => {
  it("takes out every secret the settings keep and what looks like one, and makes each path its file's name", async () => {
    await withSecrets();
    const secrets = secretsOf(await readSettings(t.db));
    expect(secrets).toEqual(expect.arrayContaining([CIVITAI, HF, LOCK]));
    const out = DIRTY.map((l) => scrubbed(l, secrets)).join("\n");
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).toContain(HIDDEN);
    // what the lines still say: the file's name, the line, a word that only starts with a secret's name
    expect(out).toContain("nodes.py\", line 12");
    expect(out).toContain("Loading zz-test.safetensors");
    expect(out).toContain("tokenizer: loaded");
    expect(out).toContain("AFFLATUS_LOCK_TOKEN=[hidden]");
  });
});

describe("the logs", () => {
  it("comfy_log reads ComfyUI's log scrubbed, the last lines and those holding words", async () => {
    await withSecrets();
    fake.printed.push(...DIRTY, "zz-test the end");
    const c = await connect(["look"]);
    const all = await ok(c, "comfy_log");
    expect(all.source).toBe("ComfyUI");
    const text = JSON.stringify(all);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(all.lines.at(-1).m).toBe("zz-test the end");
    expect((await ok(c, "comfy_log", { last: 2 })).lines).toHaveLength(2);
    const found = await ok(c, "comfy_log", { find: "LINE 12" });
    expect(found.lines.map((l: { m: string }) => l.m)).toEqual(['  File "nodes.py", line 12, in run']);
    // a word of a secret finds nothing: it is looked for in what the agent may read
    expect((await ok(c, "comfy_log", { find: CIVITAI.slice(0, 12) })).lines).toEqual([]);
    expect(await refused(c, "comfy_log", { machine: "nope" })).toMatch(/no machine called “nope”/);
    await c.close();
  });

  it("boot_log lists the runs kept, reads one scrubbed, and says a ComfyUI of the user's own has none", async () => {
    await withSecrets();
    const c = await connect(["look"]);
    expect(await ok(c, "boot_log")).toMatchObject({ runs: [], said: expect.stringMatching(/not kept/) });
    const log = { system: [{ ts: "2026-10-29T10:00:00Z", line: `pulling with ${HF}` }], pod: [{ t: "2026-10-29T10:01:00Z", m: `AFFLATUS_LOCK_TOKEN=${LOCK}` }, { t: "2026-10-29T10:02:00Z", m: `cd ${PATH_UNIX}` }] };
    await t.db.insertInto("rent_sessions").values({ id: "zz-run", machine_id: "rp", pod: "p", rate: 0.3, started_at: "2026-10-29T10:00:00Z", ended_at: null, seen_at: null, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null, boot_log: JSON.stringify(log) } as never).execute();
    const list = await ok(c, "boot_log");
    expect(list.runs).toEqual([expect.objectContaining({ run: "zz-run", gpu: "NVIDIA A40" })]);
    const one = await ok(c, "boot_log", { run: "zz-run" });
    const text = one.lines.join("\n");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("pulling with [hidden]");
    expect(text).toContain("cd zz-test.safetensors");
    expect(await refused(c, "boot_log", { run: "nope" })).toMatch(/boot log kept/);
    expect(await refused(c, "boot_log", { machine: "m1" })).toMatch(/not a rented pod/);
    await c.close();
  });
});

describe("a running job", () => {
  it("job_live says nothing runs, then its phase, stages and live preview as a picture", async () => {
    const c = await connect(["look"]);
    expect(await refused(c, "job_live")).toMatch(/Nothing is rendering/);
    const id = (await post(t.app, "/api/jobs", job({ steps: 20 }))).json().ids[0] as string;
    await until(() => fake.prompts.size === 1);
    const promptId = [...fake.prompts.keys()][0]!;
    const sampler = Object.entries(fake.prompts.get(promptId)!).find(([, n]) => n.class_type === "KSampler")![0];
    fake.send("execution_start", { prompt_id: promptId });
    fake.send("progress", { prompt_id: promptId, node: sampler, value: 5, max: 20 });
    fake.sendBinary(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 42, 43]));
    await until(async () => (await t.services.queue.progress())?.previewSeq === 1);
    const r = await c.callTool({ name: "job_live", arguments: { job: id } });
    expect(r.isError).toBeFalsy();
    const [said, picture] = r.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(JSON.parse(said!.text!)).toMatchObject({ job: id, phase: "sampling", step: 5, steps: 20, stages: [] });
    expect(picture).toMatchObject({ type: "image", mimeType: "image/jpeg", data: Buffer.from([42, 43]).toString("base64") });
    expect(await refused(c, "job_live", { job: id, stage: 0 })).toMatch(/no stage 0.*shown none yet/);
    expect(await refused(c, "job_live", { job: "nope" })).toMatch(/not running/);
    // job says when to ask again, from the queue's forecast, or that there is none
    expect((await ok(c, "job", { job: id })).hint).toMatch(/check again in ~\d+ s|no forecast/);
    complete(fake, promptId);
    await c.close();
  });
});

describe("job's hint", () => {
  it("says the time left and when to check again, from the ETA in seconds or the wait and the estimate", () => {
    expect(checkAgain({ status: "running", eta: 130 })).toBe("about 2 min 10 s left: check again in ~130 s");
    expect(checkAgain({ status: "waiting", startsInMs: 60_000, estimateMs: 45_000 })).toBe("about 1 min 45 s left (waiting, then rendering): check again in ~105 s");
    expect(checkAgain({ status: "running", eta: 0 })).toBeNull();
    expect(checkAgain({ status: "waiting", estimateMs: null })).toBeNull();
  });
});

describe("render times and volumes", () => {
  it("render_stats gives the figures without the charts' series, or the renders themselves", async () => {
    const c = await connect(["look"]);
    const sum = await ok(c, "render_stats", { period: "month" });
    expect(sum).toMatchObject({ period: "month", tiles: expect.objectContaining({ done: 0 }) });
    expect(sum.finished).toBeUndefined();
    expect(sum.buckets).toBeUndefined();
    expect(await ok(c, "render_stats", { renders: true })).toMatchObject({ items: [] });
    expect(await refused(c, "render_stats", { from: "2026-10-01T00:00:00Z" })).toMatch(/both `from` and `to`/);
    await c.close();
  });

  it("network_volumes needs a RunPod key", async () => {
    const c = await connect(["look"]);
    expect(await refused(c, "network_volumes")).toMatch(/No RunPod API key/);
    await c.close();
  });

  it("model_updates says the hashing and the update check", async () => {
    const c = await connect(["look"]);
    const got = await ok(c, "model_updates");
    expect(got.hashes).toHaveProperty("hashed");
    expect(got.updates).toMatchObject({ items: [], newer: 0 });
    await c.close();
  });
});

describe("a model file's page and words", () => {
  it("model_page reads the header, the page and the words; set_model_words needs Manage and puts the user's own first", async () => {
    await t.db.insertInto("model_info").values({ folder: "loras", file: "sub/zz-test-lamp.safetensors", info: JSON.stringify({ trigger: "zzlamp", tags: ["lamp", "glow"], v: 9 }), read_at: "2026-10-29T10:00:00Z" }).execute();
    await t.db.insertInto("model_pages").values({ folder: "loras", name: "zz-test-lamp.safetensors", url: "https://civitai.com/models/1", title: "Lamp", found_at: "2026-10-29T10:00:00Z" }).execute();
    const look = await connect(["look"]);
    const read = await ok(look, "model_page", { folder: "loras", file: "zz-test-lamp.safetensors" });
    expect(read).toMatchObject({ file: "sub/zz-test-lamp.safetensors", header: { trigger: "zzlamp", tags: ["lamp", "glow"] }, page: { url: "https://civitai.com/models/1" }, words: { yours: null, civitai: null } });
    expect(read.header.v).toBeUndefined();
    expect(await refused(look, "set_model_words", { folder: "loras", file: "zz-test-lamp.safetensors", words: "zz glow" })).toMatch(/Manage/);
    expect((await ok(look, "model_page", { folder: "loras", file: "zz-test-none.safetensors" })).header).toBeNull();
    // looking it up with lookups off asks no site
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: false } });
    expect((await ok(look, "model_page", { folder: "loras", file: "zz-test-lamp.safetensors", find: true })).lookups).toMatch(/off/);
    await look.close();
    const manage = await connect(["look", "manage"]);
    expect((await ok(manage, "set_model_words", { folder: "loras", file: "sub/zz-test-lamp.safetensors", words: "  zz glow " })).words).toEqual({ yours: "zz glow", civitai: null });
    expect((await t.app.inject({ method: "GET", url: "/api/models/loras/words" })).json().items["zz-test-lamp.safetensors"]).toEqual({ own: "zz glow", found: null });
    expect((await ok(manage, "set_model_words", { folder: "loras", file: "zz-test-lamp.safetensors", words: null })).words.yours).toBeNull();
    expect(await refused(manage, "model_page", { folder: "../x", file: "a" })).toBeTruthy();
    await manage.close();
  });
});

describe("prompts", () => {
  it("prompt_history, check_tags and prompt_from_parts", async () => {
    await t.db.insertInto("generations").values({ id: "g1", owner_id: OWNER, recipe_id: "sdxl.text-to-picture", recipe_version: 1, family: "sdxl", inputs: JSON.stringify({ prompt: "zz-test a lamp at dusk" }), resolved: "{}", gen_ms: 1000, draft_id: null, created_at: "2026-10-29T10:00:00Z" } as never).execute();
    const c = await connect(["look"]);
    expect((await ok(c, "prompt_history", { q: "lamp" })).prompts).toEqual([expect.objectContaining({ prompt: "zz-test a lamp at dusk", form: "sdxl.text-to-picture", item: null })]);
    expect((await ok(c, "prompt_history", { q: "nothing like it" })).prompts).toEqual([]);
    const tags = await ok(c, "check_tags", { text: "1girl, zzunknowntagzz" });
    expect(tags.issues).toEqual([expect.objectContaining({ tag: "zzunknowntagzz", status: "unknown" })]);
    const parts = await ok(c, "prompt_from_parts", { form: "h3.swap", values: { inSource: "the man", look: "", happens: "" } });
    expect(parts.into).toBe("who");
    expect(parts.text).toMatch(/the man/);
    expect(await ok(c, "prompt_from_parts", { form: "sdxl.text-to-picture", values: {} })).toMatchObject({ into: null });
    expect(await refused(c, "prompt_from_parts", { form: "nope", values: {} })).toMatch(/no form called/);
    await c.close();
  });
});

describe("show_page", () => {
  const draftNamed = async () => {
    const recipe = "sdxl.text-to-picture";
    const d = (await post(t.app, "/api/drafts", { recipe, forms: { [recipe]: { prompt: "zz-test a portrait" } } })).json() as { id: string };
    await t.app.inject({ method: "PUT", url: `/api/drafts/${d.id}`, payload: { name: "zz-test portrait" } });
    return d;
  };
  const timeline = async () => {
    const tl = (await post(t.app, "/api/timelines", { name: "zz-test trailer" })).json() as { id: string };
    return tl.id;
  };
  /** A page that hears the "show" events and answers as agentShow.ts does. */
  const page = (did: "moved" | "asked" | null) => {
    const heard: ShowEvent[] = [];
    t.services.mcp.where.pagesOpen = () => 1;
    t.services.queue.events.on("show", (e: ShowEvent) => {
      heard.push(e);
      if (did) void post(t.app, "/api/where/shown", { ask: e.ask, did });
    });
    return heard;
  };

  it("says when no page is open, and refuses what is not there", async () => {
    const c = await connect(["look", "make"]);
    const draft = await draftNamed();
    expect(await ok(c, "show_page", { draft: draft.id })).toMatchObject({ shown: false, said: expect.stringMatching(/No page of Afflatus is open/) });
    expect(await refused(c, "show_page", {})).toMatch(/Name one thing/);
    expect(await refused(c, "show_page", { draft: draft.id, settings: "models" })).toMatch(/Name one thing/);
    expect(await refused(c, "show_page", { draft: "nope" })).toMatch(/draft/);
    expect(await refused(c, "show_page", { clip: 1 })).toMatch(/name the timeline/);
    expect(await refused(c, "show_page", { timeline: await timeline(), clip: 2 })).toMatch(/no such clip/);
    await c.close();
    const look = await connect(["look"]);
    expect(await refused(look, "show_page", { settings: "models" })).toMatch(/Make/);
    await look.close();
  });

  it("goes to the browser seen last, and says whether its page went there or asked the user", async () => {
    await t.app.inject({ method: "POST", url: "/api/where", payload: { key: "zz-browser-key-1", path: "/queue" } });
    const heard = page("moved");
    const c = await connect(["look", "make"]);
    const draft = await draftNamed();
    expect(await ok(c, "show_page", { draft: draft.id })).toMatchObject({ shown: true, said: "The user's page now shows the draft “zz-test portrait”." });
    expect(heard[0]).toMatchObject({ by: "zz-test look", browser: "zz-browser-key-1", said: "the draft “zz-test portrait”", to: { draft: draft.id } });
    expect(await ok(c, "show_page", { settings: "rented", setting: "rented.bootlogs" })).toMatchObject({ shown: true });
    expect(heard[1]!.to).toEqual({ settings: "rented", setting: "rented.bootlogs" });
    expect(heard[1]!.said).toBe("Settings › Rented GPUs");
    // a tab since gone (card #168) lands on the one that has its settings now: an agent naming the old one is sent there
    expect(await ok(c, "show_page", { settings: "access", setting: "access.password" })).toMatchObject({ shown: true });
    expect(heard[2]).toMatchObject({ said: "Settings › Sign-in", to: { settings: "signin", setting: "access.password" } });
    expect(await ok(c, "show_page", { settings: "designer" })).toMatchObject({ shown: true });
    expect(heard[3]).toMatchObject({ said: "Settings › Prompts", to: { settings: "prompts" } });
    // a setting named with a tab it is not on: the page opens the setting's own tab, and the agent is told that one
    expect(await ok(c, "show_page", { settings: "interface", setting: "notify.what" })).toMatchObject({ shown: true, said: "The user's page now shows Settings › Notifications." });
    expect(heard[4]).toMatchObject({ to: { settings: "notifications", setting: "notify.what" } });
    await c.close();
  });

  it("says the user was asked while they typed, and that no page in front answered", async () => {
    page("asked");
    const c = await connect(["look", "make"]);
    expect(await ok(c, "show_page", { settings: "models" })).toMatchObject({ shown: false, asked: true, said: expect.stringMatching(/was typing/) });
    t.services.queue.events.removeAllListeners("show");
    page(null);
    expect(await ok(c, "show_page", { settings: "models" })).toMatchObject({ shown: false, said: expect.stringMatching(/no page of it is in front/) });
    // an answer too late, or to nothing asked, is no one's
    expect((await post(t.app, "/api/where/shown", { ask: "zz-unknown-ask", did: "moved" })).json()).toEqual({ ok: false });
    await c.close();
  });
});
