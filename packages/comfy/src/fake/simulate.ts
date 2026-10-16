import { isRef, type Graph } from "@afflatus/core";
import type { FakeInit, FakeState } from "../testing";
import { makePng, tint } from "./png";
import type { fakeSockets } from "./sockets";

/** The steps a sampling node reports, as ComfyUI counts them: a KSamplerAdvanced only the slice it samples. */
function stepsOf(graph: Graph, node: Graph[string]): number {
  // a sampler has its steps on itself, or (the custom sampler) on the scheduler it takes its sigmas from
  const sigmas = node.inputs.sigmas as [string, number] | undefined;
  const steps = Number(node.inputs.steps ?? (sigmas ? graph[sigmas[0]]?.inputs.steps : undefined) ?? 20);
  if (node.class_type !== "KSamplerAdvanced") return steps;
  const start = Number(node.inputs.start_at_step ?? 0);
  const end = Math.min(steps, Number(node.inputs.end_at_step ?? 10000));
  return Math.max(0, end - start);
}

/**
 * What ComfyUI would take from its cache: a node whose class, inputs and everything upstream are those of a
 * node the prompt before ran. Each node's signature, by id.
 */
function signatures(graph: Graph): Record<string, string> {
  const out: Record<string, string> = {};
  const of = (id: string): string => {
    if (out[id] !== undefined) return out[id]!;
    const node = graph[id];
    if (!node) return (out[id] = `missing:${id}`);
    const inputs = Object.keys(node.inputs).sort().map((k) => {
      const v = node.inputs[k];
      return [k, isRef(v) ? `<${of(v[0])}>${v[1]}` : v];
    });
    return (out[id] = JSON.stringify([node.class_type, inputs]));
  };
  for (const id of Object.keys(graph)) of(id);
  return out;
}

/**
 * Pretend rendering (init.simulate): one prompt at a time, in the order they came, like ComfyUI. Each reports
 * what ComfyUI reports: the start, the nodes it had cached from the prompt before, each node it runs and its
 * steps (with a preview each), then success and the end of the prompt. A load snapshot goes out every second.
 */
export function fakeSimulate(fake: FakeState, opts: NonNullable<FakeInit["simulate"]>, sockets: ReturnType<typeof fakeSockets>) {
  const { send, sendBinary } = sockets;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  /** The signatures of the nodes the prompt before ran: what ComfyUI keeps in its cache. */
  let cache = new Set<string>();
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stillWanted = (id: string) => !closed && (fake.pending.includes(id) || fake.running.includes(id));
  const ended = (id: string) => send("executing", { node: null, prompt_id: id });
  const run = async (id: string) => {
    const stepMs = opts.stepMs;
    const graph = fake.prompts.get(id)!;
    if (!stillWanted(id)) return;
    // running before it leaves the waiting line: the count ComfyUI broadcasts on each change never dips between the two
    fake.running = [...fake.running, id];
    fake.pending = fake.pending.filter((p) => p !== id);
    const nodes = Object.entries(graph);
    const samples = (node: Graph[string]) => /KSampler$|KSamplerAdvanced|SamplerCustom/.test(node.class_type);
    const first = nodes.find(([, node]) => samples(node));
    const noise = nodes.find(([, node]) => node.class_type === "RandomNoise");
    const seed = Number(first?.[1].inputs.seed ?? first?.[1].inputs.noise_seed ?? noise?.[1].inputs.noise_seed ?? 1);
    const signed = signatures(graph);
    const cached = nodes.filter(([nodeId]) => cache.has(signed[nodeId]!)).map(([nodeId]) => nodeId);
    cache = new Set(Object.values(signed));
    send("execution_start", { prompt_id: id, timestamp: Date.now() });
    send("execution_cached", { nodes: cached, prompt_id: id, timestamp: Date.now() });
    await pause(stepMs * 3); // "loading the model"
    // a tiled decode and an upscale model report their tiles as progress too, as the real ones do
    const tiles = (node: Graph[string]) => /^VAEDecodeTiled$|^ImageUpscaleWithModel$/.test(node.class_type);
    for (const [nodeId, node] of nodes) {
      if (!stillWanted(id)) break;
      if (cached.includes(nodeId)) continue;
      send("executing", { prompt_id: id, node: nodeId });
      if (tiles(node)) {
        for (let tile = 1; tile <= 4 && stillWanted(id); tile++) {
          await pause(stepMs / 2);
          send("progress", { prompt_id: id, node: nodeId, value: tile, max: 4 });
        }
        continue;
      }
      if (!samples(node)) continue;
      const steps = stepsOf(graph, node);
      for (let step = 1; step <= steps && stillWanted(id); step++) {
        await pause(stepMs);
        send("progress", { prompt_id: id, node: nodeId, value: step, max: steps });
        // a small preview that sharpens from grey towards the final colours
        const k = step / steps;
        const mix = (c: [number, number, number]) => c.map((v) => Math.round(96 + (v - 96) * k)) as [number, number, number];
        const head = Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]);
        sendBinary(Buffer.concat([head, makePng(96, 128, mix(tint(seed, 0)), mix(tint(seed, 0.35)))]));
      }
    }
    if (!fake.running.includes(id)) {
      fake.history[id] = { status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}]] } };
      // what ComfyUI keeps of an interrupted prompt is not reused
      cache = new Set();
      send("execution_interrupted", { prompt_id: id, node_id: null, node_type: null, executed: [] });
      return ended(id);
    }
    const sized = [...nodes].reverse().find(([, node]) => typeof node.inputs.width === "number" && typeof node.inputs.height === "number");
    const width = Number(sized?.[1].inputs.width ?? 832);
    const height = Number(sized?.[1].inputs.height ?? 1216);
    fake.running = fake.running.filter((r) => r !== id);
    const videoOut = nodes.find(([, node]) => /VideoCombine|SaveVideo|SaveAnimated/i.test(node.class_type))?.[0];
    if (videoOut) {
      // a pretend clip: the same short video whatever was asked, when the caller supplied one
      const source = opts.video;
      const clip = typeof source === "function" ? source(graph, seed) : source;
      if (!clip) {
        // every field ComfyUI's own execution_error carries, so that what reads it is tested against the real shape
        const error = {
          prompt_id: id, node_id: videoOut, node_type: nodes.find(([n]) => n === videoOut)![1].class_type, executed: [],
          exception_message: "the pretend ComfyUI has no video to return", exception_type: "RuntimeError",
          traceback: ["Traceback (most recent call last):\n", '  File "execution.py", line 496, in execute\n', "RuntimeError: the pretend ComfyUI has no video to return\n"],
          current_inputs: {}, current_outputs: {},
        };
        fake.history[id] = { status: { status_str: "error", completed: false, messages: [["execution_error", error]] } };
        cache = new Set();
        send("execution_error", error);
        return ended(id);
      }
      fake.files[`${id}.mp4`] = clip;
      fake.history[id] = { status: { status_str: "success", completed: true }, outputs: { [videoOut]: { gifs: [{ filename: `${id}.mp4`, subfolder: "", type: "temp" }] } } };
    } else {
      const out = nodes.find(([, node]) => node.class_type === "PreviewImage" || node.class_type === "SaveImage")?.[0] ?? "0";
      const filename = `${id}.png`;
      fake.files[filename] = makePng(width, height, tint(seed, 0), tint(seed, 0.35));
      fake.history[id] = { status: { status_str: "success", completed: true }, outputs: { [out]: { images: [{ filename, subfolder: "", type: "temp" }] } } };
    }
    // the history is written first, then the prompt is said to be over
    send("execution_success", { prompt_id: id, timestamp: Date.now() });
    ended(id);
  };
  const load = setInterval(() => {
    const busy = fake.running.length > 0;
    send("dasiwa.system_monitor", {
      cpu_percent: busy ? 22 : 6, cpu_count: 16,
      ram: { used: 19e9, total: 32e9, percent: 59 }, swap: { used: 1e9, total: 40e9, percent: 2 },
      disks: [{ path: "/", percent: 61, read_mb_s: 0, write_mb_s: busy ? 1.2 : 0 }],
      gpus: [{ name: "Pretend GPU", utilization: busy ? 97 : 2, memory_used: (busy ? 9.4 : 1.3) * 2 ** 30, memory_total: 12 * 2 ** 30, memory_percent: busy ? 78 : 11, temperature: busy ? 74 : 41 }],
    });
  }, 1000);
  return {
    start(id: string) {
      chain = chain.then(() => run(id));
    },
    stop() {
      closed = true;
      clearInterval(load);
    },
  };
}
