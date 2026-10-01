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
    expect(fake.sockets[0]).toMatch(/^studai-[0-9a-f]{16}$/);
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
  });

  it("forgets a prompt when told to", async () => {
    monitor.track(tracking);
    monitor.untrack("p1");
    expect(monitor.progress("p1").steps).toBe(0);
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
