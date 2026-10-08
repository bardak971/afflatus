import { randomUUID } from "node:crypto";
import type { Graph, NodeCatalog } from "@afflatus/core";

/** ComfyUI did not answer at all. */
export class ComfyUnreachable extends Error {}
/** ComfyUI answered with an error; the message is safe to show. */
export class ComfyError extends Error {}

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
export interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
  /** images: PreviewImage / SaveImage; gifs: VideoHelperSuite's combine node (videos too). */
  outputs?: Record<string, { images?: OutputFile[]; gifs?: OutputFile[]; audio?: OutputFile[]; latents?: OutputFile[] }>;
}

const META_TIMEOUT = 15_000;

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
  return body.replace(/\s+/g, " ").slice(0, 160);
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

  constructor(baseUrl: string, private readonly fetcher: typeof fetch = fetch) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  private async request(path: string, init?: RequestInit, timeoutMs = META_TIMEOUT): Promise<Response> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((err) => {
      throw new ComfyUnreachable(`ComfyUI did not answer at ${this.baseUrl}: ${(err as Error).message}`);
    });
    if (!res.ok) {
      throw new ComfyError(`ComfyUI ${path.split("?")[0]} failed (${res.status}): ${errorSnippet(await res.text().catch(() => ""))}`);
    }
    return res;
  }

  private post(path: string, body: unknown, timeoutMs?: number) {
    return this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
  }

  // ---------------------------------------------------------------- read-only

  async status(): Promise<ComfyStatus> {
    const s = (await (await this.request("/system_stats", undefined, 5_000)).json()) as {
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
    return (await (await this.request("/object_info", undefined, 60_000)).json()) as NodeCatalog;
  }

  /** The model folders this ComfyUI knows ("checkpoints", "loras", …). */
  async folders(): Promise<string[]> {
    return (await (await this.request("/models")).json()) as string[];
  }

  /** Files in one model folder, as the paths ComfyUI's loaders expect. */
  async models(folder: string): Promise<string[]> {
    return (await (await this.request(`/models/${encodeURIComponent(folder)}`)).json()) as string[];
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
    const res = await this.request("/internal/logs/raw");
    const d = (await res.json()) as { entries?: Array<{ t: string; m: string }> };
    return (d.entries ?? []).map((e) => ({ t: e.t, m: String(e.m).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "") }));
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const h = (await (await this.request(`/history/${encodeURIComponent(promptId)}`)).json()) as Record<string, HistoryEntry>;
    return h[promptId];
  }

  /** Where ComfyUI has a prompt: running, waiting behind other work, or nowhere. */
  async queuePosition(promptId: string): Promise<"running" | "pending" | "absent"> {
    const q = (await (await this.request("/queue")).json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if (q.queue_running?.some((e) => e[1] === promptId)) return "running";
    if (q.queue_pending?.some((e) => e[1] === promptId)) return "pending";
    return "absent";
  }

  // ---------------------------------------------------------------- these use the GPU or change ComfyUI's state

  /**
   * Queue a graph. `preview`: stream cheap latent previews for this prompt only. `promptId`: the id to queue it under, chosen
   * (and saved) beforehand, so that one sent without an answer can be asked for; the id ComfyUI gave is returned all the same.
   */
  async submit(graph: Graph, opts: { preview?: "latent2rgb" | "taesd"; promptId?: string } = {}): Promise<string> {
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
    try {
      id = (JSON.parse(text) as { prompt_id?: string }).prompt_id;
    } catch {
      /* handled below */
    }
    if (!res.ok || !id) throw new ComfyError(`ComfyUI rejected the job: ${errorSnippet(text) || `status ${res.status}`}`);
    return id;
  }

  /** Stop one prompt: drop it from the pending queue, and interrupt it if it is the one running. */
  async interrupt(promptId: string): Promise<void> {
    await this.post("/queue", { delete: [promptId] }).catch(() => {});
    await this.post("/interrupt", { prompt_id: promptId }).catch(() => {});
  }

  /** Unload every model and clear ComfyUI's caches. Used before a job that loads a different model. */
  async free(): Promise<void> {
    await this.post("/free", { unload_models: true, free_memory: true });
  }

  /**
   * Put a file in ComfyUI's temp folder; returns the name loader nodes take ("<name> [temp]"). With `into: "input"`
   * it goes to the input folder's "afflatus" subfolder instead, for a node that reads only from there (the DaSiWa
   * Director's pictures); the name is then "afflatus/<name>".
   */
  async upload(bytes: Uint8Array, ext: string, opts: { into?: "input" } = {}): Promise<string> {
    const form = new FormData();
    const type = MIME[ext] ?? "application/octet-stream";
    form.append("image", new Blob([new Uint8Array(bytes).buffer], { type }), `afflatus_${randomUUID()}.${ext}`);
    form.append("type", opts.into === "input" ? "input" : "temp");
    if (opts.into === "input") form.append("subfolder", "afflatus");
    form.append("overwrite", "true");
    const r = (await (await this.request("/upload/image", { method: "POST", body: form }, 60_000)).json()) as { name: string; subfolder?: string };
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
    return new Uint8Array(await (await this.request(`/view?${q}`, undefined, 5 * 60_000)).arrayBuffer());
  }
}
