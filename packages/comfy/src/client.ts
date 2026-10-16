import { createHash, randomUUID } from "node:crypto";
import type { Graph, NodeCatalog } from "@afflatus/core";

/** ComfyUI did not answer at all. */
export class ComfyUnreachable extends Error {}
/** ComfyUI answered with an error; the message is safe to show. */
export class ComfyError extends Error {}
/**
 * ComfyUI is locked by Afflatus's node pack and refused the token sent (none, or another machine's, or an old one): it is
 * there, but out of reach as much as one that does not answer, so a job waits for it the same way. Its message says why.
 */
export class ComfyLocked extends ComfyUnreachable {}

/**
 * A hash of each node list as ComfyUI sent it: machines with the same nodes and the same files send the same list, and what
 * is worked out from it (capabilities.ts readiness) is then worked out once for all of them.
 */
const catalogKeys = new WeakMap<NodeCatalog, string>();
/** The hash of a node list read by `ComfyClient.catalog`; undefined for one made otherwise (a test's). */
export const catalogKey = (catalog: NodeCatalog): string | undefined => catalogKeys.get(catalog);

/** What the pack's lock answers a call without the right token: a 401 that says it is the lock, not some other server's login. */
export const LOCKED_HEADER = "x-afflatus-lock";

/** The statuses a gateway answers with when what is behind it does not (502, 503, 504, and Cloudflare's 520 to 524). */
const UNREACHED = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

export interface ComfyStatus {
  version: string;
  /** Name of the first GPU (or "cpu"). */
  device: string;
  /** Bytes. */
  vramTotal: number;
  vramFree: number;
}

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}
/** A prompt in ComfyUI's queue (ComfyClient.queue): its id, and the client id it was queued under (null: none). */
export interface QueueEntry {
  promptId: string;
  clientId: string | null;
}
export interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
  /** images: PreviewImage / SaveImage; gifs: VideoHelperSuite's combine node (videos too). */
  outputs?: Record<string, { images?: OutputFile[]; gifs?: OutputFile[]; audio?: OutputFile[]; latents?: OutputFile[] }>;
}

const META_TIMEOUT = 15_000;
/** The GPU's power is read every few seconds: an answer later than this is skipped, not waited for. */
const POWER_TIMEOUT = 2_000;
/** How many prompts sent lately keep their node classes (ComfyClient.classesOf): the ones running and waiting, and more. */
const SENT_KEPT = 32;

/** What of an upstream error body reaches the user: ComfyUI's own message when it's JSON, else a short piece. */
function errorSnippet(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; details?: string } | string;
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;
    };
    const parts: string[] = [];
    if (typeof j.error === "string") parts.push(j.error);
    else if (j.error?.message) parts.push(j.error.message + (j.error.details ? `: ${j.error.details}` : ""));
    for (const [id, ne] of Object.entries(j.node_errors ?? {})) {
      for (const e of ne.errors ?? []) parts.push(`${ne.class_type ?? id}: ${e.message ?? ""} ${e.details ?? ""}`.trim());
    }
    if (parts.length) return parts.join("; ").slice(0, 600);
  } catch {
    /* not JSON */
  }
  // not ComfyUI's own error: the address may be another service's (Settings take any URL), whose page is not
  // Afflatus's to pass on. Its first line, short and without markup, is enough to see which server answered
  return (body.trim().split(/\r?\n/)[0] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Headers given any way fetch takes them, as a plain record. */
function headersOf(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

/** The nodes these come from, themselves included: every node whose output reaches them through the graph's links. */
export function upstreamOf(graph: Graph, nodes: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...nodes];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const v of Object.values(graph[id]?.inputs ?? {})) {
      // a link is [node id, output slot]
      if (Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number") stack.push(String(v[0]));
    }
  }
  return seen;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
  wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
};

/**
 * Everything Afflatus asks of a ComfyUI over HTTP. The read-only calls (status, catalog, folders, models,
 * history, queue) never load a model or touch the GPU.
 */
export class ComfyClient {
  readonly baseUrl: string;
  /**
   * One per process, never a shared constant: ComfyUI drops a client id as soon as ANY socket that
   * uses it closes, which silently cuts off every other holder of the same id.
   */
  readonly clientId = `afflatus-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  /** This ComfyUI's token when it is locked (Afflatus's node pack), sent on every call; empty when it is not. */
  token = "";
  private readonly fetcher: typeof fetch;

  /** @param fetcher the fetch to call; without one, the global fetch as it is at each call (a test may stand in for it) */
  constructor(baseUrl: string, fetcher?: typeof fetch, token = "") {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.token = token;
    // every call this client makes carries the token, whichever method makes it: the lock refuses any that does not
    this.fetcher = (input, init) => (fetcher ?? fetch)(input, this.token ? { ...init, headers: { ...headersOf(init?.headers), Authorization: `Bearer ${this.token}` } } : init);
  }

  /**
   * A call to this ComfyUI as it comes, its status not judged: for the callers that read another service's answer through
   * it (ComfyUI-Manager's, the node pack's downloads), with the token as every call has it.
   */
  raw(path: string, init?: RequestInit): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${path}`, init);
  }

  /**
   * The websocket's address for a client id. Never with the token in it: an address is written in the logs of whatever
   * stands in front of ComfyUI (RunPod's proxy), so the token goes in the socket's Authorization header (socket()).
   */
  socketUrl(clientId: string): string {
    return `${this.baseUrl.replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  }

  /** A websocket to this ComfyUI for a client id, with the token as every call has it: Node's WebSocket takes headers, a browser's would not. */
  socket(clientId: string): WebSocket {
    const init = this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined;
    return new (WebSocket as unknown as new (url: string, init?: { headers: Record<string, string> }) => WebSocket)(this.socketUrl(clientId), init);
  }

  private async request(path: string, init?: RequestInit, timeoutMs = META_TIMEOUT): Promise<Response> {
    // a caller's own signal (a job's Stop) ends it too, as its time limit does
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    if (res.status === 401 && res.headers.get(LOCKED_HEADER)) {
      await res.body?.cancel().catch(() => {});
      throw new ComfyLocked(this.token ? `ComfyUI at ${this.baseUrl} is locked, and refused the token Afflatus has for it: paste its token in Settings › ComfyUI.` : `ComfyUI at ${this.baseUrl} is locked: paste its token in Settings › ComfyUI.`);
    }
    // a proxy in front of it (RunPod's, Cloudflare's, a reverse proxy's) that could not reach it: ComfyUI did not answer, and
    // may well still be rendering. A job waits for it as for any silence, instead of failing a render that goes on, billed
    if (UNREACHED.has(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl} (${path.split("?")[0]}: ${res.status} from the proxy in front of it)`);
    }
    if (!res.ok) {
      throw new ComfyError(`ComfyUI ${path.split("?")[0]} failed (${res.status}): ${errorSnippet(await res.text().catch(() => ""))}`);
    }
    return res;
  }

  /**
   * A request and its body, read under the same time limit: a body that stops coming half way (a slow /history) is ComfyUI
   * not answering, as a request that never starts is (ComfyUnreachable, which a job waits through), not a bare TimeoutError.
   */
  private async read<T>(path: string, body: (res: Response) => Promise<T>, init?: RequestInit, timeoutMs = META_TIMEOUT): Promise<T> {
    const res = await this.request(path, init, timeoutMs);
    try {
      return await body(res);
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ComfyUnreachable(`ComfyUI stopped answering at ${this.baseUrl} (${path.split("?")[0]}): ${(err as Error).message}`);
      throw err;
    }
  }

  private post(path: string, body: unknown, timeoutMs?: number) {
    return this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
  }

  // ---------------------------------------------------------------- read-only

  async status(): Promise<ComfyStatus> {
    const s = (await this.read("/system_stats", (r) => r.json(), undefined, 5_000)) as {
      system?: { comfyui_version?: string };
      devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
    };
    const gpu = s.devices?.[0];
    return {
      version: s.system?.comfyui_version ?? "unknown",
      device: gpu?.name ?? "cpu",
      vramTotal: gpu?.vram_total ?? 0,
      vramFree: gpu?.vram_free ?? 0,
    };
  }

  /** Every node this ComfyUI has, with its inputs and outputs. A large response (tens of MB with many custom nodes). */
  async catalog(): Promise<NodeCatalog> {
    const text = await this.read("/object_info", (r) => r.text(), undefined, 60_000);
    // read in a turn of its own: several machines' lists arriving together are not parsed in one block
    await new Promise((go) => setImmediate(go));
    const catalog = JSON.parse(text) as NodeCatalog;
    catalogKeys.set(catalog, createHash("sha1").update(text).digest("base64"));
    return catalog;
  }

  /** The model folders this ComfyUI knows ("checkpoints", "loras", …). */
  async folders(): Promise<string[]> {
    return (await this.read("/models", (r) => r.json())) as string[];
  }

  /** Files in one model folder, as the paths ComfyUI's loaders expect. */
  async models(folder: string): Promise<string[]> {
    return (await this.read(`/models/${encodeURIComponent(folder)}`, (r) => r.json())) as string[];
  }

  /**
   * What a model file says about itself in its header (only .safetensors files have one), or null when
   * it says nothing. ComfyUI reads the start of the file; no model is loaded.
   */
  async metadata(folder: string, file: string): Promise<Record<string, unknown> | null> {
    const res = await this.fetcher(`${this.baseUrl}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(META_TIMEOUT) }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    // ComfyUI answers "not found" for a file without a header, and for anything that is not a .safetensors file
    if (res.status === 404) return null;
    if (!res.ok) throw new ComfyError(`ComfyUI /view_metadata failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * A model file's whole header (metadata, and each tensor's dtype and shape) through Afflatus's node pack,
   * which adds that route to ComfyUI's server. Null when the pack is not there (ComfyUI answers 404 for an
   * unknown route) or the file has no header. For an Afflatus that cannot read ComfyUI's disk.
   */
  async header(folder: string, file: string): Promise<Record<string, unknown> | null> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/header?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(META_TIMEOUT) }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ComfyError(`ComfyUI /afflatus/header failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** ComfyUI's own terminal log: the last few hundred lines it keeps, their colour codes stripped. Read-only. */
  async logs(): Promise<Array<{ t: string; m: string }>> {
    const d = (await this.read("/internal/logs/raw", (r) => r.json())) as { entries?: Array<{ t: string; m: string }> };
    return (d.entries ?? []).map((e) => ({ t: e.t, m: String(e.m).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "") }));
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const h = (await this.read(`/history/${encodeURIComponent(promptId)}`, (r) => r.json())) as Record<string, HistoryEntry>;
    return h[promptId];
  }

  /** Where ComfyUI has a prompt: running, waiting behind other work, or nowhere. */
  async queuePosition(promptId: string): Promise<"running" | "pending" | "absent"> {
    const q = (await this.read("/queue", (r) => r.json())) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if (q.queue_running?.some((e) => e[1] === promptId)) return "running";
    if (q.queue_pending?.some((e) => e[1] === promptId)) return "pending";
    return "absent";
  }

  /**
   * ComfyUI's whole queue: the prompts running and waiting, whoever queued them (Afflatus, ComfyUI's own page, another
   * tool), each with the client id it was queued under (null when it named none). Each entry is
   * `[number, prompt_id, prompt, extra_data, outputs]`; a prompt id is what tells Afflatus's own from the others.
   */
  async queue(): Promise<{ running: QueueEntry[]; pending: QueueEntry[] }> {
    const q = (await this.read("/queue", (r) => r.json())) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    const entries = (list: unknown[][] | undefined): QueueEntry[] => (list ?? []).flatMap((e) => {
      if (!Array.isArray(e) || typeof e[1] !== "string") return [];
      const client = (e[3] as { client_id?: unknown } | null | undefined)?.client_id;
      return [{ promptId: e[1], clientId: typeof client === "string" ? client : null }];
    });
    return { running: entries(q.queue_running), pending: entries(q.queue_pending) };
  }

  // ---------------------------------------------------------------- these use the GPU or change ComfyUI's state

  /**
   * Queue a graph. `preview`: stream cheap latent previews for this prompt only. `promptId`: the id to queue it under, chosen
   * (and saved) beforehand, so that one sent without an answer can be asked for; the id ComfyUI gave is returned all the same.
   * `outputs`: the result nodes. ComfyUI queues a prompt when any of its outputs validates and skips the ones that do not,
   * answering 200 with their node_errors: when one names a result node or a node it is made from, the prompt is taken back
   * and refused with that error, which would otherwise be lost behind "ComfyUI finished but returned no output".
   */
  async submit(graph: Graph, opts: { preview?: "latent2rgb" | "taesd"; promptId?: string; outputs?: string[] } = {}): Promise<string> {
    const res = await this.fetcher(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: this.clientId,
        ...(opts.promptId ? { prompt_id: opts.promptId } : {}),
        ...(opts.preview ? { extra_data: { preview_method: opts.preview } } : {}),
      }),
      signal: AbortSignal.timeout(META_TIMEOUT),
    }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    const text = await res.text().catch(() => "");
    let id: string | undefined;
    let failed: string[] = [];
    try {
      const answer = JSON.parse(text) as { prompt_id?: string; node_errors?: Record<string, unknown> };
      id = answer.prompt_id;
      failed = Object.keys(answer.node_errors ?? {});
    } catch {
      /* handled below */
    }
    if (!res.ok || !id) throw new ComfyError(`ComfyUI rejected the job: ${errorSnippet(text) || `status ${res.status}`}`);
    if (failed.length && opts.outputs?.length) {
      const feeding = upstreamOf(graph, opts.outputs);
      if (failed.some((n) => feeding.has(n))) {
        await this.interrupt(id);
        throw new ComfyError(`ComfyUI rejected the job: ${errorSnippet(text)}`);
      }
    }
    this.sent.set(id, Object.fromEntries(Object.entries(graph).map(([node, n]) => [node, n.class_type])));
    if (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.keys().next().value!);
    return id;
  }

  /** The node classes of the prompts this client sent lately, by node id. */
  private readonly sent = new Map<string, Record<string, string>>();
  /**
   * A prompt's node classes (node id → class_type), when this client sent it: ComfyUI's messages name a node by its id
   * only, and what a render's time went to is told by class (Monitor.measured). Unknown for one sent before a restart.
   */
  classesOf(promptId: string): Record<string, string> | undefined {
    return this.sent.get(promptId);
  }

  /**
   * Stop one prompt: drop it from the pending queue, and interrupt it if it is the one running. Only then: a ComfyUI from
   * before /interrupt read `prompt_id` stops whatever runs, which may be another prompt (someone else's, or the next job's).
   */
  async interrupt(promptId: string): Promise<void> {
    await this.post("/queue", { delete: [promptId] }).catch(() => {});
    if ((await this.queuePosition(promptId).catch(() => "absent")) !== "running") return;
    await this.post("/interrupt", { prompt_id: promptId }).catch(() => {});
  }

  /** Unload every model and clear ComfyUI's caches. Used before a job that loads a different model. */
  async free(): Promise<void> {
    await this.post("/free", { unload_models: true, free_memory: true });
  }

  /**
   * Put a file in ComfyUI's temp folder; returns the name loader nodes take ("<name> [temp]"). With `into: "input"`
   * it goes to the input folder's "afflatus" subfolder instead, for a node that reads only from there (the DaSiWa
   * Director's pictures); the name is then "afflatus/<name>". `signal` drops it half way (a job's Stop). A Blob (a file on
   * the disk, fs.openAsBlob) is streamed from where it is, not read into memory first. `name`: the file's own name, for a
   * file sent under a name its content gives (starting with "afflatus_", for the cleanup to know it); else a fresh one.
   */
  async upload(bytes: Uint8Array | Blob, ext: string, opts: { into?: "input"; signal?: AbortSignal; name?: string } = {}): Promise<string> {
    const form = new FormData();
    const type = MIME[ext] ?? "application/octet-stream";
    const body = bytes instanceof Blob ? (bytes.type ? bytes : new Blob([bytes], { type })) : new Blob([new Uint8Array(bytes).buffer], { type });
    form.append("image", body, opts.name ?? `afflatus_${randomUUID()}.${ext}`);
    form.append("type", opts.into === "input" ? "input" : "temp");
    if (opts.into === "input") form.append("subfolder", "afflatus");
    form.append("overwrite", "true");
    const r = (await this.read("/upload/image", (res) => res.json(), { method: "POST", body: form, ...(opts.signal ? { signal: opts.signal } : {}) }, 60_000)) as { name: string; subfolder?: string };
    const name = `${r.subfolder ? `${r.subfolder}/` : ""}${r.name}`;
    return opts.into === "input" ? name : `${name} [temp]`;
  }

  /**
   * Remove the files Afflatus put in ComfyUI's input folder (`upload` with `into: "input"`) older than this many
   * hours, through the Afflatus node pack (0.8.0 and later). How many went; null when the pack is older or not loaded.
   */
  async cleanInput(olderThanHours = 24): Promise<number | null> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/clean-input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ older_than_hours: olderThanHours }), signal: AbortSignal.timeout(META_TIMEOUT) }).catch(() => null);
    if (!res?.ok) return null;
    return Number(((await res.json().catch(() => ({}))) as { removed?: unknown }).removed ?? 0);
  }

  /**
   * Remove the videos Afflatus had ComfyUI's own SaveVideo write into its output folder (under Afflatus/), older than this
   * many hours, through the Afflatus node pack (0.10.0 and later). How many went; null when the pack is not loaded. An older
   * pack takes the request for an input-folder cleanup, which is as harmless.
   */
  async cleanOutput(olderThanHours = 24): Promise<number | null> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/clean-input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: "output", older_than_hours: olderThanHours }), signal: AbortSignal.timeout(META_TIMEOUT) }).catch(() => null);
    if (!res?.ok) return null;
    return Number(((await res.json().catch(() => ({}))) as { removed?: unknown }).removed ?? 0);
  }

  /** The version of the Afflatus node pack the running ComfyUI loaded; null when it has none loaded (or one too old to say). */
  async packVersion(): Promise<string | null> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/version`, { signal: AbortSignal.timeout(META_TIMEOUT) }).catch(() => null);
    if (!res?.ok) return null;
    const version = ((await res.json().catch(() => ({}))) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  }

  /**
   * The GPU's power draw as the Afflatus node pack reads it (0.18.0 on, GET /afflatus/power): watts, or null when it cannot
   * read it (no NVIDIA GPU, no NVML nor nvidia-smi). "absent" when the route is not there (no pack, or an older one); null
   * too when ComfyUI did not answer. A short time limit: it is read beside the other figures every few seconds.
   */
  async gpuPower(): Promise<number | null | "absent"> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/power`, { signal: AbortSignal.timeout(POWER_TIMEOUT) }).catch(() => null);
    if (res?.status === 404 || res?.status === 405) {
      await res.body?.cancel().catch(() => {});
      return "absent";
    }
    if (!res?.ok) return null;
    const watts = ((await res.json().catch(() => ({}))) as { watts?: unknown }).watts;
    return typeof watts === "number" && Number.isFinite(watts) && watts >= 0 ? watts : null;
  }

  /**
   * The disk the model folders are on, as the Afflatus node pack reads it (0.19.0 on, GET /afflatus/disk): its bytes free and
   * in all, and what the pack's downloads under way still write. "absent" when the route is not there (an older pack); null
   * when ComfyUI did not answer.
   */
  async disk(): Promise<{ free: number; total: number; downloading: number } | null | "absent"> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/disk`, { signal: AbortSignal.timeout(META_TIMEOUT) }).catch(() => null);
    if (res?.status === 404 || res?.status === 405) {
      await res.body?.cancel().catch(() => {});
      return "absent";
    }
    if (!res?.ok) return null;
    const got = (await res.json().catch(() => ({}))) as { free?: unknown; total?: unknown; downloading?: unknown };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const free = n(got.free);
    const total = n(got.total);
    return free === null || total === null ? null : { free, total, downloading: n(got.downloading) ?? 0 };
  }

  /** A model file taken off the disk to make room (node pack 0.19.0 on, POST /afflatus/models/remove): its bytes. Throws with the pack's reason. */
  async removeModel(folder: string, file: string): Promise<number> {
    const res = await this.fetcher(`${this.baseUrl}/afflatus/models/remove`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, filename: file }), signal: AbortSignal.timeout(META_TIMEOUT) });
    if (!res.ok) throw new Error(`the pod's node pack did not remove it (${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)})`);
    return Number(((await res.json().catch(() => ({}))) as { removed?: unknown }).removed ?? 0);
  }

  /**
   * Write a file into ComfyUI's user data (user/default/<path>): "workflows/afflatus/x.json" is what its
   * Workflows sidebar lists. Replaces a file of that name.
   */
  async storeUserData(path: string, body: unknown): Promise<void> {
    await this.request(`/userdata/${encodeURIComponent(path)}?overwrite=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 30_000);
  }

  /** Whether ComfyUI serves this example workflow of a custom node pack (it does once it started with the pack there). */
  async servesTemplate(pack: string, name: string): Promise<boolean> {
    const res = await this.fetcher(`${this.baseUrl}/api/workflow_templates/${encodeURIComponent(pack)}/${encodeURIComponent(name)}.json`, { method: "HEAD", signal: AbortSignal.timeout(META_TIMEOUT) }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    return res.ok;
  }

  /** Download one output file of a finished prompt. */
  async view(file: OutputFile): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    return new Uint8Array(await this.read(`/view?${q}`, (r) => r.arrayBuffer(), undefined, 5 * 60_000));
  }
}
