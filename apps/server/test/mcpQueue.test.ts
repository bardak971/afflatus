import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oneAtATime } from "../src/keyedLock";
import { CHECKPOINT, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * The queue's controls from MCP (mcpQueue.ts), against a pretend RunPod with a running pod at $0.69 an hour beside the
 * user's own ComfyUI: what moves waiting work onto the pod (run_on, use_only, run_on "any") needs Spend and room in the
 * token's cap with the moved jobs counted, and the user's jobs moved there become the token's, so that the next move
 * counts them; a job is read and moved in the token's turn, never one another token took; Use only onto the pod pins the
 * jobs it counted there and pauses nothing (what the user queues afterwards stays theirs, off the pod); unloading a pod's
 * models needs Spend and room in the cap for the reload, and is refused on a pod the token did not start while others'
 * renders wait for it; Cancel all waiting leaves another token's jobs; Order works.
 */

const KEY = "rpa_test_key_0123456789";
const RECIPE = "sdxl.text-to-picture";
const VALUES = { prompt: "zz-test a lamp", checkpoint: CHECKPOINT };

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
  // the queue paused: what is queued waits, to be moved
  await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: {} });
});
afterEach(async () => {
  vi.restoreAllMocks();
  // the jobs Use only set going stopped first: the app's close waits for an idle queue, and a pretend ComfyUI never ends one
  const open = await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute();
  await Promise.all(open.map((j) => t.services.queue.cancel(j.id).catch(() => false)));
  await t.services.queue.idle();
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, a, runpod].map((x) => x.close().catch(() => {})));
});

async function made(start: "make" | "spend", over: { spendCapUsd?: number } = {}): Promise<{ token: string; id: string }> {
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
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(c, name, args);
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r)) as Record<string, unknown>;
};
const refusedWith = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await call(c, name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};
/** A render of the user's, from the page: waiting, nobody's token. */
const users = async (n: number, machine?: string) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await post(t.app, "/api/jobs", { recipe: RECIPE, input: { ...VALUES, prompt: `zz-test ${i}` }, ...(machine ? { machine } : {}) })).json().ids[0] as string);
  return ids;
};
const row = (id: string) => t.db.selectFrom("jobs").select(["id", "status", "pin_machine", "mcp_token_id", "priority"]).where("id", "=", id).executeTakeFirstOrThrow();

describe("run_on", () => {
  it("without Spend: refused onto the pod, and letting the user's job go while the pod is up; to the user's own machine it moves", async () => {
    const { token } = await made("make");
    const c = await connect(token);
    const [job] = await users(1, "m1");
    await refusedWith(c, "run_on", { job, machine: pod }, /cannot spend on rented GPUs, and running .* would send 1 job onto “pod-a”/);
    await refusedWith(c, "run_on", { job, machine: "any" }, /cannot spend on rented GPUs, and letting .* would send the user's 1 job onto/);
    expect(await row(job!)).toMatchObject({ pin_machine: "m1", mcp_token_id: null });
    await ok(c, "run_on", { job, machine: "m1" });
    expect(await row(job!)).toMatchObject({ pin_machine: "m1", mcp_token_id: null });
    await c.close();
  });

  it("with Spend: held to the cap with the jobs it moved counted, the user's made its own; the refusal says the sum", async () => {
    // $1 a month; each job on the pod weighed at the queue's floor (about $0.35) and the pod's idle time after (about $0.12):
    // two fit, the third would pass the cap only because the first two, the user's, are counted as this token's now
    const { token, id } = await made("spend", { spendCapUsd: 1 });
    const c = await connect(token);
    const jobs = await users(3);
    const first = await ok(c, "run_on", { job: jobs[0], machine: pod });
    expect(first.said).toMatch(/It was the user's/);
    await ok(c, "run_on", { job: jobs[1], machine: pod });
    expect(await row(jobs[0]!)).toMatchObject({ pin_machine: pod, mcp_token_id: id });
    await refusedWith(c, "run_on", { job: jobs[2], machine: pod }, /cap is \$1\.00 a month on rented GPUs, and it has spent \$0\.00 this month\. Committed: \$0\.\d\d, its 2 jobs running and waiting on rented pods .*\. This call adds \$0\.4\d: 1 job moved onto “pod-a” \(1 of them the user's, this token's to pay from now\), with the pod's idle time after: \$1\.\d\d in all, past the cap/);
    expect(await row(jobs[2]!)).toMatchObject({ pin_machine: null, mcp_token_id: null });
    await c.close();
  });

  it("reads the job in its turn: one another token took while it waited is refused, never pinned onto the pod for it", async () => {
    const a = await made("spend", { spendCapUsd: 5 });
    const b = await made("spend", { spendCapUsd: 5 });
    const c = await connect(a.token);
    const [job] = await users(1);
    // A's turn held (a render of its own being checked): its run_on waits for it, the user's job seen as the user's so far
    let release!: () => void;
    const held = oneAtATime(t.db, `mcp-render:${a.id}`, () => new Promise<void>((r) => (release = r)));
    const moving = call(c, "run_on", { job, machine: pod });
    await new Promise((r) => setTimeout(r, 200));
    // meanwhile B takes it (its use_only or its run_on made it B's)
    await t.db.updateTable("jobs").set({ mcp_token_id: b.id }).where("id", "=", job!).execute();
    release();
    await held;
    const r = await moving;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/queued by another token/);
    expect(await row(job!)).toMatchObject({ pin_machine: null, mcp_token_id: b.id });
    // the pin itself moves a job only for the user or the token it is: B's is not A's to send anywhere
    expect(await t.services.queue.pin(job!, pod, a.id)).toBe(false);
    expect(await t.services.queue.pin(job!, pod, b.id)).toBe(true);
    await c.close();
  });

  it("refuses another token's job", async () => {
    const other = await made("make");
    const c2 = await connect(other.token);
    const job = ((await ok(c2, "render", { form: RECIPE, values: VALUES, machine: "m1" })).jobs as string[])[0];
    const c = await connect((await made("spend")).token);
    await refusedWith(c, "run_on", { job, machine: "m1" }, /queued by another token/);
    await Promise.all([c.close(), c2.close()]);
  });
});

describe("use_only", () => {
  it("onto the pod: refused without Spend, and past the cap with every waiting job counted; within it, the user's become the token's", async () => {
    const jobs = await users(3);
    // the queue paused all over (beforeEach): Use only would set it going on the pod alone
    expect(t.services.queue.isPaused).toBe(true);
    const noSpend = await connect((await made("make")).token);
    await refusedWith(noSpend, "use_only", { machine: pod }, /cannot spend on rented GPUs, and using only “pod-a”/);
    // with nothing waiting too: what the user queues next would go to the pod
    await t.services.queue.cancelWaiting(jobs);
    await refusedWith(noSpend, "use_only", { machine: pod }, /cannot spend on rented GPUs, and using only “pod-a”/);
    jobs.splice(0, 3, ...(await users(3)));
    const { token, id } = await made("spend", { spendCapUsd: 1 });
    const c = await connect(token);
    // three at about $0.35 each and the idle time after: about $1.17
    await refusedWith(c, "use_only", { machine: pod }, /This call adds \$1\.\d\d: 3 jobs moved onto “pod-a” \(3 of them the user's/);
    expect(t.services.queue.isPaused).toBe(true);
    expect((await Promise.all(jobs.map(row))).every((r) => r.mcp_token_id === null)).toBe(true);
    expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { spendCapUsd: 5 } })).statusCode).toBe(200);
    const r = await ok(c, "use_only", { machine: pod });
    expect(r.said).toMatch(/3 jobs of the user's/);
    expect(r.pinned).toEqual(jobs);
    expect((await Promise.all(jobs.map(row))).every((x) => x.mcp_token_id === id && x.pin_machine === pod)).toBe(true);
    await Promise.all([c.close(), noSpend.close()]);
  });

  it("onto the pod pauses nothing: what the user queues afterwards stays theirs, never sent to the pod uncounted", async () => {
    // the user's queue going on their own machine, the pod paused by the user
    await t.services.queue.setPaused(false);
    await t.services.queue.setPaused(true, pod);
    await t.services.queue.setPaused(true, "m1");
    const jobs = await users(2);
    const { token, id } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    const r = await ok(c, "use_only", { machine: pod });
    expect(r.pinned).toEqual(jobs);
    // nothing paused or resumed by it: the user's machine as it was, the pod still paused (the token is told)
    expect(r.said).toMatch(/nothing is paused.*pod-a is paused: they wait until it is resumed/);
    expect(await t.services.queue.pausedOn("m1")).toBe(true);
    expect(await t.services.queue.pausedOn(pod)).toBe(true);
    await t.services.queue.setPaused(false, "m1");
    expect(await t.services.queue.pausedOn(pod)).toBe(true);
    // the user's next render: not this token's, not pinned to the pod, so it goes to the user's own machine and costs nothing
    const [later] = await users(1);
    expect(await row(later!)).toMatchObject({ pin_machine: null, mcp_token_id: null });
    await until(async () => (await row(later!)).status === "running");
    expect((await t.db.selectFrom("jobs").select("machine_id").where("id", "=", later!).executeTakeFirstOrThrow()).machine_id).toBe("m1");
    // the jobs it counted wait for the pod, this token's
    expect((await Promise.all(jobs.map(row))).every((x) => x.status === "queued" && x.mcp_token_id === id && x.pin_machine === pod)).toBe(true);
    await c.close();
  });

  it("onto the user's own machine is free: the pod is paused, nobody's jobs change hands", async () => {
    const [job] = await users(1);
    const c = await connect((await made("make")).token);
    await ok(c, "use_only", { machine: "m1" });
    expect(await t.services.queue.pausedOn(pod)).toBe(true);
    expect((await row(job!)).mcp_token_id).toBeNull();
    await c.close();
  });
});

describe("start_hunt and change_hunt, hold rest", () => {
  it("resting the user's machines is refused while the user's pod takes work (their work would go to it, counted by nobody); keep is not", async () => {
    // the hunt's rounds not run here: only its start and its change are asked
    t.services.hunt.stop();
    // the queue going: one render of the user's on each machine (the pretend ComfyUIs never end them), one waiting for a GPU
    await t.services.queue.setPaused(false);
    await users(3);
    await until(async () => (await t.db.selectFrom("jobs").select("id").where("status", "=", "running").execute()).length === 2);
    const { token } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    await refusedWith(c, "start_hunt", { ceiling: 0.5, hold: "rest" }, /A hunt resting the user's machines .* while “pod-a” is up would send the user's work onto it, the user's pod/);
    await refusedWith(c, "start_hunt", { ceiling: 0.5 }, /resting the user's machines/);
    expect(t.services.hunt.view().hunt).toBeNull();
    await ok(c, "start_hunt", { ceiling: 0.5, hold: "keep" });
    await refusedWith(c, "change_hunt", { hold: "rest" }, /resting the user's machines/);
    expect(t.services.hunt.view().hunt!.hold).toBe("keep");
    expect(await t.services.queue.pausedOn("m1")).toBe(false);
    await ok(c, "cancel_hunt");
    await c.close();
  });
});

describe("cancel_waiting", () => {
  it("cancels this token's and the user's, never another token's; with mine, this token's only", async () => {
    const mine = await made("make");
    const theirs = await made("make");
    const c = await connect(mine.token);
    const c2 = await connect(theirs.token);
    const [user] = await users(1);
    const own = ((await ok(c, "render", { form: RECIPE, values: VALUES, machine: "m1" })).jobs as string[])[0]!;
    const other = ((await ok(c2, "render", { form: RECIPE, values: VALUES, machine: "m1" })).jobs as string[])[0]!;
    const own2 = ((await ok(c, "render", { form: RECIPE, values: VALUES, machine: "m1" })).jobs as string[])[0]!;
    // with mine: its own two, the user's and the other token's left
    expect(await ok(c, "cancel_waiting", { mine: true })).toMatchObject({ cancelled: 2, left: 2 });
    expect((await row(own)).status).toBe("cancelled");
    expect((await row(own2)).status).toBe("cancelled");
    expect((await row(user!)).status).toBe("queued");
    expect(await ok(c, "cancel_waiting")).toMatchObject({ cancelled: 1, left: 1 });
    expect((await row(user!)).status).toBe("cancelled");
    expect((await row(other)).status).toBe("queued");
    await Promise.all([c.close(), c2.close()]);
  });
});

describe("order_queue and unload_models", () => {
  it("puts the jobs named first, in that order", async () => {
    const [x, y, z] = await users(3);
    const c = await connect((await made("make")).token);
    expect(await ok(c, "order_queue", { jobs: [z, "nope", x] })).toMatchObject({ first: [z, x], notWaiting: ["nope"] });
    const order = (await t.services.queue.status()).waiting.map((w) => w.id);
    expect(order).toEqual([z, x, y]);
    await refusedWith(c, "order_queue", { jobs: ["nope"] }, /None of these jobs is waiting/);
    await c.close();
  });

  it("needs Spend to unload a pod's models (its next render loads them again, billed); the user's own machine is free", async () => {
    const c = await connect((await made("make")).token);
    await refusedWith(c, "unload_models", { machine: pod }, /cannot spend on rented GPUs, and unloading the models on “pod-a”/);
    await refusedWith(c, "unload_models", {}, /name a machine of the user's own/);
    expect(await ok(c, "unload_models", { machine: "m1" })).toMatchObject({ unloaded: expect.any(String) });
    const s = await connect((await made("spend")).token);
    await ok(s, "unload_models", { machine: pod });
    await Promise.all([c.close(), s.close()]);
  });

  it("holds the reload to the token's cap, its work counted; on a pod it did not start, refused while others' renders wait there", async () => {
    // nothing waiting: the reload at the queue's floor for a load with no forecast (30 min at $0.69: about $0.35)
    const { token, id } = await made("spend", { spendCapUsd: 0.2 });
    const c = await connect(token);
    await refusedWith(c, "unload_models", { machine: pod }, /cap is \$0\.20 a month on rented GPUs.*Nothing else committed\. This call adds \$0\.3\d: the models loaded again on “pod-a”/);
    await refusedWith(c, "unload_models", {}, /This call adds \$0\.3\d: the models loaded again on “pod-a”/);
    expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { spendCapUsd: 0.7 } })).statusCode).toBe(200);
    // its own render waiting for the pod (about $0.47 with the idle time after): counted beside the reload, which then passes the cap
    const own = ((await ok(c, "render", { form: RECIPE, values: VALUES, machine: pod })).jobs as string[])[0]!;
    await refusedWith(c, "unload_models", { machine: pod }, /Committed: \$0\.\d\d, its 1 job running and waiting.*the models loaded again on “pod-a”/);
    await t.services.queue.cancel(own);
    await ok(c, "unload_models", { machine: pod });
    // a render of the user's that may go to the pod (the user started it, not this token): their reload is not this token's to cause
    const [user] = await users(1);
    await refusedWith(c, "unload_models", { machine: pod }, /1 render of the user's or another token's waits for “pod-a”, a pod this token did not start/);
    await refusedWith(c, "unload_models", {}, /waits for “pod-a”/);
    // pinned to the user's own machine, it does not wait for the pod
    await ok(c, "run_on", { job: user, machine: "m1" });
    await ok(c, "unload_models", { machine: pod });
    expect(await ok(c, "unload_models", { machine: "m1" })).toMatchObject({ unloaded: expect.any(String) });
    await c.close();
  });
});
