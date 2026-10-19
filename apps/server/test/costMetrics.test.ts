import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { get, makeApp, makeFake, type TestApp } from "./helpers";

/** /metrics's money side (costMetrics.ts): the rented GPUs' cost as Queue › Costs works it out, for a dashboard. */

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
let comfy: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  comfy = await makeFake();
  t = await makeApp({ comfyUrl: comfy.url });
});
afterEach(async () => {
  await t.close();
  await comfy.close();
});

/** The value of one series, by its name and labels as written. */
const value = (body: string, series: string) => {
  const line = body.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe("/metrics, the rented GPUs' money", () => {
  it("says nothing of it with no RunPod key, no rented machine and no pod session on record", async () => {
    const body = (await get(t.app, "/metrics")).body;
    expect(body).not.toMatch(/afflatus_rented_|afflatus_runpod_/);
    // the render figures are there as before
    expect(body).toMatch(/afflatus_queue_jobs/);
  });

  it("spend by part and by GPU as counters, the pods' ends by why, the pods running, the caps", async () => {
    const now = Date.now();
    // an hour on an A40 that ended in a crash, half an hour on a 4090 still running
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: iso(now - 180 * MIN), ended_at: iso(now - 120 * MIN), seen_at: iso(now - 120 * MIN), gpu: "NVIDIA A40", up_at: iso(now - 176 * MIN), idle_minutes: 10, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null, end_why: "crash" }).execute();
    await t.db.insertInto("rent_sessions").values({ id: "s2", machine_id: "rp-b", pod: "b", rate: 0.9, started_at: iso(now - 30 * MIN), ended_at: null, seen_at: null, gpu: "NVIDIA GeForce RTX 4090", up_at: iso(now - 27 * MIN), idle_minutes: 10, busy_at: null, pulled_at: null, packs_from: null, packs_to: null, boot_packs: null, start_failed: null }).execute();
    const body = (await get(t.app, "/metrics")).body;

    expect(body).toMatch(/# TYPE afflatus_rented_spend_usd_total counter/);
    const parts = ["render", "boot", "fetch", "outside", "idle", "failed"].map((part) => value(body, `afflatus_rented_spend_usd_total{part="${part}"}`));
    expect(parts.every((p) => p !== undefined && p >= 0)).toBe(true);
    // the parts add up to what the GPUs cost: an hour at $0.60 and about half an hour at $0.90, by the GPU's name as Costs says it
    const a40 = value(body, 'afflatus_rented_gpu_spend_usd_total{gpu="A40"}')!;
    const rtx = value(body, 'afflatus_rented_gpu_spend_usd_total{gpu="RTX 4090"}')!;
    expect(a40).toBeCloseTo(0.6, 2);
    expect(rtx).toBeGreaterThan(0.44);
    expect(parts.reduce<number>((n, p) => n + (p ?? 0), 0)).toBeCloseTo(a40 + rtx, 1);
    expect(value(body, 'afflatus_rented_pod_ends_total{reason="crash"}')).toBe(1);
    expect(value(body, "afflatus_rented_pods_running")).toBe(1);
    expect(value(body, 'afflatus_rented_cap_usd{period="day"}')).toBe(0);
    expect(value(body, "afflatus_rented_spend_today_usd")).toBeGreaterThan(0);
    // never a pod's id as a label: it is new at each deploy
    expect(body).not.toMatch(/afflatus_rented_[a-z_]+\{[^}]*pod=/);
  });
});
