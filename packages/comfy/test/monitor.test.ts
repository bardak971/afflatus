import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyClient, Monitor, systemLoadFrom, systemLoadFromStatus } from "../src";
import { startFakeComfy, type FakeComfy } from "../src/testing";

let fake: FakeComfy;
let monitor: Monitor;

/** Websocket messages arrive on a later tick: wait until what they should cause is true. */
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the monitor");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  fake = await startFakeComfy();
  monitor = new Monitor(new ComfyClient(fake.url));
  await monitor.ready();
});
afterEach(async () => {
  monitor.close();
  await fake.close();
});

const tracking = { promptId: "p1", totalSteps: 30, phases: { "1": "loading", "5": "sampling", "8": "refining", "9": "decoding" } as const };

describe("Monitor", () => {
  it("connects with the client's own id", () => {
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]).toMatch(/^afflatus-[0-9a-f]{16}$/);
  });

  it("answers 'waiting' for a prompt nothing was heard about", () => {
    monitor.track(tracking);
    expect(monitor.progress("p1")).toEqual({ progress: 0, eta: 0, phase: "waiting", step: 0, steps: 30 });
    expect(monitor.progress("unknown").steps).toBe(0);
  });

  it("follows a prompt through loading, two samplers and decoding", async () => {
    monitor.track(tracking);
    fake.send("execution_start", { prompt_id: "p1" });
    fake.send("executing", { prompt_id: "p1", node: "5" });
    await until(() => monitor.progress("p1").phase !== "waiting");
    // the sampler is running but has not reported a step: the model is still loading
    expect(monitor.progress("p1").phase).toBe("loading");

    fake.send("progress", { prompt_id: "p1", node: "5", value: 10, max: 20 });
    await until(() => monitor.progress("p1").step === 10);
    expect(monitor.progress("p1")).toMatchObject({ phase: "sampling", step: 10, steps: 30 });

    fake.send("progress", { prompt_id: "p1", node: "5", value: 20, max: 20 });
    fake.send("executing", { prompt_id: "p1", node: "8" });
    fake.send("progress", { prompt_id: "p1", node: "8", value: 5, max: 10 });
    await until(() => monitor.progress("p1").step === 25);
    expect(monitor.progress("p1")).toMatchObject({ phase: "refining", step: 25 });
    expect(monitor.progress("p1").progress).toBeCloseTo(25 / 30);

    fake.send("progress", { prompt_id: "p1", node: "8", value: 10, max: 10 });
    fake.send("executing", { prompt_id: "p1", node: "9" });
    await until(() => monitor.progress("p1").phase === "decoding");
    // never 1 before the result is in hand
    expect(monitor.progress("p1").progress).toBe(0.99);
  });

  it("ignores messages about prompts it does not track", async () => {
    monitor.track(tracking);
    fake.send("progress", { prompt_id: "someone-else", node: "5", value: 3, max: 20 });
    fake.send("progress", { prompt_id: "p1", node: "5", value: 1, max: 20 });
    await until(() => monitor.progress("p1").step === 1);
    expect(monitor.progress("someone-else").steps).toBe(0);
  });

  it("keeps the latest live preview of the running prompt", async () => {
    const changed: string[] = [];
    monitor.onChange = (id) => changed.push(id);
    monitor.track(tracking);
    fake.send("execution_start", { prompt_id: "p1" });
    await until(() => changed.length > 0);
    // [u32 event = 1][u32 type: 2 = PNG][bytes]
    fake.sendBinary(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2, 7, 8, 9]));
    await until(() => monitor.preview("p1").seq === 1);
    expect(monitor.preview("p1").mime).toBe("image/png");
    expect([...monitor.preview("p1").bytes!]).toEqual([7, 8, 9]);

    // KJNodes' animated preview: JSON, no prompt id
    fake.send("kj_preview_override", { image: Buffer.from([1, 2]).toString("base64"), mime: "video/mp4" });
    await until(() => monitor.preview("p1").seq === 2);
    expect(monitor.preview("p1").mime).toBe("video/mp4");
    expect([...monitor.preview("p1").bytes!]).toEqual([1, 2]);

    // what a sampling pass starts from (step 0: noise, or a flat gray on a second pass) does not take its place
    fake.send("kj_preview_override", { image: Buffer.from([5]).toString("base64"), step: 0, total: 4 });
    fake.send("kj_preview_override", { image: Buffer.from([3, 4]).toString("base64"), mime: "video/mp4", step: 3, total: 4 });
    await until(() => monitor.preview("p1").seq === 3);
    expect([...monitor.preview("p1").bytes!]).toEqual([3, 4]);
  });

  it("forgets a prompt when told to", async () => {
    monitor.track(tracking);
    monitor.untrack("p1");
    expect(monitor.progress("p1").steps).toBe(0);
  });

  it("measures a render: the time of each phase, of a step, and the GPU's peaks", async () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const gpu = (percent: number, temperature: number) => fake.send("dasiwa.system_monitor", { gpus: [{ name: "GPU", memory_used: percent, memory_total: 100, memory_percent: percent, temperature }] });
    monitor.track(tracking);
    fake.send("execution_start", { prompt_id: "p1" });
    fake.send("executing", { prompt_id: "p1", node: "5" });
    await until(() => monitor.progress("p1").phase === "loading");
    gpu(60, 61);
    await pause(200);
    // three steps, 40 ms apart: the first one is reported once it is done
    for (const value of [1, 2, 3]) {
      fake.send("progress", { prompt_id: "p1", node: "5", value, max: 3 });
      await until(() => monitor.progress("p1").step === value);
      if (value < 3) await pause(40);
    }
    gpu(93, 74);
    gpu(88, 70);
    fake.send("executing", { prompt_id: "p1", node: "9" });
    await until(() => monitor.progress("p1").phase === "decoding");
    await pause(50);

    const m = monitor.measured("p1")!;
    expect(m.stepMs).toBeGreaterThan(30);
    expect(m.stepMs).toBeLessThan(90);
    // the step that was under way while "loading" is counted as a step, not as loading
    expect(m.phases.loading).toBeGreaterThan(100);
    expect(m.phases.loading).toBeLessThan(200);
    expect(m.phases.sampling).toBeGreaterThan(2 * 30);
    expect(m.phases.decoding).toBeGreaterThanOrEqual(45);
    expect(m.vramPeak).toBe(93);
    expect(m.heatPeak).toBe(74);
    monitor.untrack("p1");
    expect(monitor.measured("p1")).toBeNull();
  });

  it("counts what follows the first pass in the time left, when past renders say how long that takes", async () => {
    monitor.track({ ...tracking, passes: [{ node: "5", steps: 20 }, { node: "8", steps: 10 }], expect: { laterMs: 60_000, finishMs: 30_000 } });
    fake.send("execution_start", { prompt_id: "p1" });
    fake.send("progress", { prompt_id: "p1", node: "5", value: 1, max: 20 });
    await until(() => monitor.progress("p1").step === 1);
    await new Promise((r) => setTimeout(r, 30));
    fake.send("progress", { prompt_id: "p1", node: "5", value: 11, max: 20 });
    await until(() => monitor.progress("p1").step === 11);
    // nine steps of a few milliseconds, then the minute of the second pass and the half minute of finishing
    expect(monitor.progress("p1").eta).toBeGreaterThan(90);
    expect(monitor.progress("p1").eta).toBeLessThan(92);
  });

  it("does not count the tiles of a decode or an upscale model as steps, but shows their phase", async () => {
    monitor.track({ ...tracking, passes: [{ node: "5", steps: 20 }, { node: "8", steps: 10 }] });
    fake.send("execution_start", { prompt_id: "p1" });
    fake.send("progress", { prompt_id: "p1", node: "5", value: 20, max: 20 });
    fake.send("progress", { prompt_id: "p1", node: "8", value: 10, max: 10 });
    await until(() => monitor.progress("p1").step === 30);
    // the tiled decode reports its tiles: the bar stays at the sampler total, the phase follows the node
    fake.send("executing", { prompt_id: "p1", node: "9" });
    fake.send("progress", { prompt_id: "p1", node: "9", value: 1, max: 6 });
    fake.send("progress", { prompt_id: "p1", node: "9", value: 6, max: 6 });
    await until(() => monitor.progress("p1").phase === "decoding");
    await new Promise((r) => setTimeout(r, 20));
    expect(monitor.progress("p1")).toMatchObject({ step: 30, steps: 30, progress: 0.99, phase: "decoding" });
    // a node the tracking knows nothing about is taken for a sampler, as before
    monitor.track({ promptId: "p2", totalSteps: 10, phases: {} });
    fake.send("progress", { prompt_id: "p2", node: "77", value: 3, max: 10 });
    await until(() => monitor.progress("p2").step === 3);
  });

  it("keeps the bar within the sampler total and the time left sane through the fake's tiled decode", async () => {
    // a render as the fake plays it: a sampler, then a tiled decode and an upscale model that report tiles
    const sim = await startFakeComfy({ simulate: { stepMs: 15 } });
    const client = new ComfyClient(sim.url);
    const watch = new Monitor(client);
    await watch.ready();
    try {
      const graph = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x" } },
        "2": { class_type: "KSampler", inputs: { seed: 1, steps: 6, model: ["1", 0] } },
        "3": { class_type: "VAEDecodeTiled", inputs: { samples: ["2", 0], vae: ["1", 2] } },
        "4": { class_type: "ImageUpscaleWithModel", inputs: { image: ["3", 0] } },
        "5": { class_type: "PreviewImage", inputs: { images: ["4", 0] } },
      };
      const phases = { "1": "loading", "2": "sampling", "3": "decoding", "4": "upscaling", "5": "encoding" } as const;
      const promptId = await client.submit(graph);
      watch.track({ promptId, totalSteps: 6, phases, passes: [{ node: "2", steps: 6 }] });
      const seen: Array<ReturnType<Monitor["progress"]>> = [];
      watch.onChange = () => seen.push(watch.progress(promptId));
      await until(() => Boolean(sim.history[promptId]), 5000);
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.length).toBeGreaterThan(6);
      for (const p of seen) {
        expect(p.step).toBeLessThanOrEqual(6);
        expect(p.progress).toBeLessThanOrEqual(0.99);
        expect(Number.isFinite(p.eta) && p.eta >= 0).toBe(true);
      }
      // the sampler done, the tiles leave the count alone and the time left is the finishing allowance, not more
      const after = seen.filter((p) => p.phase === "decoding" || p.phase === "upscaling");
      expect(after.length).toBeGreaterThan(0);
      for (const p of after) {
        expect(p).toMatchObject({ step: 6, progress: 0.99 });
        expect(p.eta).toBeLessThanOrEqual(3);
      }
    } finally {
      watch.close();
      await sim.close();
    }
  });

  it("picks up the machine's load from a monitor extension's broadcast", async () => {
    expect(monitor.system).toBeNull();
    fake.send("dasiwa.system_monitor", {
      cpu_percent: 14, cpu_count: 16,
      ram: { used: 25e9, total: 32e9, percent: 79 }, swap: { used: 1, total: 50, percent: 2 },
      disks: [{ path: "E:\\", percent: 70, read_mb_s: 0, write_mb_s: 1.5, used: 1, total: 2, device: "E:", fstype: "NTFS" }],
      gpus: [{ name: "Some GPU", utilization: 100, memory_used: 9.6e9, memory_total: 12e9, memory_percent: 80, temperature: 82 }],
    });
    await until(() => monitor.system !== null);
    expect(monitor.system).toMatchObject({
      source: "dasiwa", cpu: 14, ram: { percent: 79 }, swap: 2,
      disks: [{ path: "E:\\", percent: 70, readMbS: 0, writeMbS: 1.5 }],
      gpus: [{ name: "Some GPU", load: 100, temperature: 82, vramPercent: 80 }],
    });
  });
});

describe("systemLoadFrom", () => {
  it("leaves out what the extension could not read", () => {
    const load = systemLoadFrom("dasiwa.system_monitor", {
      cpu_percent: null, ram: { used: null, total: null, percent: null },
      gpus: [{ name: "Laptop GPU", utilization: null, memory_used: null, memory_total: 4e9, memory_percent: null, temperature: -1 }],
    })!;
    expect(load.cpu).toBeUndefined();
    expect(load.ram).toBeUndefined();
    expect(load.gpus[0]).toEqual({ name: "Laptop GPU", vramUsed: 0, vramTotal: 4e9, vramPercent: 0 });
  });

  it("reads the Crystools format too", () => {
    const load = systemLoadFrom("crystools.monitor", {
      cpu_utilization: 20, ram_total: 32e9, ram_used: 16e9, ram_used_percent: 50, hdd_used_percent: 60,
      gpus: [{ gpu_utilization: 90, gpu_temperature: 70, vram_total: 12e9, vram_used: 6e9, vram_used_percent: 50 }],
    })!;
    expect(load).toMatchObject({ source: "crystools", cpu: 20, ram: { percent: 50 }, disks: [{ percent: 60 }], gpus: [{ load: 90, temperature: 70, vramPercent: 50 }] });
  });

  it("is null for any other message", () => {
    expect(systemLoadFrom("progress", {})).toBeNull();
  });

  it("falls back to ComfyUI's own memory numbers", () => {
    const load = systemLoadFromStatus({ version: "1", device: "gpu", vramTotal: 12e9, vramFree: 3e9 });
    expect(load).toMatchObject({ source: "comfyui", gpus: [{ name: "gpu", vramUsed: 9e9, vramPercent: 75 }] });
    expect(load.cpu).toBeUndefined();
  });
});

describe("Monitor: what a prompt shows on the way", () => {
  it("keeps each node's pictures as it puts them out, oldest first, one entry per node", async () => {
    monitor.track(tracking);
    fake.send("execution_start", { prompt_id: "p1" });
    fake.send("executed", { prompt_id: "p1", node: "9", display_node: "9", output: { images: [{ filename: "pass1_00001_.png", subfolder: "", type: "temp" }] } });
    await until(() => monitor.stages("p1").length === 1);
    // a node with nothing to show (a text output) adds nothing; a video node's gifs count as its pictures
    fake.send("executed", { prompt_id: "p1", node: "12", output: { text: ["hello"] } });
    fake.send("executed", { prompt_id: "p1", node: "14", output: { gifs: [{ filename: "clip.mp4", subfolder: "video", type: "output" }] } });
    await until(() => monitor.stages("p1").length === 2);
    expect(monitor.stages("p1")).toEqual([
      { node: "9", files: [{ filename: "pass1_00001_.png", subfolder: "", type: "temp" }] },
      { node: "14", files: [{ filename: "clip.mp4", subfolder: "video", type: "output" }] },
    ]);
    // a prompt nothing was heard about has none
    expect(monitor.stages("nowhere")).toEqual([]);
  });
});
