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

  it("with the socket telling the end, asks for the history every 5 s only, and at once when the end is told", async () => {
    const id = await client.submit(graph);
    let asked = 0;
    const history = client.history.bind(client);
    client.history = (promptId: string) => (asked++, history(promptId));
    let tell = () => {};
    const ended = new Promise<void>((r) => (tell = r));
    const result = waitForOutputs(client, id, { timeoutMs: 60_000, ended });
    // a second and a half of rendering: asked twice by now at 750 ms, not yet at 5 s
    await new Promise((r) => setTimeout(r, 1_600));
    expect(asked).toBe(0);
    // the end is told a moment before the history is written: read at once, then again soon after
    const at = Date.now();
    tell();
    later(60, () => {
      fake.history[id] = { status: { completed: true }, outputs: {} };
    });
    expect(await result).toEqual({});
    expect(Date.now() - at).toBeLessThan(500);
    expect(asked).toBeGreaterThanOrEqual(2);
  });

  it("says the job is lost when ComfyUI stays unreachable", async () => {
    const id = await client.submit(graph);
    await fake.close();
    await expect(waitForOutputs(client, id, fast)).rejects.toBeInstanceOf(ComfyLost);
  });
});

describe("a failed render", () => {
  it("says the node, its type and the exception's class, and keeps the traceback's end", async () => {
    const id = await client.submit(graph);
    fake.history[id] = { status: { status_str: "error", messages: [["execution_error", {
      prompt_id: id, node_id: "3", node_type: "KSampler", exception_type: "torch.OutOfMemoryError", exception_message: "Allocation on device ",
      traceback: ["Traceback (most recent call last):\n", "  File \"execution.py\", line 496, in execute\n", "torch.OutOfMemoryError: Allocation on device\n"],
    }]] } };
    const err = await waitForOutputs(client, id, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyFailed);
    expect((err as ComfyFailed).message).toBe("KSampler #3: torch.OutOfMemoryError: Allocation on device");
    expect((err as ComfyFailed).failure).toMatchObject({ nodeId: "3", nodeType: "KSampler", exceptionType: "torch.OutOfMemoryError" });
    expect((err as ComfyFailed).failure?.traceback).toMatch(/^Traceback[\s\S]*Allocation on device$/);
  });

  it("is reported by the pretend ComfyUI with every field the real one sends", async () => {
    const pretend = await startFakeComfy({ simulate: { stepMs: 1 } });
    const client = new ComfyClient(pretend.url);
    const id = await client.submit({ "5": { class_type: "VHS_VideoCombine", inputs: {} } });
    const err = await waitForOutputs(client, id, fast).catch((e: unknown) => e);
    expect((err as ComfyFailed).message).toBe("VHS_VideoCombine #5: RuntimeError: the pretend ComfyUI has no video to return");
    expect((err as ComfyFailed).failure?.traceback).toContain("Traceback");
    await pretend.close();
  });
});
