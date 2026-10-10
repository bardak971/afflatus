import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyClient, ComfyError, ComfyUnreachable } from "../src";
import { startFakeComfy, type FakeComfy } from "../src/testing";

let fake: FakeComfy;
let client: ComfyClient;

beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: { KSampler: { input: { required: {} }, output: ["LATENT"] } },
    models: { checkpoints: ["a.safetensors", "sub\\b.safetensors"], loras: [] },
  });
  client = new ComfyClient(`${fake.url}/`);
});
afterEach(() => fake.close());

describe("ComfyClient, read-only calls", () => {
  it("trims the address and gives each client its own id", () => {
    expect(client.baseUrl).toBe(fake.url);
    expect(new ComfyClient(fake.url).clientId).not.toBe(client.clientId);
  });

  it("reads the status", async () => {
    expect(await client.status()).toEqual({ version: "0.0.0-fake", device: "fake gpu", vramTotal: 12 * 2 ** 30, vramFree: 8 * 2 ** 30 });
  });

  it("reads the node catalog and the model folders", async () => {
    expect(Object.keys(await client.catalog())).toEqual(["KSampler"]);
    expect(await client.folders()).toEqual(["checkpoints", "loras"]);
    expect(await client.models("checkpoints")).toEqual(["a.safetensors", "sub\\b.safetensors"]);
  });

  it("only sends GETs for them", async () => {
    await client.status();
    await client.catalog();
    await client.folders();
    await client.models("loras");
    await client.history("x");
    await client.queuePosition("x");
    expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("says when ComfyUI is not there", async () => {
    const gone = new ComfyClient("http://127.0.0.1:9");
    await expect(gone.status()).rejects.toBeInstanceOf(ComfyUnreachable);
  });

  it("turns an error answer into a short message", async () => {
    await expect(client.models("nope")).rejects.toThrow(/unknown folder/);
    await expect(client.models("nope")).rejects.toBeInstanceOf(ComfyError);
  });
});

describe("ComfyClient, jobs", () => {
  const graph = { "1": { class_type: "KSampler", inputs: {} } };

  it("submits a graph with its client id and finds it in the queue", async () => {
    const id = await client.submit(graph);
    expect(fake.prompts.get(id)).toEqual(graph);
    expect(await client.queuePosition(id)).toBe("pending");
    fake.pending = [];
    fake.running = [id];
    expect(await client.queuePosition(id)).toBe("running");
    fake.running = [];
    expect(await client.queuePosition(id)).toBe("absent");
  });

  it("queues a graph under the prompt id it was given", async () => {
    const id = await client.submit(graph, { promptId: "chosen-1" });
    expect(id).toBe("chosen-1");
    expect(fake.prompts.get("chosen-1")).toEqual(graph);
    expect(await client.queuePosition("chosen-1")).toBe("pending");
  });

  it("asks the node pack to clean the output folder, and says null without it", async () => {
    expect(await client.cleanOutput(24)).toBe(0);
    expect(fake.cleaned).toEqual([{ folder: "output", older_than_hours: 24 }]);
    expect(await new ComfyClient("http://127.0.0.1:9").cleanOutput()).toBeNull();
  });

  it("reports why ComfyUI refused a graph", async () => {
    fake.rejectWith = {
      error: { message: "Prompt outputs failed validation", details: "" },
      node_errors: { "3": { class_type: "KSampler", errors: [{ message: "Value not in list", details: "sampler_name: 'x'" }] } },
    };
    await expect(client.submit(graph)).rejects.toThrow("ComfyUI rejected the job: Prompt outputs failed validation; KSampler: Value not in list sampler_name: 'x'");
  });

  it("reads a finished prompt's history and downloads its file", async () => {
    const id = await client.submit(graph);
    expect(await client.history(id)).toBeUndefined();
    fake.history[id] = { status: { completed: true }, outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "temp" }] } } };
    fake.files["out.png"] = new Uint8Array([1, 2, 3]);
    const entry = await client.history(id);
    expect(entry?.status?.completed).toBe(true);
    expect([...(await client.view(entry!.outputs!["9"]!.images![0]!))]).toEqual([1, 2, 3]);
  });

  it("removes a waiting prompt and interrupts a running one", async () => {
    const id = await client.submit(graph);
    await client.interrupt(id);
    expect(fake.pending).toEqual([]);
    expect(fake.calls).toContain("POST /interrupt");
  });

  it("uploads to the temp folder under a name loaders accept", async () => {
    const name = await client.upload(new Uint8Array([1, 2, 3]), "png");
    expect(name).toMatch(/^afflatus_[0-9a-f-]+\.png \[temp\]$/);
    expect(fake.uploads).toHaveLength(1);
  });
});

describe("ComfyClient, an error from the address it was given", () => {
  const failing = (body: string) => new ComfyClient("http://127.0.0.1:1", async () => new Response(body, { status: 500 }));

  it("passes on ComfyUI's own error whole", async () => {
    await expect(failing(JSON.stringify({ error: { message: "Prompt outputs failed validation", details: "" } })).status()).rejects.toThrow(/Prompt outputs failed validation/);
  });

  it("passes on only a short first line, without markup, of another service's page", async () => {
    const page = `<html><head><title>Router admin</title></head><body>${"internal ".repeat(40)}</body></html>\nadmin=zz-test-secret`;
    const err = await failing(page).status().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ComfyError);
    const said = (err as Error).message.replace(/^ComfyUI \/system_stats failed \(500\): /, "");
    expect(said.length).toBeLessThanOrEqual(80);
    expect(said).not.toMatch(/[<>]|zz-test-secret/);
  });
});

describe("ComfyClient, answers that hide a failure", () => {
  /** A fetch that answers /prompt with `answer` and notes every other call. */
  const answering = (answer: unknown) => {
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return new Response(path === "/prompt" ? JSON.stringify(answer) : "{}", { status: 200 });
    }) as typeof fetch;
    return { calls, client: new ComfyClient("http://comfy.test", fetcher) };
  };
  const chain = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 1 } },
    "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    "20": { class_type: "PreviewAny", inputs: { source: "text" } },
  };
  const invalid = (node: string) => ({ prompt_id: "p1", number: 1, node_errors: { [node]: { class_type: chain[node as keyof typeof chain].class_type, errors: [{ message: "Value not in list", details: "sampler_name: 'x'" }] } } });

  it("takes back a prompt whose result node, or a node it comes from, failed validation, and says why", async () => {
    const { calls, client } = answering(invalid("3"));
    await expect(client.submit(chain, { outputs: ["9"] })).rejects.toThrow("ComfyUI rejected the job: KSampler: Value not in list sampler_name: 'x'");
    expect(calls).toContain("POST /interrupt");
  });

  it("lets a prompt run when what failed validation is not on the result's way", async () => {
    const { calls, client } = answering(invalid("20"));
    expect(await client.submit(chain, { outputs: ["9"] })).toBe("p1");
    expect(calls).not.toContain("POST /interrupt");
  });

  it("says ComfyUI stopped answering when a body times out half way, not a bare TimeoutError", async () => {
    const fetcher = (async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new DOMException("The operation was aborted due to timeout", "TimeoutError")) }), { status: 200 })) as typeof fetch;
    await expect(new ComfyClient("http://comfy.test", fetcher).history("p1")).rejects.toBeInstanceOf(ComfyUnreachable);
  });
});
