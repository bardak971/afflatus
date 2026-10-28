import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { CHECKPOINT, complete, costToday, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A job pinned to a stopped pod (card #149): it waits for that pod with Start on its row, whatever else is up (this PC and
 * another pod that both have its files), is never sent to either, and runs on the pod once started; Start is refused past
 * a spending cap, as on the Rented GPUs page.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let stoppedComfy: FakeComfy;
let upComfy: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  home.models.loras = [];
  stoppedComfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
  upComfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50,
    pods: [
      { name: "zz-test-stopped", rate: 0.57, gpu: "NVIDIA RTX PRO 4000", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 0, comfy: stoppedComfy },
      { name: "zz-test-up", rate: 0.4, gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: upComfy, status: "RUNNING" },
    ],
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, stoppedComfy, upComfy, runpod].map((x) => x.close().catch(() => {})));
});

/** Both pods added as machines and read once from RunPod: the stopped one's id, and the one up's. */
async function added(): Promise<{ stopped: string; up: string }> {
  const ids: string[] = [];
  for (const p of runpod.pods) ids.push((await post(t.app, "/api/runpod/add", { pod: p.id })).json().id as string);
  await t.services.rented.poll();
  return { stopped: ids[0]!, up: ids[1]! };
}

type Row = { id: string; startPod: string | null; pinned: string | null; lacks: Record<string, { why?: string }> | null };
const waitingRow = async (id: string): Promise<Row | undefined> => (await get(t.app, "/api/queue")).json().waiting.find((x: Row) => x.id === id);

describe("a job pinned to a stopped pod", () => {
  it("offers Start for that pod while this PC and another pod could run it, and goes to neither", async () => {
    const { stopped, up } = await added();
    // the pod that is up answers: it could take the job, as this PC could
    await until(async () => (await get(t.app, "/api/queue")).json().machines.some((m: { id: string; online: boolean }) => m.id === up && m.online));
    await t.services.queue.start();
    const queued = await post(t.app, "/api/jobs", { ...job(), machine: stopped });
    expect(queued.statusCode).toBe(200);
    const jobId = queued.json().ids[0] as string;
    await until(async () => Boolean((await waitingRow(jobId))?.startPod));
    const w = (await waitingRow(jobId))!;
    expect(w.startPod).toBe(stopped);
    expect(w.pinned).toBe(stopped);
    expect(w.lacks![stopped]!.why).toBe("the pod is stopped");
    // a few passes later it still waits: neither this PC nor the pod that is up was sent it
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status).toBe("queued");
    expect(home.prompts.size).toBe(0);
    expect(upComfy.prompts.size).toBe(0);

    // its row's Start: the pod comes up and the job runs there
    expect((await post(t.app, `/api/machines/${stopped}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await until(() => stoppedComfy.prompts.size === 1);
    complete(stoppedComfy, [...stoppedComfy.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status === "done");
    expect(home.prompts.size).toBe(0);
    expect(upComfy.prompts.size).toBe(0);
  });

  it("is not offered Start once moved to another machine", async () => {
    const { stopped } = await added();
    await t.services.queue.start();
    const jobId = (await post(t.app, "/api/jobs", { ...job(), machine: stopped })).json().ids[0] as string;
    await until(async () => Boolean((await waitingRow(jobId))?.startPod));
    // Run on › this PC: the user moved it, and it runs there
    const home1 = (await get(t.app, "/api/queue")).json().machines.find((m: { rented: unknown }) => !m.rented).id as string;
    expect((await post(t.app, `/api/jobs/${jobId}/machine`, { machine: home1 })).statusCode).toBe(200);
    await until(() => home.prompts.size === 1);
  });

  it("Start is refused past a spending cap, and the pod stays stopped", async () => {
    const { stopped } = await added();
    await t.services.queue.start();
    const jobId = (await post(t.app, "/api/jobs", { ...job(), machine: stopped })).json().ids[0] as string;
    await until(async () => Boolean((await waitingRow(jobId))?.startPod));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
    const capped = await post(t.app, `/api/machines/${stopped}/start`, {});
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toMatch(/spending cap/);
    expect(runpod.pods[0]!.status).toBe("EXITED");
    // it still waits for that pod, sent nowhere else
    expect((await waitingRow(jobId))?.startPod).toBe(stopped);
    expect(home.prompts.size).toBe(0);
  });
});
