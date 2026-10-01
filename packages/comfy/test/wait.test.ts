import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyCancelled, ComfyClient, ComfyFailed, ComfyLost, waitForOutputs } from "../src";
import { startFakeComfy, type FakeComfy } from "../src/testing";

let fake: FakeComfy;
let client: ComfyClient;
const graph = { "1": { class_type: "KSampler", inputs: {} } };
const fast = { timeoutMs: 5000, pollMs: 2, offlineMs: 60 };
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

beforeEach(async () => {
  fake = await startFakeComfy();
  client = new ComfyClient(fake.url);
});
afterEach(() => fake.close().catch(() => {}));

describe("waitForOutputs", () => {
  it("returns the outputs once ComfyUI says the prompt completed", async () => {
    const id = await client.submit(graph);
    later(30, () => {
      fake.history[id] = { status: { completed: true }, outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "temp" }] } } };
    });
    expect(await waitForOutputs(client, id, fast)).toEqual({ "9": { images: [{ filename: "a.png", subfolder: "", type: "temp" }] } });
  });

  it("reports ComfyUI's own error message", async () => {
    const id = await client.submit(graph);
    fake.history[id] = { status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA out of memory\n" }]] } };
    await expect(waitForOutputs(client, id, fast)).rejects.toThrow(new ComfyFailed("CUDA out of memory"));
  });

  it("knows an interrupted prompt from a failed one", async () => {
    const id = await client.submit(graph);
    fake.history[id] = { status: { status_str: "error", messages: [["execution_interrupted", {}]] } };
    await expect(waitForOutputs(client, id, fast)).rejects.toBeInstanceOf(ComfyCancelled);
  });

  it("stops when asked to", async () => {
    const id = await client.submit(graph);
    const abort = new AbortController();
    later(20, () => abort.abort());
    await expect(waitForOutputs(client, id, { ...fast, signal: abort.signal })).rejects.toBeInstanceOf(ComfyCancelled);
  });

  it("says the job is lost when ComfyUI no longer knows the prompt", async () => {
    const id = await client.submit(graph);
    fake.pending = []; // ComfyUI restarted: not queued, not running, no history
    await expect(waitForOutputs(client, id, fast)).rejects.toBeInstanceOf(ComfyLost);
  });

  it("keeps waiting while the prompt sits in ComfyUI's queue", async () => {
    const id = await client.submit(graph);
    later(450, () => {
      fake.history[id] = { status: { completed: true }, outputs: {} };
    });
    // a 150 ms budget would have run out three times over, but time spent pending does not count
    expect(await waitForOutputs(client, id, { ...fast, timeoutMs: 150, pollMs: 1, queueCheckEvery: 1 })).toEqual({});
  });

  it("says the job is lost when ComfyUI stays unreachable", async () => {
    const id = await client.submit(graph);
    await fake.close();
    await expect(waitForOutputs(client, id, fast)).rejects.toBeInstanceOf(ComfyLost);
  });
});
