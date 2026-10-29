import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT, complete, makeApp, makeFake, post, until, type TestApp } from "./helpers";
import { tasksClient, V2 } from "./mcpTasksClient";

/**
 * MCP Tasks (mcpTasks.ts) through the extension's own client (@modelcontextprotocol/ext-tasks) on protocol 2026-07-28, as a
 * client that takes tasks reaches /mcp: a render answered with a task, followed to its result (the call's answer and each
 * job's end, as `job` says it), cancelled (its jobs cancelled as `cancel` cancels them), and followed again after a restart
 * of Afflatus. A client that does not declare the extension, and one on the 2025 handshake, get the answer as before.
 */

const RECIPE = "sdxl.text-to-picture";
const VALUES = { prompt: "zz-test a lamp", checkpoint: CHECKPOINT };

let t: TestApp;
let fake: FakeComfy;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  const open = await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute();
  await Promise.all(open.map((j) => t.services.queue.cancel(j.id).catch(() => false)));
  await t.close();
  await fake.close().catch(() => {});
});

async function token(start: "look" | "make" = "make"): Promise<{ token: string; id: string }> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test tasks", start } });
  return { token: res.json().token as string, id: res.json().view.id as string };
}

async function urlOf(app: TestApp["app"]): Promise<string> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
}

/** A client without the extension, on either handshake. */
async function plainClient(url: string, bearer: string, era: "legacy" | "modern"): Promise<Client> {
  const client = new Client({ name: "zz-test plain", version: "1" }, era === "modern" ? { versionNegotiation: { mode: { pin: V2 } } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

const answer = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;

describe("a client that takes tasks", () => {
  it("gets a task for a render, follows it, and gets the call's answer with each job's end once they are done", async () => {
    const { token: bearer } = await token();
    const { client, session } = await tasksClient(await urlOf(t.app), bearer);
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(["io.modelcontextprotocol/tasks"]);
    const ex = await session.callTool("render", { form: RECIPE, values: VALUES, takes: 1 });
    expect(ex.kind).toBe("task");
    const handle = ex.handle!;
    const snap = await session.task(handle.taskId).snapshot();
    expect(snap).toMatchObject({ status: "working" });
    expect(snap.suggestedPollIntervalMs ?? snap.pollInterval).toBeGreaterThanOrEqual(5000);
    // the call was the same call: its job queued for this token, and its activity line written once
    const kept = await t.db.selectFrom("mcp_tasks").selectAll().where("id", "=", handle.taskId).executeTakeFirstOrThrow();
    const jobs = JSON.parse(kept.follow).jobs as string[];
    expect(jobs).toHaveLength(1);
    await until(() => fake.prompts.size >= 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await t.services.queue.idle();
    const outcome = await session.task(handle.taskId).result();
    expect(outcome.status).toBe("completed");
    const said = answer((outcome as { result: { content: unknown } }).result);
    expect(said).toMatchObject({ jobs, takes: 1, ended: [{ job: jobs[0], status: "done", made: [expect.objectContaining({ kind: "image" })] }] });
    // a task ended stays as it ended
    expect(await session.task(handle.taskId).snapshot()).toMatchObject({ status: "completed" });
    const activity = await t.db.selectFrom("mcp_activity").select(["tool", "said"]).execute();
    expect(activity.filter((a) => a.tool === "render")).toHaveLength(1);
    expect(activity.some((a) => a.tool.startsWith("tasks/"))).toBe(false);
    await session.close();
    await client.close();
  });

  it("cancels a task's jobs as cancel does, and the task ends cancelled; another token cannot see it", async () => {
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: {} });
    const { token: bearer } = await token();
    const url = await urlOf(t.app);
    const { client, session } = await tasksClient(url, bearer);
    const ex = await session.callTool("render", { form: RECIPE, values: VALUES, takes: 2 });
    expect(ex.kind).toBe("task");
    const id = ex.handle!.taskId;
    const other = await tasksClient(url, (await token()).token);
    await expect(other.session.task(id).snapshot()).rejects.toThrow(/no such task/);
    await expect(other.session.cancelTask(id)).rejects.toThrow(/no such task/);
    await session.cancelTask(id);
    const jobs = JSON.parse((await t.db.selectFrom("mcp_tasks").select("follow").where("id", "=", id).executeTakeFirstOrThrow()).follow).jobs as string[];
    const rows = await t.db.selectFrom("jobs").select("status").where("id", "in", jobs).execute();
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(await session.task(id).snapshot()).toMatchObject({ status: "cancelled" });
    const line = await t.db.selectFrom("mcp_activity").select(["tool", "said", "refused"]).where("tool", "=", "tasks/cancel").executeTakeFirstOrThrow();
    expect(line).toMatchObject({ refused: 0, said: expect.stringMatching(/^Cancelled the task of render: cancelled “.+”, “.+”$/) });
    await Promise.all([session.close(), other.session.close()]);
    await Promise.all([client.close(), other.client.close()]);
  });

  it("is followed again after a restart of Afflatus, from the jobs", async () => {
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: {} });
    const { token: bearer } = await token();
    const first = await tasksClient(await urlOf(t.app), bearer);
    const ex = await first.session.callTool("render", { form: RECIPE, values: VALUES, takes: 1 });
    expect(ex.kind).toBe("task");
    const ref = ex.kind === "task" ? ex.serializeReference() : null;
    // the client goes away without cancelling it (its session let go of the task, not closed: closing cancels what it follows)
    await ex.detach();
    await first.client.close();
    // Afflatus started again on the same database: the task is still there, read from its job
    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    try {
      const second = await tasksClient(await urlOf(again.app), bearer);
      const resumed = await second.session.resumeTask(ref!);
      expect(await second.session.task(resumed.handle!.taskId).snapshot()).toMatchObject({ status: "working" });
      // the user cancels the job on the Queue page: the task ends, its result saying so
      const job = (JSON.parse((await t.db.selectFrom("mcp_tasks").select("follow").executeTakeFirstOrThrow()).follow).jobs as string[])[0]!;
      expect((await post(again.app, `/api/jobs/${job}/cancel`, {})).statusCode).toBeLessThan(300);
      expect(await second.session.task(resumed.handle!.taskId).snapshot()).toMatchObject({ status: "completed" });
      const outcome = await second.session.task(resumed.handle!.taskId).result();
      expect(outcome.status).toBe("completed");
      expect(answer((outcome as { result: { content: unknown } }).result).ended).toEqual([expect.objectContaining({ job, status: "cancelled" })]);
      await second.session.close();
      await second.client.close();
    } finally {
      // its services share the database, closed with the first app's
      await again.app.close();
    }
  });

  it("answers at once what leaves nothing to wait for, and a refusal as a refusal", async () => {
    const look = await token("look");
    const { client, session } = await tasksClient(await urlOf(t.app), look.token);
    const ex = await session.callTool("render", { form: RECIPE, values: VALUES });
    expect(ex.kind).toBe("immediate");
    const outcome = await ex.result();
    expect(outcome.status).toBe("completed");
    const r = (outcome as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/tick Make/);
    expect((await t.db.selectFrom("mcp_tasks").select("id").execute())).toHaveLength(0);
    await session.close();
    await client.close();
  });
});

describe("a client without tasks", () => {
  it.each(["legacy", "modern"] as const)("gets the answer as before (%s handshake)", async (era) => {
    const { token: bearer } = await token();
    const c = await plainClient(await urlOf(t.app), bearer, era);
    const r = await c.callTool({ name: "render", arguments: { form: RECIPE, values: VALUES } });
    expect(r.isError).toBeFalsy();
    expect(answer(r)).toMatchObject({ jobs: [expect.any(String)], takes: 1 });
    expect((await t.db.selectFrom("mcp_tasks").select("id").execute())).toHaveLength(0);
    await c.close();
  });
});
