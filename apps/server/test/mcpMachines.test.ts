import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings, updateSettings } from "../src/settings";
import { makeApp, makeFake, until, type TestApp } from "./helpers";

/**
 * The machines and the rented GPUs through MCP (mcpMachines.ts), through the SDK's client against a pretend RunPod: every
 * money refusal (no Spend, the token's cap, the app's caps, no room for a pod's first hour, a stop or terminate), a pod
 * deployed by a token whose whole run counts against its cap and stops at it, and the machines listed, added, changed,
 * removed and asked again.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 30, pods: [],
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
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

async function made(start: "look" | "make" | "spend" | "all", over: { spendCapUsd?: number; scopes?: string[] } = {}): Promise<{ token: string; id: string }> {
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
  return JSON.parse(textOf(r)) as Record<string, any>;
};
const refusedWith = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await call(c, name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};
const creates = () => runpod.calls.filter((c) => c === "POST /v2/pods").length;
const DEPLOY = { gpu: "A40", cloud: "SECURE", disk: 120, idleMinutes: 2, idleDo: "terminate" };

describe("deploy_pod: every money refusal", () => {
  it("is refused without Spend, and nothing is asked of RunPod", async () => {
    // every scope but Spend
    const c = await connect((await made("make", { scopes: ["look", "make", "manage"] })).token);
    await refusedWith(c, "deploy_pod", DEPLOY, /cannot spend on rented GPUs/);
    await refusedWith(c, "start_pod", { machine: "x" }, /cannot spend on rented GPUs/);
    await refusedWith(c, "stop_pod", { machine: "x", how: "terminate" }, /cannot spend on rented GPUs/);
    expect(creates()).toBe(0);
    await c.close();
  });

  it("is refused when the token's cap has no room for the pod's first hour", async () => {
    // the A40 at $0.44 an hour and its 120 GB disk: about $0.456 an hour, over a $0.40 cap
    const { token } = await made("spend", { spendCapUsd: 0.4 });
    const c = await connect(token);
    await refusedWith(c, "deploy_pod", DEPLOY, /This token's cap is \$0\.40 a month on rented GPUs/);
    expect(creates()).toBe(0);
    await c.close();
  });

  it("is refused when the app's day or month cap has no room for its first hour, though the token's has", async () => {
    const { token } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    await updateSettings(t.db, () => ({ rentCaps: { day: 0.3, month: 0 } }));
    await refusedWith(c, "deploy_pod", DEPLOY, /spending cap has no room for this pod's first hour .*today's cap is \$0\.30/);
    await updateSettings(t.db, () => ({ rentCaps: { day: 0, month: 0.45 } }));
    await refusedWith(c, "deploy_pod", DEPLOY, /this month's cap is \$0\.45/);
    expect(creates()).toBe(0);
    await c.close();
  });

  it("refuses a GPU RunPod does not offer, and an idle stop of never", async () => {
    const c = await connect((await made("spend")).token);
    await refusedWith(c, "deploy_pod", { ...DEPLOY, gpu: "B9000" }, /does not offer B9000/);
    await refusedWith(c, "deploy_pod", { ...DEPLOY, idleMinutes: 0 }, /idleMinutes/);
    expect(creates()).toBe(0);
    await c.close();
  });
});

describe("deploy_pod and start_pod: the pods already up", () => {
  it("count the next hour of the token's own pods against its cap", async () => {
    // the A40 at about $0.456 an hour: one fits a $0.80 cap, a second with the first's next hour does not
    const { token } = await made("spend", { spendCapUsd: 0.8 });
    const c = await connect(token);
    await ok(c, "deploy_pod", DEPLOY);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    await refusedWith(c, "deploy_pod", DEPLOY, /This token's cap is \$0\.80/);
    expect(creates()).toBe(1);
    await c.close();
  });

  it("count the next hour of every pod up against the app's caps", async () => {
    await updateSettings(t.db, () => ({ rentCaps: { day: 0.8, month: 0 } }));
    const first = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await ok(first, "deploy_pod", DEPLOY);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    // another token: its own cap has room, the app's day does not with the first pod's next hour
    const second = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await refusedWith(second, "deploy_pod", DEPLOY, /no room for this pod's first hour \(\$0\.46, with the next hour of the pods up: \$0\.46\)/);
    expect(creates()).toBe(1);
    await first.close();
    await second.close();
  });

  it("say the sum a cap was asked: spent, the pods up and their next hour, the new pod's first hour", async () => {
    // the A40 with its disk bills about $0.456 an hour: one fits a $0.80 cap, a second beside the first's next hour does not
    const c = await connect((await made("spend", { spendCapUsd: 0.8 })).token);
    await ok(c, "deploy_pod", DEPLOY);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    await refusedWith(c, "deploy_pod", DEPLOY, /This token's cap is \$0\.80 a month on rented GPUs, and it has spent \$0\.0\d this month\. Committed: \$0\.46, the next hour of “.+”, up \(started by this token\)\. This call adds \$0\.46: the first hour of a new “A40”: \$0\.9\d in all, past the cap\./);
    // the app's day cap: what is spent today, the pods up by name, and the sum
    await updateSettings(t.db, () => ({ rentCaps: { day: 0.8, month: 0 } }));
    const other = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await refusedWith(other, "deploy_pod", DEPLOY, /first hour \(\$0\.46, with the next hour of the pods up: \$0\.46\): today's cap is \$0\.80, \$0\.0\d is spent today, and \$0\.91 more makes \$0\.9\d\. Up: “.+” \$0\.46 an hour\./);
    expect(creates()).toBe(1);
    await c.close();
    await other.close();
  });

  it("start_pod refuses a pod set to never stop when idle, or without a watchdog", async () => {
    const { token } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    const machine = (await ok(c, "deploy_pod", { ...DEPLOY, idleDo: "stop" })).machine as string;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    await ok(c, "stop_pod", { machine, how: "stop" });
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "EXITED"));
    const set = (rented: Record<string, unknown>) => updateSettings(t.db, (x) => ({ machines: x.machines.map((m) => (m.id === machine && m.rented ? { ...m, rented: { ...m.rented, ...rented } } : m)) }));
    const starts = () => runpod.calls.filter((x) => x.includes("start")).length;
    const before = starts();
    await set({ idleMinutes: 0 });
    await refusedWith(c, "start_pod", { machine }, /set to never stop when idle/);
    await set({ idleMinutes: 2, watchdogMinutes: 0 });
    await refusedWith(c, "start_pod", { machine }, /run without a watchdog/);
    expect(starts()).toBe(before);
    await c.close();
  });
});

describe("a pod a token deployed", () => {
  it("is its run: counted whole against its cap, stopped once the cap is reached; terminated by stop_pod", async () => {
    const { token, id } = await made("spend", { spendCapUsd: 1 });
    const c = await connect(token);
    const d = await ok(c, "deploy_pod", DEPLOY);
    expect(d).toMatchObject({ gpu: "A40", idleMinutes: 2, idleDo: "terminate" });
    expect(d.usdPerHour).toBeCloseTo(0.456, 2);
    const machine = d.machine as string;
    expect((await readSettings(t.db)).machines.find((m) => m.id === machine)!.rented).toMatchObject({ mcpToken: id, idleMinutes: 2, idleDo: "terminate" });
    // its run opened as the token's at the first read of it running
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    const run = await t.db.selectFrom("rent_sessions").selectAll().where("machine_id", "=", machine).executeTakeFirstOrThrow();
    expect(run.mcp_token_id).toBe(id);
    const pods = await ok(c, "pods");
    expect(pods.pods[0]).toMatchObject({ id: machine, startedByToken: id, idleDo: "terminate" });
    // two hours of it: $0.91, under the $1 cap; another hour's room is not there for a second pod
    await t.db.updateTable("rent_sessions").set({ started_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }).where("id", "=", run.id).execute();
    expect(await t.services.mcp.tokens.spentThisMonth(id)).toBeCloseTo(0.91, 1);
    await refusedWith(c, "deploy_pod", DEPLOY, /This token's cap is \$1\.00 .* it has spent \$0\.9/);
    expect(creates()).toBe(1);
    // and a third hour passes the cap: the pod is stopped as at the app's caps (terminated: no volume)
    await t.db.updateTable("rent_sessions").set({ started_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }).where("id", "=", run.id).execute();
    await t.services.rented.poll();
    await until(async () => (await t.services.rented.poll(), !runpod.pods.some((p) => p.status === "RUNNING")));
    await c.close();
  });

  it("is stopped or terminated by stop_pod, which says so; Start then counts its first hour again", async () => {
    const { token } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    const machine = (await ok(c, "deploy_pod", { ...DEPLOY, idleDo: "stop" })).machine as string;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    const stopped = await ok(c, "stop_pod", { machine, how: "stop" });
    expect(stopped.said).toMatch(/disk goes on billing/);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "EXITED"));
    // the app's cap now has no room for its hour: Start refused, nothing asked of RunPod
    await updateSettings(t.db, () => ({ rentCaps: { day: 0.01, month: 0 } }));
    const startsBefore = runpod.calls.filter((x) => x.includes("start")).length;
    await refusedWith(c, "start_pod", { machine }, /no room for this pod's first hour/);
    expect(runpod.calls.filter((x) => x.includes("start")).length).toBe(startsBefore);
    const gone = await ok(c, "stop_pod", { machine, how: "terminate" });
    expect(gone.said).toMatch(/not undone/);
    expect((await readSettings(t.db)).machines.some((m) => m.id === machine)).toBe(false);
    await c.close();
  });

  it("is stopped when its token's cap cannot be read, or once the token is gone", async () => {
    const { token, id } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    await ok(c, "deploy_pod", DEPLOY);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.spyOn(t.services.mcp.tokens, "spentThisMonth").mockRejectedValue(new Error("database is locked"));
    await until(async () => (await t.services.rented.poll(), !runpod.pods.some((p) => p.status === "RUNNING")));
    read.mockRestore();
    // the same once the token is gone (revoked a month ago, let go with its activity)
    const second = await made("spend", { spendCapUsd: 5 });
    const c2 = await connect(second.token);
    await ok(c2, "deploy_pod", DEPLOY);
    await until(async () => (await t.services.rented.poll(), runpod.pods.some((p) => p.status === "RUNNING")));
    await t.services.rented.poll();
    await t.db.deleteFrom("mcp_tokens").where("id", "=", second.id).execute();
    await until(async () => (await t.services.rented.poll(), !runpod.pods.some((p) => p.status === "RUNNING")));
    expect(id).toBeTruthy();
    await c.close();
    await c2.close();
  });

  it("a pod running a render this token did not send is not stopped from here", async () => {
    const { token } = await made("spend", { spendCapUsd: 5 });
    const c = await connect(token);
    const machine = (await ok(c, "deploy_pod", DEPLOY)).machine as string;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING"));
    vi.spyOn(t.services.queue, "statusRecent").mockResolvedValue({ machines: [{ id: machine, running: { id: "j-user", label: "zz-test the user's render" } }] } as never);
    await t.db.insertInto("jobs").values({ id: "j-user", owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "x", inputs: "{}", status: "running", priority: 0, warm: 0, attempts: 0, clip_fit: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never).execute();
    await refusedWith(c, "stop_pod", { machine, how: "terminate" }, /rendering “zz-test the user's render”, which this token did not send/);
    await c.close();
  });
});

describe("the machines", () => {
  it("lists them without a token or a folder; changes, asks again and removes one of the user's own", async () => {
    const c = await connect((await made("all")).token);
    const listed = await ok(c, "list_machines");
    expect(listed.machines).toHaveLength(1);
    expect(listed.machines[0]).toMatchObject({ id: "m1", kind: "ComfyUI", online: true });
    expect(JSON.stringify(listed)).not.toMatch(/token|vram|"dir"/i);
    const other = await makeFake();
    try {
      // added by the user, in Afflatus
      await updateSettings(t.db, (x) => ({ machines: [...x.machines, { id: "m2", name: "zz-test second", url: other.url, takes: "image" }] }));
      const changed = await ok(c, "edit_machine", { machine: "zz-test second", takes: "video", families: { sdxl: false } });
      expect(changed).toMatchObject({ takes: "video", families: { sdxl: false } });
      expect(await ok(c, "reconnect", { machine: "m2" })).toMatchObject({ online: true });
      await ok(c, "remove_machine", { machine: "m2" });
      expect((await readSettings(t.db)).machines.map((m) => m.id)).toEqual(["m1"]);
    } finally {
      await other.close();
    }
    await refusedWith(c, "edit_machine", { machine: "m1", idleMinutes: 5 }, /not a rented pod/);
    await refusedWith(c, "remove_machine", { machine: "m1" }, /at least one ComfyUI is needed/);
    await c.close();
  });

  it("is never added, nor its address changed, through MCP (owner: only in Afflatus)", async () => {
    const c = await connect((await made("all")).token);
    const tools = (await c.listTools()).tools;
    expect(tools.map((x) => x.name)).not.toContain("add_machine");
    expect(Object.keys((tools.find((x) => x.name === "edit_machine")!.inputSchema.properties ?? {}) as object)).not.toContain("url");
    await refusedWith(c, "add_machine", { url: "http://192.168.1.50:8188" }, /There is no tool called “add_machine”/);
    // an address sent anyway is no argument of edit_machine's: the machine keeps its own
    const before = (await readSettings(t.db)).machines[0]!.url;
    await ok(c, "edit_machine", { machine: "m1", url: "http://192.168.1.50:8188" });
    expect((await readSettings(t.db)).machines[0]!.url).toBe(before);
    await refusedWith(c, "change_setting", { key: "machines", value: [] }, /machines is changed through .*in Afflatus itself/);
    await refusedWith(c, "change_setting", { key: "comfyUrl", value: "http://192.168.1.50:8188" }, /in Afflatus itself/);
    await c.close();
  });

  it("a pod's idle rule and watchdog need Spend, longer or shorter", async () => {
    const all = await connect((await made("all", { spendCapUsd: 5 })).token);
    const machine = (await ok(all, "deploy_pod", { ...DEPLOY, idleMinutes: 5 })).machine as string;
    const manage = await connect((await made("look", { scopes: ["look", "manage"] })).token);
    await refusedWith(manage, "edit_machine", { machine, idleMinutes: 30 }, /cannot spend on rented GPUs, and a pod's idle time/);
    await refusedWith(manage, "edit_machine", { machine, idleMinutes: 3 }, /cannot spend on rented GPUs/);
    await refusedWith(manage, "edit_machine", { machine, idleDo: "stop" }, /cannot spend on rented GPUs/);
    expect((await readSettings(t.db)).machines.find((m) => m.id === machine)!.rented!.idleMinutes).toBe(5);
    expect((await ok(all, "edit_machine", { machine, idleMinutes: 3 })).pod.idleMinutes).toBe(3);
    await refusedWith(all, "edit_machine", { machine, watchdogMinutes: 0 }, /watchdogMinutes/);
    await all.close();
    await manage.close();
  });

  it("what a machine takes, its families, and removing one of the user's own need Spend while a pod is up", async () => {
    const spend = await connect((await made("spend", { spendCapUsd: 5 })).token);
    await ok(spend, "deploy_pod", DEPLOY);
    const manage = await connect((await made("look", { scopes: ["look", "make", "manage"] })).token);
    await refusedWith(manage, "edit_machine", { machine: "m1", takes: "image" }, /cannot spend on rented GPUs, and changing what .* takes while .* is up/);
    await refusedWith(manage, "edit_machine", { machine: "m1", families: { sdxl: false } }, /cannot spend on rented GPUs/);
    const other = await makeFake();
    try {
      await updateSettings(t.db, (x) => ({ machines: [...x.machines, { id: "m2", name: "zz-test second", url: other.url }] }));
      await refusedWith(manage, "remove_machine", { machine: "m2" }, /cannot spend on rented GPUs, and removing .* while .* is up/);
      expect((await readSettings(t.db)).machines.some((m) => m.id === "m2")).toBe(true);
    } finally {
      await other.close();
    }
    // a name is no steering
    expect((await ok(manage, "edit_machine", { machine: "m1", name: "zz-test home" })).name).toBe("zz-test home");
    expect((await readSettings(t.db)).machines.find((m) => m.id === "m1")!.takes).toBe("all");
    await spend.close();
    await manage.close();
  });
});

describe("what it costs", () => {
  it("costs and caps read under Look; the app's caps changed under Manage only", async () => {
    const { token } = await made("look");
    const c = await connect(token);
    await updateSettings(t.db, () => ({ rentCaps: { day: 4, month: 40 } }));
    const caps = await ok(c, "caps");
    expect(caps.app).toMatchObject({ day: 4, month: 40 });
    expect(caps.thisToken).toMatch(/Spend is not ticked/);
    const costs = await ok(c, "costs");
    expect(costs).toHaveProperty("month");
    expect(costs.caps).toEqual({ day: 4, month: 40 });
    await refusedWith(c, "change_setting", { key: "rentCaps.day", value: 10 }, /needs Manage/);
    // Manage alone lowers a cap, or sets one where there was none; raising or taking one off needs Spend too
    const manage = await connect((await made("look", { scopes: ["look", "manage"] })).token);
    expect(await ok(manage, "change_setting", { key: "rentCaps.day", value: 2 })).toMatchObject({ was: 4, now: 2 });
    await refusedWith(manage, "change_setting", { key: "rentCaps.day", value: 3 }, /cannot spend on rented GPUs, and raising the app's daily cap/);
    await refusedWith(manage, "change_setting", { key: "rentCaps.month", value: 0 }, /taking off the app's monthly cap/);
    await refusedWith(manage, "change_setting", { key: "rentCaps", value: { day: 2, month: 400 } }, /raising the app's monthly cap/);
    expect((await readSettings(t.db)).rentCaps).toEqual({ day: 2, month: 40 });
    await updateSettings(t.db, () => ({ rentCaps: { day: 0, month: 40 } }));
    expect(await ok(manage, "change_setting", { key: "rentCaps.day", value: 5 })).toMatchObject({ was: 0, now: 5 });
    const both = await connect((await made("all")).token);
    expect(await ok(both, "change_setting", { key: "rentCaps.month", value: 0 })).toMatchObject({ was: 40, now: 0 });
    await manage.close();
    await both.close();
    const gpus = await ok(c, "pods", { gpus: "SECURE" });
    expect(gpus.gpus.find((g: { name: string }) => g.name === "A40")).toMatchObject({ usdPerHour: 0.44 });
    expect(JSON.stringify(gpus.gpus)).not.toMatch(/memory/);
    await c.close();
  });
});
