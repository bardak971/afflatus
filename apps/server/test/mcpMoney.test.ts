import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_FULL } from "../src/mcpRender";
import { NO_SPEND } from "../src/queuePlan";
import { updateSettings } from "../src/settings";
import { CHECKPOINT, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * MCP renders where money is at stake (mcpRender.ts, queuePlan.ts offPods), against a pretend RunPod with a running pod at
 * $0.69 an hour beside the user's own ComfyUI: a token without Spend never lands on the pod, pinned (refused) or picked by
 * the queue (kept off at every pass, until Spend is ticked); a token with Spend is held to its cap with its waiting work
 * counted; renders an hour hold; Again and Load the model keep the same rules.
 */

const KEY = "rpa_test_key_0123456789";
const RECIPE = "sdxl.text-to-picture";
const FORM = { form: RECIPE, values: { prompt: "zz-test a lamp", checkpoint: CHECKPOINT } };

let home: FakeComfy;
let a: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
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

async function made(start: "make" | "spend", over: { rendersPerHour?: number; spendCapUsd?: number } = {}): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  const id = res.json().view.id as string;
  if (Object.keys(over).length) expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: over })).statusCode).toBe(200);
  return { token: res.json().token as string, id };
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
const call = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
const jobsOf = (id: string) => t.db.selectFrom("jobs").select(["id", "status", "machine_id", "pin_machine"]).where("mcp_token_id", "=", id).execute();
const pause = (machine?: string) => t.app.inject({ method: "POST", url: "/api/queue/pause", payload: machine ? { machine } : {} });
const refusedWith = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await call(c, name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};

describe("a token without Spend", () => {
  it("is refused a render pinned to a rented pod, and nothing is queued", async () => {
    const { token, id } = await made("make");
    const c = await connect(token);
    await refusedWith(c, "render", { ...FORM, machine: pod }, /cannot spend on rented GPUs, and .* is one/);
    await refusedWith(c, "load_model", { ...FORM, machine: pod }, /cannot spend on rented GPUs/);
    expect(await jobsOf(id)).toEqual([]);
    const lines = await t.services.mcp.tokens.activity(id);
    expect(lines.every((l) => l.refused && !l.failed)).toBe(true);
    await c.close();
  });

  it("never lands on the pod when the queue picks, even with the user's own machine paused; Spend ticked, it may", async () => {
    const { token, id } = await made("make");
    const c = await connect(token);
    await pause("m1");
    const r = await call(c, "render", FORM);
    expect(r.isError, textOf(r)).toBeFalsy();
    const job = JSON.parse(textOf(r)).jobs[0] as string;
    // passes come and go with the pod free: the job stays waiting, said kept off the pod for the token
    await t.services.queue.idle();
    await new Promise((go) => setTimeout(go, 150));
    await t.services.queue.idle();
    expect(a.prompts.size).toBe(0);
    expect((await jobsOf(id))[0]).toMatchObject({ id: job, status: "queued", machine_id: null });
    const row = (await t.services.queue.status()).waiting.find((w) => w.id === job)!;
    expect(row.lacks?.[pod]?.why).toBe(NO_SPEND);
    // Spend ticked on it: from the next pass, the pod may take it
    expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { scopes: ["look", "make", "spend"] } })).statusCode).toBe(200);
    await until(() => a.prompts.size > 0);
    await c.close();
  });

  it("is refused when the user has no machine of their own to render on", async () => {
    await updateSettings(t.db, (s) => ({ machines: s.machines.filter((m) => m.rented) }));
    const c = await connect((await made("make")).token);
    await refusedWith(c, "render", FORM, /no machine of their own/);
    await c.close();
  });

  it("is refused Again of a job pinned to the pod, and Again of the user's own job is its own", async () => {
    const { token, id } = await made("make");
    const c = await connect(token);
    await pause();
    const pinned = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: FORM.values, machine: pod })).json().ids[0] as string;
    const loose = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: FORM.values })).json().ids[0] as string;
    await t.services.queue.cancel(pinned);
    await t.services.queue.cancel(loose);
    await refusedWith(c, "retry", { job: pinned }, /cannot spend on rented GPUs/);
    const again = JSON.parse(textOf(await call(c, "retry", { job: loose }))).job as string;
    expect((await jobsOf(id)).map((j) => j.id)).toEqual([again]);
    await c.close();
  });
});

describe("a token with Spend", () => {
  it("is held to its own cap with its waiting work counted, not only what it was billed", async () => {
    // $1 a month; nothing like it rendered yet: each render on the pod is weighed at the queue's floor, 30 min at the pod's
    // rate ($0.69 for its GPU, a little more with its disk: about $0.35)
    const { token, id } = await made("spend", { spendCapUsd: 1 });
    const c = await connect(token);
    await pause();
    const first = await call(c, "render", { ...FORM, takes: 2 });
    expect(first.isError, textOf(first)).toBeFalsy();
    const cost = JSON.parse(textOf(first)).mayCostUsd as number;
    expect(cost).toBeGreaterThan(0.68);
    expect(cost).toBeLessThan(0.8);
    // two more would make about $1.40 with the two waiting, past the cap: refused, though nothing was billed yet
    await refusedWith(c, "render", { ...FORM, takes: 2 }, /cap is \$1(\.00)? a month/);
    await refusedWith(c, "render", { ...FORM, takes: 2, machine: pod }, /cap is/);
    // on the user's own machine it costs nothing: not held to the cap
    const own = await call(c, "render", { ...FORM, takes: 2, machine: "m1" });
    expect(own.isError, textOf(own)).toBeFalsy();
    expect((await jobsOf(id)).length).toBe(4);
    await c.close();
  });

  it("has its waiting jobs handed to a pod started later only while its cap has room, each held one saying why", async () => {
    // the pod stopped: four takes queued cost nothing then (no pod to land on), with the user's own machine paused
    const { token, id } = await made("spend", { spendCapUsd: 1 });
    const c = await connect(token);
    await pause("m1");
    expect((await post(t.app, `/api/machines/${pod}/stop`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "EXITED"));
    await t.services.rented.poll();
    const r = await call(c, "render", { ...FORM, takes: 4 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r)).mayCostUsd).toBeUndefined();
    const jobs = JSON.parse(textOf(r)).jobs as string[];
    // the user starts the pod: the first goes there, the second still fits ($0.35 each at the queue's floor), the other two
    // would pass $1 and wait, said so on their rows
    expect((await post(t.app, `/api/machines/${pod}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await t.services.rented.poll();
    await until(() => a.prompts.size > 0);
    // a pass after the first went: the rows as the next plan says them
    await until(async () => (await t.services.queue.status()).waiting.filter((w) => w.lacks?.[pod]?.why === CAP_FULL).length === 2, 10_000, 50);
    const rows = (await t.services.queue.status()).waiting;
    const why = (job: string) => rows.find((w) => w.id === job)?.lacks?.[pod]?.why;
    expect((await jobsOf(id)).filter((j) => j.status === "running").map((j) => j.machine_id)).toEqual([pod]);
    expect(why(jobs[1]!)).toBeUndefined();
    expect(why(jobs[2]!)).toBe(CAP_FULL);
    expect(why(jobs[3]!)).toBe(CAP_FULL);
    // the cap raised: from the next pass they may go
    expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { spendCapUsd: 5 } })).statusCode).toBe(200);
    await until(async () => !(await t.services.queue.status()).waiting.some((w) => w.lacks?.[pod]?.why === CAP_FULL), 10_000, 50);
    await c.close();
  });

  it("has its waiting jobs kept off the pods when Spend is unticked after they were queued", async () => {
    const { token, id } = await made("spend");
    const c = await connect(token);
    await pause();
    const job = JSON.parse(textOf(await call(c, "render", FORM))).jobs[0] as string;
    expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { scopes: ["look", "make"] } })).statusCode).toBe(200);
    await pause("m1");
    expect((await t.app.inject({ method: "POST", url: "/api/queue/resume", payload: { machine: pod } })).statusCode).toBe(200);
    await new Promise((go) => setTimeout(go, 150));
    await t.services.queue.idle();
    expect(a.prompts.size).toBe(0);
    expect((await t.services.queue.status()).waiting.find((w) => w.id === job)?.lacks?.[pod]?.why).toBe(NO_SPEND);
    await c.close();
  });

  it("queues one render at a time per token: two at once cannot both pass a cap that holds one", async () => {
    const { token, id } = await made("spend", { spendCapUsd: 0.5 });
    const c = await connect(token);
    await pause();
    const both = await Promise.all([call(c, "render", FORM), call(c, "render", FORM)]);
    expect(both.filter((r) => r.isError)).toHaveLength(1);
    expect((await jobsOf(id)).length).toBe(1);
    await c.close();
  });
});

describe("every token", () => {
  it("is held to its renders an hour", async () => {
    const { token } = await made("make", { rendersPerHour: 3 });
    const c = await connect(token);
    await pause();
    expect((await call(c, "render", { ...FORM, takes: 2 })).isError).toBeFalsy();
    await refusedWith(c, "render", { ...FORM, takes: 2 }, /limit is 3 renders an hour, and 2 went/);
    expect((await call(c, "render", FORM)).isError).toBeFalsy();
    await c.close();
  });
});
