import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { WebSocketServer } from "ws";
import type { Graph, NodeCatalog } from "@studai/core";
import type { HistoryEntry } from "./client";

/**
 * A stand-in for ComfyUI's HTTP API, for tests: enough of it to exercise the client, the capabilities
 * scan and the queue without a GPU. It records what it was asked so tests can assert on it.
 */
export interface FakeComfy {
  url: string;
  /** Every request as "METHOD /path". */
  calls: string[];
  /** Graphs received on POST /prompt, by prompt id. */
  prompts: Map<string, Graph>;
  catalog: NodeCatalog;
  models: Record<string, string[]>;
  history: Record<string, HistoryEntry>;
  running: string[];
  pending: string[];
  /** Files served by GET /view, by filename. */
  files: Record<string, Uint8Array>;
  /** When set, POST /prompt answers 400 with this body. */
  rejectWith: unknown | null;
  uploads: string[];
  /** What model files say about themselves, by "<folder>/<file>". A file not listed has no header. */
  metadata: Record<string, Record<string, unknown>>;
  /** Client ids of the websockets that connected, in order. */
  sockets: string[];
  /** What the pretend ComfyUI-Manager downloaded: where it put it and how large it was. */
  installed: Array<{ folder: string; file: string; bytes: number }>;
  /** Broadcast a websocket message to every connected client, as ComfyUI does. */
  send(type: string, data: unknown): void;
  /** Broadcast a binary frame (a live preview). */
  sendBinary(bytes: Uint8Array): void;
  close(): Promise<void>;
}

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** A real PNG, a soft vertical blend between two colours: something to look at without a GPU. */
export function makePng(width: number, height: number, top: [number, number, number], bottom: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const rgb = [0, 1, 2].map((i) => Math.round(top[i]! + (bottom[i]! - top[i]!) * t));
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      // a faint diagonal band so that it does not read as a flat fill
      const band = (x + y) % 96 < 48 ? 6 : 0;
      raw[row + 1 + x * 3] = Math.min(255, rgb[0]! + band);
      raw[row + 2 + x * 3] = Math.min(255, rgb[1]! + band);
      raw[row + 3 + x * 3] = Math.min(255, rgb[2]! + band);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** A colour from a seed, so that different seeds give visibly different pictures. */
function tint(seed: number, shift: number): [number, number, number] {
  const h = ((seed * 0.618033988749895 + shift) % 1) * 6;
  const c = 90, m = 40;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}

export interface FakeInit extends Partial<Pick<FakeComfy, "catalog" | "models">> {
  /**
   * Pretend to have ComfyUI-Manager: a model install fetches the address it is given, reads all of it
   * (as the real one does) and lists the file in its folder. "refuses": it accepts the request and
   * never fetches, as a Manager that is not allowed to download does.
   */
  manager?: boolean | "refuses";
  /**
   * Pretend to render: every prompt reports progress step by step, streams previews, and finishes with a
   * picture of the size that was asked for. A load snapshot is broadcast every second, as a monitor
   * extension would. For running the real app without a GPU.
   */
  simulate?: {
    stepMs: number;
    /** What a video workflow "renders": an MP4, or a function that makes one for the graph it was sent. Without it, video prompts fail. */
    video?: Uint8Array | ((graph: Graph, seed: number) => Uint8Array | undefined);
  };
}

export async function startFakeComfy(init: FakeInit = {}): Promise<FakeComfy> {
  const fake: Omit<FakeComfy, "url" | "close" | "send" | "sendBinary"> = {
    calls: [], prompts: new Map(), history: {}, running: [], pending: [], files: {}, rejectWith: null, uploads: [], metadata: {}, sockets: [], installed: [],
    catalog: init.catalog ?? {},
    models: init.models ?? {},
  };
  let n = 0;
  // ---- pretend ComfyUI-Manager (init.manager)
  const MANAGER_FOLDER: Record<string, string> = {
    checkpoints: "checkpoints", checkpoint: "checkpoints", lora: "loras", vae: "vae", clip: "text_encoders", text_encoders: "text_encoders",
    unet: "diffusion_models", diffusion_model: "diffusion_models", upscale: "upscale_models", controlnet: "controlnet", clip_vision: "clip_vision", embedding: "embeddings",
  };
  let installs: Array<{ type: string; save_path: string; url: string; filename: string }> = [];
  const install = async (task: (typeof installs)[number]) => {
    const got = await fetch(task.url).catch(() => null);
    if (!got?.ok) return;
    const bytes = (await got.arrayBuffer()).byteLength;
    const [folder, ...sub] = task.save_path === "default" ? [MANAGER_FOLDER[task.type.toLowerCase()] ?? "etc"] : task.save_path.split("/");
    const file = [...sub, task.filename].join("\\");
    (fake.models[folder!] ??= []).push(file);
    fake.installed.push({ folder: folder!, file, bytes });
    // the loaders of that folder offer it from now on, when they list files at all
    const loader = ({ checkpoints: ["CheckpointLoaderSimple", "ckpt_name"], diffusion_models: ["UNETLoader", "unet_name"], loras: ["LoraLoader", "lora_name"], vae: ["VAELoader", "vae_name"], text_encoders: ["CLIPLoader", "clip_name"] } as Record<string, [string, string]>)[folder!];
    const spec = loader && (fake.catalog[loader[0]]?.input.required?.[loader[1]] as unknown[] | undefined);
    const list = Array.isArray(spec?.[0]) ? (spec![0] as string[]) : (spec?.[1] as { options?: string[] } | undefined)?.options;
    if (list?.length) list.push(file);
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    fake.calls.push(`${req.method} ${path}`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET") {
      if (path === "/system_stats") {
        return json(200, { system: { comfyui_version: "0.0.0-fake" }, devices: [{ name: "fake gpu", vram_total: 12 * 2 ** 30, vram_free: 8 * 2 ** 30 }] });
      }
      if (path === "/v2/manager/version" && init.manager) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("V0.0.0-fake");
      }
      if (path === "/object_info") return json(200, fake.catalog);
      if (path === "/models") return json(200, Object.keys(fake.models));
      if (path.startsWith("/models/")) {
        const list = fake.models[decodeURIComponent(path.slice(8))];
        return list ? json(200, list) : json(404, { error: "unknown folder" });
      }
      if (path.startsWith("/view_metadata/")) {
        const header = fake.metadata[`${decodeURIComponent(path.slice(15))}/${url.searchParams.get("filename") ?? ""}`];
        return header ? json(200, header) : json(404, {});
      }
      if (path.startsWith("/history/")) {
        const id = decodeURIComponent(path.slice(9));
        return json(200, fake.history[id] ? { [id]: fake.history[id] } : {});
      }
      if (path === "/queue") {
        return json(200, { queue_running: fake.running.map((id) => [0, id]), queue_pending: fake.pending.map((id) => [0, id]) });
      }
      if (path === "/view") {
        const file = fake.files[url.searchParams.get("filename") ?? ""];
        if (!file) return json(404, { error: "no such file" });
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(file);
      }
    }
    if (req.method === "POST") {
      const raw = await body(req);
      if (path === "/prompt") {
        if (fake.rejectWith) return json(400, fake.rejectWith);
        const id = `prompt-${++n}`;
        fake.prompts.set(id, (JSON.parse(raw.toString("utf-8")) as { prompt: Graph }).prompt);
        fake.pending.push(id);
        if (init.simulate) void simulate(id);
        return json(200, { prompt_id: id });
      }
      if (path === "/queue") {
        const ids = (JSON.parse(raw.toString("utf-8")) as { delete?: string[] }).delete ?? [];
        fake.pending = fake.pending.filter((id) => !ids.includes(id));
        return json(200, {});
      }
      if (path === "/interrupt") {
        const id = (JSON.parse(raw.toString("utf-8")) as { prompt_id?: string }).prompt_id;
        fake.running = fake.running.filter((r) => r !== id);
        return json(200, {});
      }
      if (path === "/free") return json(200, {});
      if (path === "/v2/manager/queue/install_model" && init.manager) {
        const task = JSON.parse(raw.toString("utf-8")) as (typeof installs)[number] & { client_id?: string; ui_id?: string };
        if (!task.client_id || !task.ui_id || /[\\/:]/.test(task.filename)) {
          res.writeHead(400);
          return res.end("Invalid model data");
        }
        installs.push(task);
        res.writeHead(200);
        return res.end();
      }
      if (path === "/v2/manager/queue/start" && init.manager) {
        const todo = installs;
        installs = [];
        if (init.manager !== "refuses") for (const task of todo) void install(task);
        res.writeHead(200);
        return res.end();
      }
      if (path === "/upload/image") {
        const name = /filename="([^"]+)"/.exec(raw.toString("latin1"))?.[1] ?? "upload.bin";
        fake.uploads.push(name);
        return json(200, { name, subfolder: "", type: "temp" });
      }
    }
    json(404, { error: `fake ComfyUI has no ${req.method} ${path}` });
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (_socket, req) => {
    fake.sockets.push(new URL(req.url ?? "/", "http://fake").searchParams.get("clientId") ?? "");
  });
  const send = (type: string, data: unknown) => wss.clients.forEach((c) => c.send(JSON.stringify({ type, data })));
  const sendBinary = (bytes: Uint8Array) => wss.clients.forEach((c) => c.send(bytes));

  // ---- pretend rendering (init.simulate)
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const stillWanted = (id: string) => !closed && (fake.pending.includes(id) || fake.running.includes(id));
  /** One prompt at a time, in the order they came, like ComfyUI. */
  const simulate = (id: string) =>
    (chain = chain.then(async () => {
      const stepMs = init.simulate!.stepMs;
      const graph = fake.prompts.get(id)!;
      if (!stillWanted(id)) return;
      fake.pending = fake.pending.filter((p) => p !== id);
      fake.running.push(id);
      const nodes = Object.entries(graph);
      // a sampler has its steps on itself, or (the custom sampler) on the scheduler it takes its sigmas from
      const samples = (node: Graph[string]) => /KSampler$|KSamplerAdvanced|SamplerCustom/.test(node.class_type);
      const stepsOf = (node: Graph[string]) => {
        const sigmas = node.inputs.sigmas as [string, number] | undefined;
        return Number(node.inputs.steps ?? (sigmas ? graph[sigmas[0]]?.inputs.steps : undefined) ?? 20);
      };
      const first = nodes.find(([, node]) => samples(node));
      const noise = nodes.find(([, node]) => node.class_type === "RandomNoise");
      const seed = Number(first?.[1].inputs.seed ?? first?.[1].inputs.noise_seed ?? noise?.[1].inputs.noise_seed ?? 1);
      send("execution_start", { prompt_id: id });
      await pause(stepMs * 3); // "loading the model"
      for (const [nodeId, node] of nodes) {
        if (!stillWanted(id)) break;
        send("executing", { prompt_id: id, node: nodeId });
        if (!samples(node)) continue;
        const steps = stepsOf(node);
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
        return;
      }
      const sized = [...nodes].reverse().find(([, node]) => typeof node.inputs.width === "number" && typeof node.inputs.height === "number");
      const width = Number(sized?.[1].inputs.width ?? 832);
      const height = Number(sized?.[1].inputs.height ?? 1216);
      fake.running = fake.running.filter((r) => r !== id);
      const videoOut = nodes.find(([, node]) => /VideoCombine|SaveVideo|SaveAnimated/i.test(node.class_type))?.[0];
      if (videoOut) {
        // a pretend clip: the same short video whatever was asked, when the caller supplied one
        const source = init.simulate!.video;
        const clip = typeof source === "function" ? source(graph, seed) : source;
        if (!clip) {
          fake.history[id] = { status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "the pretend ComfyUI has no video to return" }]] } };
          return;
        }
        fake.files[`${id}.mp4`] = clip;
        fake.history[id] = { status: { status_str: "success", completed: true }, outputs: { [videoOut]: { gifs: [{ filename: `${id}.mp4`, subfolder: "", type: "temp" }] } } };
        return;
      }
      const out = nodes.find(([, node]) => node.class_type === "PreviewImage" || node.class_type === "SaveImage")?.[0] ?? "0";
      const filename = `${id}.png`;
      fake.files[filename] = makePng(width, height, tint(seed, 0), tint(seed, 0.35));
      fake.history[id] = { status: { status_str: "success", completed: true }, outputs: { [out]: { images: [{ filename, subfolder: "", type: "temp" }] } } };
    }));
  const load = init.simulate
    ? setInterval(() => {
        const busy = fake.running.length > 0;
        send("dasiwa.system_monitor", {
          cpu_percent: busy ? 22 : 6, cpu_count: 16,
          ram: { used: 19e9, total: 32e9, percent: 59 }, swap: { used: 1e9, total: 40e9, percent: 2 },
          disks: [{ path: "/", percent: 61, read_mb_s: 0, write_mb_s: busy ? 1.2 : 0 }],
          gpus: [{ name: "Pretend GPU", utilization: busy ? 97 : 2, memory_used: (busy ? 9.4 : 1.3) * 2 ** 30, memory_total: 12 * 2 ** 30, memory_percent: busy ? 78 : 11, temperature: busy ? 74 : 41 }],
        });
      }, 1000)
    : null;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    send,
    sendBinary,
    close: () =>
      new Promise<void>((resolve, reject) => {
        closed = true;
        if (load) clearInterval(load);
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  });
}
