import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * A ComfyUI busy with work queued from outside Afflatus (its own page, another tool): that work shows only in its queue and
 * its status broadcast. Such a machine is not idle: it takes no job until the work is done, and another machine does.
 */

let one: FakeComfy;
let two: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  [one, two] = await Promise.all([makeFake(), makeFake()]);
  t = await makeApp({ comfyUrl: one.url });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: one.url }, { id: "m2", name: "Second GPU", url: two.url }] } });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await Promise.all([one.close().catch(() => {}), two.close().catch(() => {})]);
});

type Outside = { running: number; pending: number } | null;
const outsideOf = async (id: string) => ((await get(t.app, "/api/queue")).json().machines as Array<{ id: string; outside: Outside }>).find((m) => m.id === id)!.outside;
const row = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const sentTo = (fake: FakeComfy) => [...fake.prompts.keys()];
/** A prompt queued in a ComfyUI from elsewhere: its own page, under a client id of its own. */
const queueFromItsPage = async (fake: FakeComfy) => {
  const res = await fetch(`${fake.url}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: {}, client_id: "comfyui-page" }) });
  return ((await res.json()) as { prompt_id: string }).prompt_id;
};

describe("a ComfyUI busy outside Afflatus", () => {
  it("takes no job while that work runs: another machine does; with none free the job waits, and goes once the work is done", async () => {
    const theirs = await queueFromItsPage(one);
    one.pending = [];
    one.running = [theirs];
    const a = await enqueue({ prompt: "a cat" });
    await until(() => sentTo(two).length === 1);
    expect(sentTo(one)).toEqual([theirs]);
    expect(await outsideOf("m1")).toEqual({ running: 1, pending: 0 });
    // Afflatus's own prompt waiting in the other ComfyUI is not work from outside
    await until(async () => (await outsideOf("m2"))?.running === 0);
    expect(await outsideOf("m2")).toEqual({ running: 0, pending: 0 });

    // the other machine busy with Afflatus's job: the next one waits, not sent behind the outside work
    const b = await enqueue({ prompt: "a dog" });
    await new Promise((r) => setTimeout(r, 150));
    expect(sentTo(one)).toEqual([theirs]);
    expect((await row(b)).status).toBe("queued");
    // why it waits: the plan cannot say when the machine is free
    const waiting = (await get(t.app, "/api/queue")).json().waiting as Array<{ id: string; startsInMs: number | null }>;
    expect(waiting.find((w) => w.id === b)?.startsInMs ?? null).toBeNull();

    // the work from its page done: ComfyUI's status says so, and the waiting job goes there
    one.running = [];
    await until(() => sentTo(one).length === 2);
    expect(await outsideOf("m1")).toEqual({ running: 0, pending: 0 });
    for (const fake of [one, two]) for (const p of sentTo(fake)) if (p !== theirs) complete(fake, p);
    await until(async () => (await row(a)).status === "done" && (await row(b)).status === "done");
    expect((await row(b)).machine_id).toBe("m1");
  });

  it("is not unloaded by Unload idle, and counts as busy for /metrics", async () => {
    const theirs = await queueFromItsPage(one);
    // a pass that reads the machines finds it (an open page's poll, or a job to place)
    await t.services.queue.lookOutside();
    await until(async () => (await outsideOf("m1"))?.pending === 1);
    expect(theirs).toBeTruthy();
    expect((await post(t.app, "/api/comfy/free", {})).statusCode).toBe(200);
    expect(one.calls).not.toContain("POST /free");
    expect(two.calls).toContain("POST /free");
    const one1 = await post(t.app, "/api/comfy/free", { machine: "m1" });
    expect(one1.statusCode).toBe(400);
    expect(one1.json().error).toMatch(/outside Afflatus/);
    expect([...(await t.services.queue.counts()).busy]).toEqual(["m1"]);
  });
});
