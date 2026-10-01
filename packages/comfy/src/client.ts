import { randomUUID } from "node:crypto";
import type { Graph, NodeCatalog } from "@studai/core";

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
  outputs?: Record<string, { images?: OutputFile[]; gifs?: OutputFile[]; audio?: OutputFile[] }>;
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
 * Everything studai asks of a ComfyUI over HTTP. The read-only calls (status, catalog, folders, models,
 * history, queue) never load a model or touch the GPU.
 */
export class ComfyClient {
  readonly baseUrl: string;
  /**
   * One per process, never a shared constant: ComfyUI drops a client id as soon as ANY socket that
   * uses it closes, which silently cuts off every other holder of the same id.
   */
  readonly clientId = `studai-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

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

  /** Queue a graph. `preview`: stream cheap latent previews for this prompt only. */
  async submit(graph: Graph, opts: { preview?: "latent2rgb" | "taesd" } = {}): Promise<string> {
    const res = await this.fetcher(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: this.clientId,
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

  /** Put a file in ComfyUI's temp folder; returns the name loader nodes take ("<name> [temp]"). */
  async upload(bytes: Uint8Array, ext: string): Promise<string> {
    const form = new FormData();
    const type = MIME[ext] ?? "application/octet-stream";
    form.append("image", new Blob([new Uint8Array(bytes).buffer], { type }), `studai_${randomUUID()}.${ext}`);
    form.append("type", "temp");
    form.append("overwrite", "true");
    const r = (await (await this.request("/upload/image", { method: "POST", body: form }, 60_000)).json()) as { name: string; subfolder?: string };
    return `${r.subfolder ? `${r.subfolder}/` : ""}${r.name} [temp]`;
  }

  /** Download one output file of a finished prompt. */
  async view(file: OutputFile): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    return new Uint8Array(await (await this.request(`/view?${q}`, undefined, 5 * 60_000)).arrayBuffer());
  }
}
