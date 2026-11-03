import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import type { Queue, QueueDeps } from "../src/queue";
import { allowAllMoney, FAST, get, job, makeApp, makeFake, post, queueDeps, until, type TestApp } from "./helpers";

/**
 * Afflatus restarted (a second Queue on the same services, as the restart tests make one) keeps the app's money checks
 * (QueueDeps, card #228): a render longer than RunPod's balance lasts is still not sent to the rented pod. A queue given
 * allowAllMoney on purpose, what a queue made without its deps did before, sends it there.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];
let again: Queue | null = null;

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      const c = Object.assign(await makeFake(), { packVersion: "0.13.0" });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  if (again) {
    again.stop();
    await again.idle();
    again = null;
  }
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

/**
 * A deployed pod running on ten minutes of balance, this PC paused (so that the pod is the only machine that could take
 * work), and Afflatus going down: the app's queue stopped. Then a queue made again on these deps, a render known to take
 * half an hour queued to it.
 */
async function restartedOnLowBalance(deps: QueueDeps): Promise<{ pod: string; jobId: string; q: Queue }> {
  const pod = (await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 })).json().id as string;
  await until(() => runpod.pods[0]!.status === "RUNNING");
  await t.services.rented.poll();
  runpod.balance = 0.0733; // ten minutes at $0.44/h
  t.services.rented.now = (() => { const real = Date.now; return () => real() + 61_000; })();
  await get(t.app, "/api/rented/spending");
  await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
  t.services.queue.stop();
  await t.services.queue.idle();
  const { Queue } = await import("../src/queue");
  const q = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, FAST, deps);
  again = q;
  // a render known to take half an hour (its forecast, as learned renders would give it)
  (q as unknown as { expected: () => Promise<number> }).expected = async () => 30 * 60_000;
  await q.start();
  const jobId = await q.enqueue(job().recipe, job().input);
  return { pod, jobId, q };
}

describe("a restart keeps the money checks", () => {
  it("a render longer than the balance lasts still waits after a restart, on the app's deps; its row says why", async () => {
    const { pod, jobId, q } = await restartedOnLowBalance(queueDeps(t));
    const waiting = async () => (await q.status()).waiting.find((w) => w.id === jobId);
    await until(async () => Boolean((await waiting())?.lacks?.[pod]?.balance));
    expect(q.runningOn(pod)).toBe(false);
    expect(spawned.every((c) => c.prompts.size === 0)).toBe(true);
  });

  it("a queue given allowAllMoney on purpose sends it to the pod: the gap a queue without its deps had", async () => {
    const { pod, q } = await restartedOnLowBalance({ ...queueDeps(t), money: allowAllMoney() });
    await until(() => spawned.some((c) => c.prompts.size > 0));
    expect(q.runningOn(pod)).toBe(true);
  });
});
