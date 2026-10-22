import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import type { RenderRow } from "../src/renderDigests";
import { Comfy } from "../src/comfy";
import { loadedOn, roomFor } from "../src/jobFiles";
import type { QueueCore } from "../src/queueModel";
import { CHECKPOINT, FAST, get, job, makeApp, NOWHERE, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * What the queue no longer works out again when nothing it reads changed (the performance review of 2026-10-22): the
 * graphs of the waiting line, the family's renders, a machine's node list that could not be read, the plan a pod's idle
 * check asks, a machine away asked at every pass, the paces read over the whole record.
 */

/** Statements run while `work` runs, whose SQL holds `like`. */
async function statements(like: string, work: () => Promise<unknown>): Promise<number> {
  let n = 0;
  const methods = ["all", "get", "run"] as const;
  const spies = methods.map((m) => {
    const orig = StatementSync.prototype[m] as (...a: unknown[]) => unknown;
    return vi.spyOn(StatementSync.prototype, m).mockImplementation(function (this: StatementSync, ...a: unknown[]) {
      if ((this as unknown as { sourceSQL: string }).sourceSQL.includes(like)) n++;
      return orig.apply(this, a);
    } as never);
  });
  try {
    await work();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return n;
}

const render = (over: Partial<RenderRow> = {}): RenderRow => ({
  id: newId(), owner_id: OWNER, recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: CHECKPOINT, time_key: "steps=28",
  kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: 0, waited_ms: 0,
  total_ms: 20_000, load_ms: 1_000, sample_ms: 16_000, refine_ms: 0, finish_ms: 3_000, step_ms: 500, expected_ms: null,
  vram_peak: null, heat_peak: null, asset_id: null, work: 832 * 1216, machine_id: null, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: now(), ...over,
});

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

type Inner = {
  core: QueueCore;
  forecasts: { familyReads: { rows(f: string, m: string): Promise<unknown> }; statRows(m: string): Promise<unknown>; recorded(): void; heldIf<T>(h: boolean, w: () => Promise<T>): Promise<T>; expectedAll: (...a: unknown[]) => Promise<unknown> };
  planner: { ableOf: (...a: unknown[]) => Promise<unknown> };
  statusNow: () => Promise<unknown>;
  pump: () => Promise<void>;
};
const inner = () => t.services.queue as unknown as Inner;

describe("the graphs of the waiting line", () => {
  const row = () => ({ id: `zz-test-${newId()}`, recipe_id: "sdxl.text-to-picture", inputs: JSON.stringify(job().input), finished_from: null, clip_id: null, clip_fit: 0, clip_mirror: null });

  it("are not built again at the machine's next scan: what it lacks is read again from that scan (M-9)", async () => {
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    const build = vi.spyOn(recipe, "build");
    const comfy = await t.services.comfy();
    const on = { id: "home", comfy, scan: await comfy.scan() };
    const r = row();
    const first = await loadedOn(inner().core, r, on);
    const built = build.mock.calls.length;
    expect(built).toBeGreaterThan(0);
    expect(first?.absent).toEqual([]);
    // the next scan a minute on: its folder no longer has the checkpoint
    fake.models.checkpoints = [];
    const again = await loadedOn(inner().core, r, { ...on, scan: { ...on.scan, at: "a minute on" } });
    expect(build.mock.calls.length).toBe(built);
    expect(again?.files).toEqual(first?.files);
    expect(again?.absent.map((f) => f.file)).toEqual([CHECKPOINT]);
  });

  it("have room for the whole line on every machine (M-8)", () => {
    expect(roomFor(10)).toBe(4096);
    // 10 machines and 450 waiting jobs: 4,500 entries, past the 4,096 that thrashed
    expect(roomFor(4500)).toBe(9000);
    expect(roomFor(1e6)).toBe(65_536);
    roomFor(0);
  });

  it("of the forecasts are not built again when a render is put on the record (N-1)", async () => {
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    const build = vi.spyOn(recipe, "build");
    await inner().forecasts.expectedAll(recipe, job().input, false, null);
    const built = build.mock.calls.length;
    expect(built).toBeGreaterThan(0);
    await t.db.insertInto("render_stats").values(render()).execute();
    inner().forecasts.recorded();
    await inner().forecasts.expectedAll(recipe, job().input, false, null);
    expect(build.mock.calls.length).toBe(built);
  });
});

describe("the forecasts' reads of the record", () => {
  it("read a family's renders once while the record stays as it is (H-1)", async () => {
    const reads = inner().forecasts.familyReads;
    expect(await statements('"family" = ?', async () => {
      for (let i = 0; i < 5; i++) await reads.rows("sdxl", "other.safetensors");
    })).toBe(1);
  });

  it("are read as kept while a pass plans the next job after a render ends, and afresh after (L-29)", async () => {
    const f = inner().forecasts;
    const before = await f.statRows(CHECKPOINT);
    await t.db.insertInto("render_stats").values(render()).execute();
    f.recorded();
    expect(await f.heldIf(true, () => f.statRows(CHECKPOINT))).toBe(before);
    expect(await f.statRows(CHECKPOINT)).not.toBe(before);
  });

  it("the paces are worked out once for the Renders summary and /metrics, not at each read (M-11)", async () => {
    expect(await statements("row_number()", async () => {
      await get(t.app, "/api/renders/summary?period=all");
      await get(t.app, "/metrics");
      await get(t.app, "/api/renders/summary?period=all");
      await get(t.app, "/metrics");
    })).toBe(1);
  });
});

describe("a machine's node list that could not be read", () => {
  it("is not asked again at once, and is after a fresh scan (H-3, M-10)", async () => {
    const comfy = new Comfy(NOWHERE, t.services.registry);
    const read = vi.spyOn(comfy.client, "catalog");
    await expect(comfy.catalog()).rejects.toThrow();
    await expect(comfy.catalog()).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    // found answering again (queue.ts back): read at once
    comfy.forgetScan();
    await expect(comfy.catalog()).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
    comfy.close();
  });
});

describe("the queue's own reads", () => {
  it("a waiting page right after the Queue screen's read is a slice of that status (M-10)", async () => {
    await post(t.app, "/api/queue/pause", {});
    for (let i = 0; i < 3; i++) await post(t.app, "/api/jobs", job());
    const status = vi.spyOn(inner(), "statusNow");
    await get(t.app, "/api/queue");
    const page = (await get(t.app, "/api/queue/waiting?offset=0&limit=2")).json();
    expect(page.count).toBe(3);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("whether a machine has work is read from the last plan while the line stays as it is (L-8)", async () => {
    const second = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
    try {
      const home = (await t.services.machines())[0]!.machine.id;
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: home, url: fake.url }, { id: "m2", url: second.url, takes: "video" }] } });
      // a picture while this machine is paused, and the other takes videos only: it waits, and the other has none of it
      await post(t.app, "/api/queue/pause", { machine: home });
      await post(t.app, "/api/jobs", job());
      await new Promise((r) => setTimeout(r, 300));
      const able = vi.spyOn(inner().planner, "ableOf");
      for (let i = 0; i < 3; i++) expect(await t.services.queue.wants("m2")).toBe(false);
      // planned once at most (the last pass's plan may stand): each pod's check every 20 s was a whole pass
      expect(able.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      await second.close().catch(() => {});
    }
  });
});

describe("a machine away", () => {
  it("is asked at one pass in four once it stays away, not at every pass (L-22)", async () => {
    const asked: string[] = [];
    const down = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(503).end();
    });
    await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
    const app = await makeApp({ comfyUrl: `http://127.0.0.1:${(down.address() as AddressInfo).port}` });
    // the job is not given up meanwhile
    const expiry = FAST.offlineExpiryMs;
    FAST.offlineExpiryMs = 600_000;
    try {
      const q = app.services.queue as unknown as Inner;
      const pump = vi.spyOn(q, "pump");
      await app.services.queue.start();
      await post(app.app, "/api/jobs", job());
      await until(() => pump.mock.calls.length >= 40, 20_000);
      const asks = asked.filter((u) => u === "/system_stats").length;
      // asked at each pass before: one ask per pass
      expect(asks).toBeLessThan(pump.mock.calls.length / 2);
      expect(asks).toBeGreaterThan(3);
    } finally {
      FAST.offlineExpiryMs = expiry;
      await app.close();
      await new Promise((resolve) => down.close(resolve));
    }
  });
});
