import { afterEach, describe, expect, it } from "vitest";
import { ComfyClient, Monitor } from "../src";
import { startFakeComfy, type FakeComfy } from "../src/testing";

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A websocket under a client id of its own, keeping every JSON message it hears. */
async function listen(url: string, clientId: string) {
  const heard: Array<{ type: string; data: Record<string, unknown> }> = [];
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
  ws.onmessage = (ev) => typeof ev.data === "string" && heard.push(JSON.parse(ev.data));
  await new Promise((resolve) => (ws.onopen = resolve));
  return { heard, close: () => ws.close() };
}

let fake: FakeComfy | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("the fake ComfyUI, as the real one talks", () => {
  // two passes over one schedule, as Wan's are: each KSamplerAdvanced reports the slice it samples, not the whole schedule
  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x" } },
    "2": { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], noise_seed: 7, steps: 10, start_at_step: 0, end_at_step: 6 } },
    "3": { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], latent_image: ["2", 0], noise_seed: 0, steps: 10, start_at_step: 6, end_at_step: 10000 } },
    "4": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
  };

  it("sends a prompt's messages to the client that queued it alone, in ComfyUI's order, with the end of the prompt", async () => {
    fake = await startFakeComfy({ simulate: { stepMs: 2 } });
    const client = new ComfyClient(fake.url);
    const mine = await listen(fake.url, client.clientId);
    const other = await listen(fake.url, "someone-else");
    try {
      const promptId = await client.submit(graph);
      await until(() => mine.heard.some((m) => m.type === "executing" && m.data.node === null));
      const about = mine.heard.filter((m) => m.data.prompt_id === promptId);
      expect(about[0]).toMatchObject({ type: "execution_start" });
      expect(about[1]).toMatchObject({ type: "execution_cached", data: { nodes: [] } });
      expect(about.at(-2)).toMatchObject({ type: "execution_success" });
      expect(about.at(-1)).toMatchObject({ type: "executing", data: { node: null } });
      // the history is there when the prompt is said to be over
      expect(fake.history[promptId]?.status?.completed).toBe(true);
      const most = (node: string) => Math.max(...about.filter((m) => m.type === "progress" && m.data.node === node).map((m) => Number(m.data.max)));
      expect([most("2"), most("3")]).toEqual([6, 4]);
      // a client that did not queue it hears nothing of it
      expect(other.heard.filter((m) => "prompt_id" in m.data)).toEqual([]);
    } finally {
      mine.close();
      other.close();
    }
  });

  it("says which nodes it had from the prompt before, and does not run them again", async () => {
    fake = await startFakeComfy({ simulate: { stepMs: 2 } });
    const client = new ComfyClient(fake.url);
    const mine = await listen(fake.url, client.clientId);
    try {
      await client.submit(graph);
      const again = await client.submit({ ...graph, "3": { ...graph["3"], inputs: { ...graph["3"].inputs, steps: 12 } } });
      await until(() => mine.heard.some((m) => m.type === "executing" && m.data.node === null && m.data.prompt_id === again));
      const about = mine.heard.filter((m) => m.data.prompt_id === again);
      // the loader and the first pass are the same; the second pass changed, and what follows it
      expect(about.find((m) => m.type === "execution_cached")?.data.nodes).toEqual(["1", "2"]);
      expect(about.filter((m) => m.type === "progress").map((m) => m.data.node)).not.toContain("2");
    } finally {
      mine.close();
    }
  });

  it("a monitor follows its own prompt and opens its socket again when it drops", async () => {
    fake = await startFakeComfy();
    const client = new ComfyClient(fake.url);
    const monitor = new Monitor(client);
    await monitor.ready();
    try {
      monitor.track({ promptId: "p1", totalSteps: 10, phases: { "5": "sampling" } });
      // a prompt queued by another process before this one started: its socket is borrowed under that id
      monitor.track({ promptId: "p2", totalSteps: 10, phases: { "5": "sampling" }, clientId: "queued-before" });
      await until(() => fake!.sockets.includes("queued-before"));
      fake.dropSockets();
      // both come back under their own ids
      await until(() => fake!.sockets.filter((s) => s === client.clientId).length === 2 && fake!.sockets.filter((s) => s === "queued-before").length === 2);
      fake.send("progress", { prompt_id: "p1", node: "5", value: 3, max: 10 }, client.clientId);
      fake.send("progress", { prompt_id: "p2", node: "5", value: 4, max: 10 }, "queued-before");
      await until(() => monitor.progress("p1").step === 3 && monitor.progress("p2").step === 4);
    } finally {
      monitor.close();
    }
  });

  it("an untracked monitor whose socket drops stays closed until it is needed", async () => {
    fake = await startFakeComfy();
    const monitor = new Monitor(new ComfyClient(fake.url));
    await monitor.ready();
    try {
      fake.dropSockets();
      await new Promise((r) => setTimeout(r, 800));
      expect(fake.sockets).toHaveLength(1);
    } finally {
      monitor.close();
    }
  });
});
