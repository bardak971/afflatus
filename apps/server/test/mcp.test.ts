import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clientOf, serverFor } from "../src/mcp";
import { isNever, quoted, tool, type Tool } from "../src/mcpTool";
import { McpTokens, type McpToken } from "../src/mcpTokens";
import { TOOLS } from "../src/mcpTools";
import { unwrittenOf } from "../src/unwrittenDrafts";
import { pageOf } from "../src/whatsOpen";
import { makeApp, type TestApp } from "./helpers";

/**
 * Afflatus from outside (mcp.ts, mcpTokens.ts, mcp-api.ts): the tokens (made, kept as their SHA-256 only, ended, revoked),
 * /mcp's own way in (a token and nothing else, never on the API), the scopes and the never-list, the limits, the activity
 * of each call, and the two first tools through the SDK's own client, over HTTP as Claude Code reaches it.
 */

const PASSWORD = "correct horse battery";
const LAN = "192.168.1.20";
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

/** A token made through the page's route (this computer, no password: no question asked). */
async function made(start: "look" | "make" | "spend" | "all" = "make", name = "Claude Desktop"): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name, start } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string; view: { id: string } };
  return { token: body.token, id: body.view.id };
}

/** A JSON-RPC call to /mcp as a client sends it. */
const rpc = (o: { token?: string; body?: unknown; from?: string; headers?: Record<string, string> } = {}) =>
  t.app.inject({
    method: "POST", url: "/mcp", remoteAddress: o.from ?? "127.0.0.1",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
    payload: JSON.stringify(o.body ?? { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.0.0" } } }),
  });

describe("the tokens", () => {
  it("are shown once and kept as their SHA-256 only, with their scopes and limits", async () => {
    const { token, id } = await made("make");
    expect(token).toMatch(/^afl_mcp_[\w-]{43}$/);
    const row = await t.db.selectFrom("mcp_tokens").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.hash).toBe(sha(token));
    expect(row.tail).toBe(token.slice(-4));
    expect(JSON.stringify(row)).not.toContain(token.slice(8, 30));
    expect(row.scopes).toBe("look,make");
    const list = (await t.app.inject({ method: "GET", url: "/api/mcp/tokens" })).json() as { tokens: Array<Record<string, unknown>> };
    expect(JSON.stringify(list)).not.toContain(token.slice(8, 30));
    expect(list.tokens[0]).toMatchObject({ id, name: "Claude Desktop", scopes: ["look", "make"], rendersPerHour: 30, spendCapCents: 500, state: "idle", rendersThisHour: 0, spentThisMonth: 0 });
  });

  it("end on their day, and are refused once revoked", async () => {
    let now = Date.parse("2026-10-27T12:00:00Z");
    const tokens = new McpTokens(t.db, { now: () => now });
    const { token, view } = await tokens.make({ name: "laptop", scopes: ["look"], endsDays: 30 });
    expect(view.expiresAt).toBe("2026-11-26T12:00:00.000Z");
    expect((await tokens.byBearer(`Bearer ${token}`))?.id).toBe(view.id);
    now += 30 * 86_400_000;
    expect(await tokens.byBearer(`Bearer ${token}`)).toBeNull();
    expect((await tokens.list())[0]!.state).toBe("ended");
    // its end moved: good again, until revoked
    await tokens.change(view.id, { endsDays: null });
    expect((await tokens.byBearer(`Bearer ${token}`))?.id).toBe(view.id);
    await tokens.revoke(view.id);
    expect(await tokens.byBearer(`Bearer ${token}`)).toBeNull();
    expect((await tokens.list())[0]!.state).toBe("revoked");
    await expect(tokens.change(view.id, { name: "again" })).rejects.toThrow(/not found/);
  });

  it("keep Look always, and the scopes in their order", async () => {
    const tokens = new McpTokens(t.db);
    const { view } = await tokens.make({ name: "x", scopes: ["manage", "spend"] });
    expect(view.scopes).toEqual(["look", "spend", "manage"]);
    expect((await tokens.change(view.id, { scopes: [] })).scopes).toEqual(["look"]);
  });

  it("need a name", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "  ", start: "look" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("/mcp's way in", () => {
  it("is a 401 without a token, or with a wrong, revoked or ended one", async () => {
    const none = await rpc();
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect((await rpc({ token: "afl_mcp_nothing-of-the-kind-0000000000000000000" })).statusCode).toBe(401);
    const { token, id } = await made("look");
    expect((await rpc({ token })).statusCode).toBe(200);
    await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${id}/revoke`, payload: {} });
    expect((await rpc({ token })).statusCode).toBe(401);
  });

  it("takes the token whether a password is set or not, and only there: never on the API, never as a session", async () => {
    const { token } = await made("look");
    const set = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: PASSWORD } });
    expect(set.statusCode).toBe(200);
    const cookie = [set.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; ");
    // from another machine of the network, with the password set and no session: the token is enough here
    expect((await rpc({ token, from: LAN })).statusCode).toBe(200);
    // and nothing elsewhere: the API, the event stream and /metrics refuse it as they refuse no session
    for (const url of ["/api/queue", "/api/settings", "/api/mcp/tokens", "/metrics"]) {
      const res = await t.app.inject({ method: "GET", url, remoteAddress: LAN, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(401);
    }
    const change = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", remoteAddress: LAN, headers: { authorization: `Bearer ${token}` }, payload: { name: "more", start: "all" } });
    expect(change.statusCode).toBe(401);
    // a session is no token on /mcp
    expect((await rpc({ from: LAN, headers: { cookie } })).statusCode).toBe(401);
  });

  it("keeps the host check: a name the server does not answer to is refused before the token is looked at", async () => {
    const { token } = await made("look");
    const res = await rpc({ token, headers: { host: "evil.example:8720" } });
    expect(res.statusCode).toBe(403);
  });

  it("answers POST only (stateless)", async () => {
    const { token } = await made("look");
    const get = await t.app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });

  it("writes the last use: when, from where, and the client's name from its initialize", async () => {
    const { token, id } = await made("look");
    await rpc({ token, from: LAN });
    const row = await t.db.selectFrom("mcp_tokens").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.last_ip).toBe(LAN);
    expect(row.last_client).toBe("claude-code");
    expect(row.last_used_at).not.toBeNull();
    expect(clientOf([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "cursor", title: "Cursor" } } }])).toBe("Cursor");
    expect(clientOf({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBeUndefined();
  });
});

/** A client of the server `serverFor` makes, in memory: the framework as a tool sees it. */
async function inMemory(token: McpToken, tools: readonly Tool[]): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await serverFor(t.services, token, "127.0.0.1", tools).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("the framework", () => {
  const ran: string[] = [];
  const tools = [
    tool({ name: "peek", scope: "look", title: "Peek", description: "reads", async run(_a, ctx) { ctx.said("Peeked at the queue"); ran.push("peek"); return { ok: true }; } }),
    tool({ name: "render_it", scope: "make", title: "Render", description: "renders", input: { count: z.number().int().min(1).max(8) }, async run(a, ctx) { await ctx.mayRender(a.count); ran.push("render"); return { queued: a.count }; } }),
    tool({ name: "rent_it", scope: "spend", title: "Deploy", description: "deploys", async run(_a, ctx) { await ctx.maySpend(1); ran.push("rent"); return {}; } }),
    tool({ name: "change_setting", scope: "manage", title: "Change a setting", description: "a setting", input: { key: z.string() }, touches: (a) => [a.key], async run(a) { ran.push(a.key); return {}; } }),
    tool({ name: "show_in_folder", scope: "look", title: "Show in folder", description: "opens Explorer", touches: ["show-in-folder"], async run() { ran.push("shown"); return {}; } }),
    tool({ name: "late_never", scope: "look", title: "Late", description: "finds out as it runs", async run(_a, ctx) { ctx.never("updates.install"); ran.push("late"); return {}; } }),
    tool({ name: "fails", scope: "look", title: "Fails", description: "a service refuses", async run() { throw Object.assign(new Error("That draft was not found"), { statusCode: 404 }); } }),
    tool({ name: "bug", scope: "look", title: "Bug", description: "a bug", async run() { throw new Error("secret stack detail"); } }),
  ] as readonly Tool[];
  beforeEach(() => void ran.splice(0));

  it("checks the scope before a tool runs, and says what to tick", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "look only", scopes: ["look"] });
    const c = await inMemory(view, tools);
    expect(text(await c.callTool({ name: "peek" }))).toContain("ok");
    const r = await c.callTool({ name: "render_it", arguments: { count: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs Make.*tick Make/);
    const rent = await c.callTool({ name: "rent_it" });
    expect(text(rent)).toMatch(/cannot spend on rented GPUs: tick Spend/);
    expect(ran).toEqual(["peek"]);
    // every tool is listed, the ones beyond its scopes saying what they need
    const listed = (await c.listTools()).tools;
    expect(listed.map((x) => x.name)).toContain("render_it");
    expect(listed.find((x) => x.name === "render_it")!.description).toMatch(/Needs Make\.$/);
    expect(listed.find((x) => x.name === "peek")!.annotations?.readOnlyHint).toBe(true);
  });

  it("refuses the never-list whatever the scopes: by what a tool touches, or as it runs", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "everything", scopes: ["look", "make", "spend", "manage"] });
    const c = await inMemory(view, tools);
    for (const key of ["password", "access.stayDays", "tokens", "lock", "sign-out", "notify-channels.telegram", "get-ffmpeg", "updates"]) {
      const r = await c.callTool({ name: "change_setting", arguments: { key } });
      expect(r.isError, key).toBe(true);
      expect(text(r)).toMatch(/cannot be reached through MCP, whatever the token's scopes/);
    }
    expect(text(await c.callTool({ name: "show_in_folder" }))).toMatch(/^Show in folder cannot be reached/);
    expect(text(await c.callTool({ name: "late_never" }))).toMatch(/^Afflatus's updates cannot be reached/);
    // a setting of no concern goes
    expect((await c.callTool({ name: "change_setting", arguments: { key: "studio.theme" } })).isError).toBeFalsy();
    expect(ran).toEqual(["studio.theme"]);
    expect(isNever("accessible")).toBe(false);
  });

  it("says a service's refusal as the web does, a bug as the server's plain line", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look"] });
    const c = await inMemory(view, tools);
    expect(text(await c.callTool({ name: "fails" }))).toBe("That draft was not found");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bug = await c.callTool({ name: "bug" });
    expect(text(bug)).toBe("something went wrong on the server");
    expect(text(bug)).not.toContain("secret");
    // a bad argument to a tool beyond the token's scopes: the scope is said first (what to tick, not what to fix)
    const bad = await c.callTool({ name: "render_it", arguments: { count: 99 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/needs Make/);
  });

  it("writes every call to the token's activity: what it touched, refused or not and why; as CSV too", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look", "manage"] });
    const c = await inMemory(view, tools);
    await c.callTool({ name: "peek" });
    await c.callTool({ name: "change_setting", arguments: { key: "password" } });
    await c.callTool({ name: "render_it", arguments: { count: 1 } });
    const lines = await t.services.mcp.tokens.activity(view.id);
    expect(lines.map((l) => [l.tool, l.said, l.refused])).toEqual([
      ["render_it", "Render: needs Make", true],
      ["change_setting", "the password: never through MCP", true],
      ["peek", "Peeked at the queue", false],
    ]);
    expect(lines[1]!.why).toMatch(/whatever the token's scopes/);
    const refused = (await t.app.inject({ method: "GET", url: `/api/mcp/tokens/${view.id}/activity?refused=1` })).json() as { lines: unknown[] };
    expect(refused.lines).toHaveLength(2);
    const csv = await t.app.inject({ method: "GET", url: `/api/mcp/tokens/${view.id}/activity.csv` });
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="afflatus-mcp-x-activity.csv"');
    expect(csv.body).toContain("at_utc,tool,said,refused,failed,why");
    expect(csv.body).toContain("Peeked at the queue");
  });

  it("writes the calls the arguments refuse and the tools that do not exist; says a missing scope before bad arguments", async () => {
    const look = (await t.services.mcp.tokens.make({ name: "look", scopes: ["look"] })).view;
    const lc = await inMemory(look, tools);
    expect(text(await lc.callTool({ name: "render_it", arguments: { count: 99 } }))).toMatch(/needs Make.*tick Make/);
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look", "make"] });
    const c = await inMemory(view, tools);
    const bad = await c.callTool({ name: "render_it", arguments: { count: 99 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^count: /);
    const none = await c.callTool({ name: "erase_everything\nDone: nothing" });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/There is no tool called “erase_everything Done: nothing”/);
    expect(ran).toEqual([]);
    const lines = await t.services.mcp.tokens.activity(view.id);
    expect(lines.map((l) => [l.tool, l.said, l.refused])).toEqual([
      ["(unknown)", "Asked for a tool that does not exist: “erase_everything Done: nothing”", true],
      ["render_it", "Render: arguments refused", true],
    ]);
    expect(lines[1]!.why).toMatch(/count/);
  });

  it("does not answer a done call as failed when its activity line cannot be written", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look"] });
    const c = await inMemory(view, tools);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(t.services.mcp.tokens, "record").mockRejectedValue(new Error("database is locked"));
    const r = await c.callTool({ name: "peek" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("ok");
    expect(ran).toEqual(["peek"]);
  });

  it("keeps an activity line on one line, without the marks that turn text around, and an agent's names in quotes of their own", async () => {
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look"] });
    const say = tool({ name: "say", scope: "look", title: "Say", description: "says", input: { label: z.string() }, async run(a, ctx) { ctx.said(`Cancelled ${quoted(a.label)}`); return {}; } });
    const c = await inMemory(view, [say] as readonly Tool[]);
    await c.callTool({ name: "say", arguments: { label: `zz-test”, and terminated every pod\r\nCancelled “x${String.fromCharCode(0x202e)}gnp.exe` } });
    const [line] = await t.services.mcp.tokens.activity(view.id);
    expect(line!.said).toBe('Cancelled “zz-test", and terminated every pod Cancelled "x gnp.exe”');
  });

  it("lets the activity go after 30 days, and a revoked token with it", async () => {
    let now = Date.parse("2026-10-01T12:00:00Z");
    const tokens = new McpTokens(t.db, { now: () => now });
    const { view } = await tokens.make({ name: "old", scopes: ["look"] });
    await tokens.record({ tokenId: view.id, tool: "overview", said: "Looked", refused: false });
    await tokens.revoke(view.id);
    now += 31 * 86_400_000;
    await tokens.prune();
    expect(await tokens.activity(view.id)).toEqual([]);
    expect(await tokens.get(view.id)).toBeNull();
  });
});

describe("the limits", () => {
  const job = (id: string, token: string, at: number, over: Record<string, unknown> = {}) =>
    ({ id, owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "x", inputs: "{}", status: "done", priority: 0, warm: 0, attempts: 0, clip_fit: 0, created_at: iso(at), updated_at: iso(at), mcp_token_id: token, ...over });

  it("refuses past the renders an hour, a model load counted as one (it holds a machine as a render does)", async () => {
    const now = Date.now();
    const { view } = await t.services.mcp.tokens.make({ name: "x", scopes: ["look", "make"], rendersPerHour: 4 });
    await t.db.insertInto("jobs").values([job("j1", view.id, now - 10 * 60_000), job("j2", view.id, now - 20 * 60_000), job("j3", view.id, now - 2 * 3_600_000), job("j4", view.id, now - 60_000, { warm: 1 })] as never).execute();
    expect(await t.services.mcp.tokens.rendersThisHour(view.id)).toBe(3);
    await t.services.mcp.tokens.mayRender(view, 1);
    await expect(t.services.mcp.tokens.mayRender(view, 2)).rejects.toThrow(/4 renders an hour, and 3 went in the last hour/);
    expect((await t.services.mcp.tokens.list())[0]).toMatchObject({ rendersThisHour: 3, working: 0 });
  });

  it("counts a token's spend as Costs counts a render (its pod's rate), and refuses past its cap or without Spend", async () => {
    const now = Date.now();
    const tokens = t.services.mcp.tokens;
    const { view } = await tokens.make({ name: "x", scopes: ["look", "make", "spend"], spendCapCents: 100 });
    const plain = (await tokens.make({ name: "y", scopes: ["look", "make"] })).view;
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 1.2, started_at: iso(now - 3 * 3_600_000), ended_at: null, seen_at: null, gpu: "NVIDIA A40", up_at: null, idle_minutes: 3 } as never).execute();
    await t.db.insertInto("jobs").values([job("r1", view.id, now - 3_600_000), job("r2", view.id, now - 3_600_000), job("r3", "someone-else", now - 3_600_000)] as never).execute();
    const stat = (id: string, machine: string | null, ms: number) => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "m", model_file: "m.safetensors", time_key: "", kind: "image", width: 1, height: 1, duration_ms: null, steps: 1, status: "done",
      whole: 1, cold: 0, waited_ms: 0, total_ms: ms, load_ms: 0, sample_ms: ms, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null,
      created_at: iso(now - 30 * 60_000), work: null, machine_id: machine, gpu: null,
    });
    // 30 min on the pod at $1.20 an hour, then the 3 idle minutes it left the pod (nothing came after): $0.66; one on this PC
    await t.db.insertInto("render_stats").values([stat("r1", "rp-a", 30 * 60_000), stat("r2", "home", 60 * 60_000), stat("r3", "rp-a", 60 * 60_000)] as never).execute();
    const month = new Date(now);
    // at the very start of a month, the renders above fell in the month before
    if (now - 3_600_000 >= new Date(month.getFullYear(), month.getMonth(), 1).getTime()) {
      expect(await tokens.spentThisMonth(view.id)).toBeCloseTo(0.66, 6);
      await tokens.maySpend(view, 0.3);
      await expect(tokens.maySpend(view, 0.5)).rejects.toThrow(/cap is \$1\.00 a month on rented GPUs, and it has spent \$0\.66/);
    }
    await expect(tokens.maySpend(plain, 0.01)).rejects.toThrow(/tick Spend/);
  });

  it("charges a cheap render the idle time it keeps a dear pod up (until the next job or the idle stop), and its model loads alike", async () => {
    const now = Date.now();
    const month = new Date(now);
    if (now - 3 * 3_600_000 < new Date(month.getFullYear(), month.getMonth(), 1).getTime()) return;
    const tokens = t.services.mcp.tokens;
    const { view } = await tokens.make({ name: "x", scopes: ["look", "make", "spend"] });
    // a $2/h pod with a 10-minute idle stop, the user's run
    await t.db.insertInto("rent_sessions").values({ id: "s2", machine_id: "rp-b", pod: "b", rate: 2, started_at: iso(now - 3 * 3_600_000), ended_at: null, seen_at: null, gpu: "NVIDIA H100", up_at: null, idle_minutes: 10 } as never).execute();
    const stat = (id: string, end: number, ms: number) => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "m", model_file: "m.safetensors", time_key: "", kind: "image", width: 1, height: 1, duration_ms: null, steps: 1, status: "done",
      whole: 1, cold: 0, waited_ms: 0, total_ms: ms, load_ms: 0, sample_ms: ms, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null,
      created_at: iso(end), started_at: iso(end - ms), work: null, machine_id: "rp-b", gpu: null,
    });
    // a 6 s render every 9 minutes, three times: each holds the pod until the next one, the last for its 10 idle minutes
    const ends = [now - 60 * 60_000, now - 51 * 60_000, now - 42 * 60_000];
    await t.db.insertInto("jobs").values(ends.map((end, i) => job(`c${i}`, view.id, end - 6_000, { machine_id: "rp-b", started_at: iso(end - 6_000), finished_at: iso(end) })) as never).execute();
    await t.db.insertInto("render_stats").values(ends.map((end, i) => stat(`c${i}`, end, 6_000)) as never).execute();
    const held = (9 * 60_000 * 2 + 6_000 + 10 * 60_000) / 3_600_000;
    expect(await tokens.spentThisMonth(view.id)).toBeCloseTo(held * 2, 6);
    // a 2-minute model load after them, then nothing: its time and the 10 idle minutes after it
    await t.db.insertInto("jobs").values(job("w1", view.id, now - 20 * 60_000, { warm: 1, machine_id: "rp-b", started_at: iso(now - 20 * 60_000), finished_at: iso(now - 18 * 60_000) }) as never).execute();
    expect(await tokens.spentThisMonth(view.id)).toBeCloseTo((held + 12 / 60) * 2, 6);
  });
});

describe("the tools, through the SDK's client over HTTP", () => {
  async function connect(token: string): Promise<Client> {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (t.app.server.address() as AddressInfo).port;
    const client = new Client({ name: "Claude Code", version: "2.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  it("lists whats_open and overview, and overview says the machines, the queue, the version and this token's use", async () => {
    const { token, id } = await made("make", "Claude Code");
    const client = await connect(token);
    expect(client.getServerVersion()?.name).toBe("afflatus");
    // every tool of the registry, in its order, each once: the list itself is the registry's (mcpTools.ts TOOL_GROUPS), and
    // docs/mcp.md is written from it (mcpDocs.test.ts holds the two together)
    const listed = (await client.listTools()).tools.map((x) => x.name);
    expect(listed).toEqual(TOOLS.map((x) => x.name));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.slice(0, 2)).toEqual(["whats_open", "show_page"]);
    const r = await client.callTool({ name: "overview" });
    expect(r.isError).toBeFalsy();
    const o = JSON.parse(text(r)) as Record<string, any>;
    expect(o.afflatus).toBe("dev");
    expect(o.machines).toHaveLength(1);
    expect(o.machines[0]).toMatchObject({ kind: "ComfyUI", running: null });
    expect(o.queue).toMatchObject({ running: 0, waiting: 0, paused: false });
    expect(o.rentedGpus).toBeNull();
    expect(o.thisToken).toMatchObject({ name: "Claude Code", scopes: ["look", "make"], renders: "0 of 30 this hour", spend: "Spend is not ticked: no rented GPU", ends: "never" });
    await client.close();
    const lines = await t.services.mcp.tokens.activity(id);
    expect(lines[0]).toMatchObject({ tool: "overview", refused: false });
    expect(lines[0]!.said).toMatch(/^Looked at Afflatus: 1 machine, 0 running, 0 waiting$/);
  });

  it("whats_open answers the device seen last, with the names of what it has open", async () => {
    const { token } = await made("look");
    const client = await connect(token);
    expect(JSON.parse(text(await client.callTool({ name: "whats_open" })))).toMatchObject({ open: null });
    const now = iso(Date.now());
    await t.db.insertInto("drafts").values({ id: "d".repeat(32), owner_id: "local", target: "new", recipe_id: "sdxl.text-to-picture", title: "zz-test café", forms: "{}", count: 1, created_at: now, updated_at: now } as never).execute();
    await t.db.insertInto("timelines").values({ id: "e".repeat(32), owner_id: "local", name: "zz-test trailer", created_at: now, updated_at: now } as never).execute();
    await t.db.insertInto("clips").values([{ id: "f".repeat(32), timeline_id: "e".repeat(32), position: 0, joined: "cut", inputs: "{}", created_at: now, updated_at: now }, { id: "a".repeat(32), timeline_id: "e".repeat(32), position: 1, joined: "cut", inputs: "{}", created_at: now, updated_at: now }] as never).execute();
    const where = (ua: string, body: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/where", headers: { "user-agent": ua }, payload: { key: `key-${ua.length}-abcdefgh`, ...body } });
    expect((await where("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1", { path: "/create", draft: "d".repeat(32) })).statusCode).toBe(200);
    const phone = JSON.parse(text(await client.callTool({ name: "whats_open" })));
    expect(phone).toMatchObject({ device: "Safari on iPhone", page: "Studio › Create", draft: { id: "d".repeat(32), name: "zz-test café" }, timeline: null });
    await where("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36", { path: `/timelines/${"e".repeat(32)}`, timeline: "e".repeat(32), clip: "a".repeat(32) });
    const pc = JSON.parse(text(await client.callTool({ name: "whats_open" })));
    expect(pc).toMatchObject({ device: "Chrome on Windows", page: "Timeline editor", timeline: { name: "zz-test trailer" }, clip: { name: "Clip 2" }, draft: null });
    await client.close();
    expect((await t.services.mcp.tokens.activity((await t.services.mcp.tokens.list())[0]!.id))[0]!.said).toBe("Asked what is open: Timeline editor › “zz-test trailer, Clip 2”");
  });

  it("names a blank draft too, held in memory until something is put in it", async () => {
    const { token } = await made("look");
    const client = await connect(token);
    const now = iso(Date.now());
    unwrittenOf(t.db).set("b".repeat(32), { id: "b".repeat(32), owner_id: "local", project_id: null, target: "new", recipe_id: "sdxl.text-to-picture", title: "", name: null, forms: "{}", count: 1, chat: null, look: null, created_at: now, updated_at: now });
    await t.app.inject({ method: "POST", url: "/api/where", payload: { key: "key-blank-draft", path: "/create", draft: "b".repeat(32) } });
    expect(JSON.parse(text(await client.callTool({ name: "whats_open" })))).toMatchObject({ page: "Studio › Create", draft: { id: "b".repeat(32), name: "Untitled draft" } });
    await client.close();
  });

  it("names the pages as the rail does", () => {
    expect(pageOf("/")).toBe("Studio");
    expect(pageOf("/settings/interface")).toBe("Settings › Interface");
    expect(pageOf("/queue?tab=costs")).toBe("Queue");
  });
});

describe("the page's routes", () => {
  it("ask the password to make, change the scopes or limits of, or revoke a token once the sign-in is old; a name alone does not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id } = await made("look");
    const set = await t.app.inject({ method: "POST", url: "/api/session/password", payload: { password: PASSWORD } });
    const cookie = [set.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; ");
    // the sign-in made 11 minutes ago: no longer fresh
    await t.db.updateTable("sessions").set({ created_at: iso(Date.now() - 11 * 60_000) }).execute();
    const ask = (url: string, payload: unknown) => t.app.inject({ method: "POST", url, remoteAddress: LAN, headers: { cookie }, payload: payload as object });
    for (const [url, body] of [["/api/mcp/tokens", { name: "z", start: "all" }], [`/api/mcp/tokens/${id}`, { scopes: ["look", "spend"] }], [`/api/mcp/tokens/${id}`, { spendCapUsd: 50 }], [`/api/mcp/tokens/${id}/revoke`, {}]] as const) {
      const res = await ask(url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ needPassword: true });
    }
    expect((await ask(`/api/mcp/tokens/${id}`, { name: "renamed" })).statusCode).toBe(200);
    const ok = await ask(`/api/mcp/tokens/${id}`, { scopes: ["look", "spend"], spendCapUsd: 12.5, current: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ token: { name: "renamed", scopes: ["look", "spend"], spendCapCents: 1250 } });
  });
});
