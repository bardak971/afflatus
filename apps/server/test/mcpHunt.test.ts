import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFakeRunpod, type FakeComfy, type FakeGpu, type FakeRunpod } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../src/settings";
import { job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Hunt a GPU from MCP (mcpQueue.ts start_hunt, hunt.ts mayDeploy), against a pretend RunPod: Spend and room in the token's
 * cap and the app's for a pod at the ceiling; the pod it deploys is the token's run; its deploy asked of the caps again
 * once a GPU is found (a token whose cap was lowered, or revoked, meanwhile deploys nothing and the hunt ends); a hunt is
 * changed only by the token that started it, cancelled by it or for the user's; a change in Afflatus makes it the user's.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];

const gpu = (id: string, name: string, price: number): FakeGpu => ({ id, name, memory: 48, price: { secure: price, community: null }, dataCenters: [{ id: "EU-RO-1", availability: "NONE" }] });

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    gpus: [gpu("NVIDIA A40", "A40", 0.44)],
    spawn: async () => {
      const c = Object.assign(await makeFake(), { packVersion: "0.13.0" });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  vi.spyOn(console, "log").mockImplementation(() => {});
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.rented.lookAgainMs = 5;
  // the rounds are run by the tests (no timer), each reading RunPod again
  t.services.hunt.stop();
  t.services.hunt.freshMs = 0;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  // renders waiting: the first runs on the home machine (the pretend ComfyUI never ends it), the others wait for a GPU
  for (let i = 0; i < 3; i++) await post(t.app, "/api/jobs", job({ prompt: `zz-test ${i}` }));
  await until(async () => (await t.db.selectFrom("jobs").select("id").where("status", "=", "running").execute()).length === 1);
});
afterEach(async () => {
  vi.restoreAllMocks();
  t.services.hunt.stop();
  await (t.services.hunt as unknown as { ticking: Promise<void> | null }).ticking;
  t.services.rented.stop();
  const open = await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute();
  await Promise.all(open.map((j) => t.services.queue.cancel(j.id).catch(() => false)));
  await t.services.queue.idle();
  await Promise.all(spawned.splice(0).map((x) => x.close().catch(() => {})));
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod].map((x) => x.close().catch(() => {})));
});

async function made(start: "make" | "spend", over: { spendCapUsd?: number } = {}): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  const id = res.json().view.id as string;
  if (Object.keys(over).length) await capOf(id, over.spendCapUsd!);
  return { token: res.json().token as string, id };
}
const capOf = async (id: string, usd: number) => expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}`, payload: { spendCapUsd: usd } })).statusCode).toBe(200);

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
const creates = () => runpod.calls.filter((c) => c === "POST /v2/pods").length;
const free = () => (runpod.gpus[0]!.dataCenters[0]!.availability = "HIGH");
/** A hunt at most $0.50 an hour for the GPU; 40 GB of container disk keeps the pod's hour near it. */
const HUNT = { ceiling: 0.5, disk: 40 };

describe("start_hunt", () => {
  it("needs Spend, and room in the token's cap for a pod at its ceiling: refused with the sum, no hunt", async () => {
    const noSpend = await connect((await made("make")).token);
    await refusedWith(noSpend, "start_hunt", HUNT, /Spend/);
    const c = await connect((await made("spend", { spendCapUsd: 0.3 })).token);
    await refusedWith(c, "start_hunt", HUNT, /cap is \$0\.30 a month on rented GPUs, and it has spent \$0\.00 this month\. Nothing else committed\. This call adds \$0\.5\d: the first hour of a pod found by the hunt, at its ceiling: \$0\.5\d in all, past the cap/);
    expect(t.services.hunt.view().hunt).toBeNull();
    await Promise.all([c.close(), noSpend.close()]);
  });

  it("is refused when the app's caps have no room for that first hour", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.2, month: 0 } } });
    const c = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await refusedWith(c, "start_hunt", HUNT, /The rented GPUs' spending cap has no room for this pod's first hour .*today's cap is \$0\.20/);
    expect(t.services.hunt.view().hunt).toBeNull();
    await c.close();
  });

  it("deploys the pod as the token's run once a GPU is free", async () => {
    const { token, id } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    const r = await ok(c, "start_hunt", HUNT);
    expect(r.hunt).toMatchObject({ status: "hunting", startedBy: "this token", deploy: { idleMinutes: 3, idleDo: "terminate" } });
    await t.services.hunt.tick();
    expect(creates()).toBe(0);
    free();
    await t.services.hunt.tick();
    expect(creates()).toBe(1);
    const st = t.services.hunt.view().hunt!;
    expect(st).toMatchObject({ status: "up", mcpToken: id });
    const pod = (await readSettings(t.db)).machines.find((m) => m.id === st.machine)!;
    expect(pod.rented?.mcpToken).toBe(id);
    expect(await ok(c, "hunt")).toMatchObject({ hunt: { status: "up", startedBy: "this token", found: { gpu: "A40" } } });
    await c.close();
  });

  it("deploys nothing when the token's cap has no room any more once the GPU is found, or it was revoked: the hunt ends", async () => {
    for (const how of ["cap", "revoke"] as const) {
      const { token, id } = await made("spend", { spendCapUsd: 5 });
      const c = await connect(token);
      await ok(c, "start_hunt", HUNT);
      if (how === "cap") await capOf(id, 0.3);
      else expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}/revoke`, payload: {} })).statusCode).toBe(200);
      free();
      await t.services.hunt.tick();
      expect(creates(), how).toBe(0);
      expect(t.services.hunt.view().hunt, how).toBeNull();
      runpod.gpus[0]!.dataCenters[0]!.availability = "NONE";
      await c.close();
    }
  });
});

describe("change_hunt and cancel_hunt", () => {
  it("change only the token's own hunt, a higher ceiling asked of its cap; another token's is refused", async () => {
    const mine = await made("spend", { spendCapUsd: 1 });
    const c = await connect(mine.token);
    const c2 = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await ok(c, "start_hunt", HUNT);
    await refusedWith(c2, "change_hunt", { ceiling: 0.6 }, /started by another token \(zz-test spend\)/);
    await refusedWith(c2, "cancel_hunt", {}, /started by another token/);
    await refusedWith(c, "change_hunt", { ceiling: 2 }, /cap is \$1\.00 a month .*at its new ceiling/);
    expect(t.services.hunt.view().hunt!.ceiling).toBe(0.5);
    expect(await ok(c, "change_hunt", { ceiling: 0.6, mode: "cheap" })).toMatchObject({ hunt: { ceiling: 0.6, mode: "cheap" } });
    expect(await ok(c, "cancel_hunt")).toMatchObject({ cancelled: true });
    expect(t.services.hunt.view().hunt).toBeNull();
    await Promise.all([c.close(), c2.close()]);
  });

  it("the user's hunt: a token cancels it but does not change it; a change in Afflatus makes a token's hunt the user's", async () => {
    const c = await connect((await made("spend", { spendCapUsd: 5 })).token);
    expect((await post(t.app, "/api/hunt", { ceiling: 0.5, deploy: { disk: 40 } })).statusCode).toBe(200);
    await refusedWith(c, "change_hunt", { ceiling: 0.6 }, /started by the user/);
    await ok(c, "cancel_hunt");
    expect(t.services.hunt.view().hunt).toBeNull();
    await ok(c, "start_hunt", HUNT);
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { ceiling: 0.6 } })).statusCode).toBe(200);
    expect(t.services.hunt.view().hunt!.mcpToken).toBe("");
    await c.close();
  });
});
