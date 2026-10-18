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

    // the type is the message's word, sent back as the preview's Content-Type: a page's type is not taken
    fake.send("kj_preview_override", { image: Buffer.from([6]).toString("base64"), mime: "text/html", step: 4, total: 4 });
    await until(() => monitor.preview("p1").seq === 4);
    expect(monitor.preview("p1").mime).toBe("image/jpeg");
    fake.send("kj_preview_override", { image: Buffer.from([7]).toString("base64"), mime: "image/webp", step: 4, total: 4 });
    await until(() => monitor.preview("p1").seq === 5);
    expect(monitor.preview("p1").mime).toBe("image/webp");
  });

  it("forgets a prompt when told to", async () => {
    monitor.track(tracking);
    monitor.untrack("p1");
    expect(monitor.progress("p1").steps).toBe(0);
  });

  it("measures a render: the time of each phase, of a step, and the GPU's peaks", async () => {
    // timed by a clock of the test's own: each message is handled before the clock moves on, so the figures are exact
    const clock = { now: 1_000 };
    const timed = new Monitor(new ComfyClient(fake.url), { now: () => clock.now });
    await timed.ready();
    try {
      const gpu = (percent: number, temperature: number) => fake.send("dasiwa.system_monitor", { gpus: [{ name: "GPU", memory_used: percent, memory_total: 100, memory_percent: percent, temperature }] });
      timed.track(tracking);
      fake.send("execution_start", { prompt_id: "p1" });
      fake.send("executing", { prompt_id: "p1", node: "5" });
      await until(() => timed.progress("p1").phase === "loading");
      gpu(60, 61);
      clock.now += 200;
      // three steps, 40 ms apart: the first one is reported once it is done
      for (const value of [1, 2, 3]) {
        fake.send("progress", { prompt_id: "p1", node: "5", value, max: 3 });
        await until(() => timed.progress("p1").step === value);
        if (value < 3) clock.now += 40;
      }
      gpu(93, 74);
      gpu(88, 70);
      // the RAM from ComfyUI's own count only (a pod's container limit); a monitor extension's is the host's, left out
      const GB = 1024 ** 3;
      fake.send("dasiwa.system_monitor", { ram: { used: 400 * GB, total: 500 * GB }, gpus: [] });
      await until(() => timed.system?.ram?.used === 400 * GB);
      timed.peaks(systemLoadFromStatus({ version: "x", device: "GPU", vramTotal: 0, vramFree: 0, ramTotal: 50 * GB, ramFree: 20 * GB }));
      timed.peaks(systemLoadFromStatus({ version: "x", device: "GPU", vramTotal: 0, vramFree: 0, ramTotal: 50 * GB, ramFree: 35 * GB }));
      fake.send("executing", { prompt_id: "p1", node: "9" });
      await until(() => timed.progress("p1").phase === "decoding");
      clock.now += 50;

      const m = timed.measured("p1")!;
      expect(m.stepMs).toBe(40);
      // the step that was under way while "loading" (the first 40 of its 200 ms) is counted as a step, not as loading
      expect(m.phases).toEqual({ waiting: 0, loading: 160, sampling: 120, decoding: 50 });
      expect(m.vramPeak).toBe(93);
      expect(m.heatPeak).toBe(74);
      expect([m.ramPeak, m.ramTotal]).toEqual([30 * GB, 50 * GB]);
      timed.untrack("p1");
      expect(timed.measured("p1")).toBeNull();
    } finally {
      timed.close();
    }
  });

  it("times each node class it ran, from one node's start to the next one's, and says when the prompt is over", async () => {
    const clock = { now: 1_000 };
    const client = new ComfyClient(fake.url);
    const timed = new Monitor(client, { now: () => clock.now });
    await timed.ready();
    try {
      const node = (class_type: string) => ({ class_type, inputs: {} });
      const id = await client.submit({ "1": node("UNETLoader"), "4": node("Sam3VideoTrack"), "5": node("KSampler"), "9": node("VAEDecode"), "10": node("VAEDecode") });
      timed.track({ ...tracking, promptId: id });
      let over = false;
      void timed.ended(id).then(() => (over = true));
      const executing = () => (timed as unknown as { tracked: Map<string, { executing: string | null }> }).tracked.get(id)?.executing;
      fake.send("execution_start", { prompt_id: id });
      // the model's load, then a preprocessing node that all counts as "loading" in the phases, then the sampler and two decodes
      for (const [at, ms] of [["1", 300], ["4", 900], ["5", 2000], ["9", 100], ["10", 50]] as const) {
        fake.send("executing", { prompt_id: id, node: at });
        await until(() => executing() === at);
        clock.now += ms;
      }
      expect(over).toBe(false);
      fake.send("execution_success", { prompt_id: id });
      fake.send("executing", { prompt_id: id, node: null });
      await until(() => over);
      clock.now += 5_000;
      expect(timed.measured(id)!.nodes).toEqual({ UNETLoader: 300, Sam3VideoTrack: 900, KSampler: 2000, VAEDecode: 150 });
      // a wait that starts after the end was heard ends at once
      await timed.ended(id);
      // a prompt this client did not send (followed again after a restart): its classes are not known, and none are said
      timed.track({ ...tracking, promptId: "from-before" });
      expect(timed.measured("from-before")!.nodes).toBeUndefined();
    } finally {
      timed.close();
    }
  });

  it("counts what follows the first pass in the time left, when past renders say how long that takes", async () => {
    const clock = { now: 1_000 };
    const timed = new Monitor(new ComfyClient(fake.url), { now: () => clock.now });
    await timed.ready();
    try {
      timed.track({ ...tracking, passes: [{ node: "5", steps: 20 }, { node: "8", steps: 10 }], expect: { laterMs: 60_000, finishMs: 30_000 } });
      fake.send("execution_start", { prompt_id: "p1" });
      fake.send("progress", { prompt_id: "p1", node: "5", value: 1, max: 20 });
      await until(() => timed.progress("p1").step === 1);
      clock.now += 300;
      fake.send("progress", { prompt_id: "p1", node: "5", value: 11, max: 20 });
      await until(() => timed.progress("p1").step === 11);
      // ten steps in 300 ms: nine more of 30 ms, then the minute of the second pass and the half minute of finishing
      expect(timed.progress("p1").eta).toBeCloseTo(0.27 + 60 + 30, 6);
    } finally {
      timed.close();
    }
  });

  it("counts a node that samples piece by piece round after round, and the passes ComfyUI had cached", async () => {
    // H3's latent re-sample: one node, the same steps again for each tile and stretch of frames
    monitor.track({ promptId: "p1", totalSteps: 8 + 3 * 4, phases: { "5": "sampling", "8": "refining" }, passes: [{ node: "5", steps: 8 }, { node: "8", steps: 3 * 4 }] });
    fake.send("execution_start", { prompt_id: "p1" });
    // the first pass came from the cache: the same seed and settings as the prompt before
    fake.send("execution_cached", { nodes: ["1", "5"], prompt_id: "p1" });
    fake.send("executing", { prompt_id: "p1", node: "8" });
    for (let round = 0; round < 3; round++) for (const value of [1, 2, 3, 4]) fake.send("progress", { prompt_id: "p1", node: "8", value, max: 4 });
    await until(() => monitor.progress("p1").step === 20);
    expect(monitor.progress("p1")).toMatchObject({ step: 20, steps: 20, phase: "refining", progress: 0.99 });
  });

  it("goes on from the step count saved on a prompt picked up again, when one node samples chunk after chunk", async () => {
    // a finish's refine run per chunk: 9 chunks of 10 steps on one node, joined after the third
    const clock = { now: 1_000 };
    const timed = new Monitor(new ComfyClient(fake.url), { now: () => clock.now });
    await timed.ready();
    try {
      timed.track({ promptId: "p1", totalSteps: 90, phases: { "8": "refining" }, passes: [{ node: "8", steps: 90 }], expect: { finishMs: 2000 }, stepsDone: 30 });
      // shown before a step is heard
      expect(timed.progress("p1")).toMatchObject({ step: 30, steps: 90 });
      let heard = 0;
      timed.onChange = () => heard++;
      fake.send("executing", { prompt_id: "p1", node: "8" });
      fake.send("progress", { prompt_id: "p1", node: "8", value: 5, max: 10 });
      await until(() => heard === 2);
      expect(timed.progress("p1")).toMatchObject({ step: 30, phase: "refining" });
      clock.now += 100;
      fake.send("progress", { prompt_id: "p1", node: "8", value: 6, max: 10 });
      await until(() => timed.progress("p1").step === 31);
      // the pace is timed from the pick-up, over the one step seen since: 59 left at 0.1 s, then the finishing
      expect(timed.progress("p1").eta).toBeCloseTo(59 * 0.1 + 2, 6);
      // the same node starting its next chunk does not set the count back
      for (const value of [7, 8, 9, 10, 1, 2]) fake.send("progress", { prompt_id: "p1", node: "8", value, max: 10 });
      await until(() => timed.progress("p1").step === 37);
      expect(timed.progress("p1").step).toBe(37);
    } finally {
      timed.close();
    }
  });

  it("keeps a saved count within the total, and takes what the running pass says when that is more", async () => {
    monitor.track({ promptId: "p1", totalSteps: 30, phases: tracking.phases, stepsDone: 500 });
    expect(monitor.progress("p1")).toMatchObject({ step: 30, steps: 30, progress: 0.99 });
    // saved a little before the restart: the second pass running says more
    monitor.track({ promptId: "p2", totalSteps: 30, phases: tracking.phases, passes: [{ node: "5", steps: 20 }, { node: "8", steps: 10 }], stepsDone: 18 });
    fake.send("executing", { prompt_id: "p2", node: "8" });
    fake.send("progress", { prompt_id: "p2", node: "8", value: 3, max: 10 });
    await until(() => monitor.progress("p2").step === 23);
  });

  it("without a saved count (a job from before it was saved), infers the steps done from the pass that runs", async () => {
    monitor.track({ ...tracking, passes: [{ node: "5", steps: 20 }, { node: "8", steps: 10 }] });
    fake.send("executing", { prompt_id: "p1", node: "8" });
    fake.send("progress", { prompt_id: "p1", node: "8", value: 3, max: 10 });
    await until(() => monitor.progress("p1").step === 23);
    expect(monitor.progress("p1")).toMatchObject({ step: 23, steps: 30, phase: "refining" });
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
    // nor a loader showing what it was given, from the input folder (LoadVideo, a Motion transfer's driving video)
    fake.send("executed", { prompt_id: "p1", node: "1", output: { images: [{ filename: "drive.mp4", subfolder: "", type: "input" }], animated: [true] } });
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

describe("Monitor, ComfyUI's queue", () => {
  it("keeps how many prompts ComfyUI has, whoever queued them, from its status: on connecting and on each change", async () => {
    // greeted with the queue as it stands
    await until(() => monitor.queueRemaining === 0);
    const heard: number[] = [];
    monitor.onQueue = (n) => heard.push(n);
    // a prompt queued from ComfyUI's own page: its progress goes to that page, its count to every client
    fake.running = ["from-its-own-page"];
    fake.pending = ["another"];
    await until(() => monitor.queueRemaining === 2);
    fake.running = [];
    await until(() => monitor.queueRemaining === 1);
    expect(heard).toEqual([1, 2, 1]);
    // told the same count again (one ended, one queued): the listener hears it, the queue's makeup may have changed
    fake.send("status", { status: { exec_info: { queue_remaining: 1 } } });
    await until(() => heard.length === 4);
    expect(heard.at(-1)).toBe(1);
  });

  it("does not know the count once its socket is closed", async () => {
    await until(() => monitor.queueRemaining === 0);
    monitor.close();
    expect(monitor.queueRemaining).toBeNull();
  });
});
