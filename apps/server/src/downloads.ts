import { randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { Comfy } from "./comfy";

/**
 * Model files fetched straight into ComfyUI's model folders, through ComfyUI-Manager.
 *
 * Manager's installer only takes an address and says nothing while it works. So it is handed a
 * one-time address on Afflatus, and Afflatus streams the file through it, counting the bytes on the way:
 * that is the progress bar. Nothing is stored by Afflatus, and a Civitai key never leaves it (Manager
 * only ever sees the one-time address).
 */

export interface DownloadView {
  id: string;
  /** The name it will have in ComfyUI, with its sub-folder when it has one. */
  file: string;
  /** The ComfyUI model folder it goes into ("loras", "checkpoints", …). */
  folder: string;
  /** What it is, in words, for the list. */
  title: string;
  bytes: number;
  /** 0 when the source does not say. */
  total: number;
  status: "starting" | "downloading" | "saving" | "done" | "error" | "stopped";
  error?: string;
}

interface Download extends DownloadView {
  token: string;
  source: string;
  headers: Record<string, string>;
  comfy: Comfy;
  finishedAt?: number;
  /** Cuts the download off at its source. */
  abort: AbortController;
}

/** The folders ComfyUI-Manager knows by a type name; any other folder is given to it as a path under models/. */
const MANAGER_TYPE: Record<string, string> = {
  checkpoints: "checkpoints", loras: "lora", vae: "vae", text_encoders: "clip", clip: "clip", diffusion_models: "unet", unet: "unet",
  upscale_models: "upscale", controlnet: "controlnet", clip_vision: "clip_vision", embeddings: "embedding",
};

export const MODEL_FILE = /\.(safetensors|ckpt|gguf|sft|pt|pth|bin|onnx)$/i;
const KEEP_MS = 60 * 60_000;
const STARTS_WITHIN_MS = 90_000;

const unreachable = (err: unknown) => /fetch failed|ECONNREFUSED|did not answer/i.test((err as Error).message);

export class Downloads {
  private readonly all = new Map<string, Download>();
  private lastTold = 0;
  /** How long Manager has to come and fetch before the download is given up (shorter in tests). */
  startsWithinMs = STARTS_WITHIN_MS;
  /** How often ComfyUI is asked whether the file is listed, once all of it was sent. */
  listedEveryMs = 3000;

  constructor(private readonly events: EventEmitter) {}

  private tell(now = false): void {
    // bytes arrive many times a second: say so twice a second at most
    if (!now && Date.now() - this.lastTold < 500) return;
    this.lastTold = Date.now();
    this.events.emit("downloads");
  }

  private fail(d: Download, error: string): void {
    if (d.status === "done" || d.status === "error" || d.status === "stopped") return;
    d.status = "error";
    d.error = error;
    d.finishedAt = Date.now();
    this.tell(true);
  }

  /** Newest first. What finished is forgotten after an hour. */
  list(): DownloadView[] {
    for (const [id, d] of this.all) if (d.finishedAt && Date.now() - d.finishedAt > KEEP_MS) this.all.delete(id);
    return [...this.all.values()].reverse().map(({ token: _t, source: _s, headers: _h, comfy: _c, finishedAt: _f, abort: _a, ...view }) => view);
  }

  /**
   * Stop a download that is under way, or take a finished one off the list. Nothing is left behind:
   * ComfyUI-Manager only writes a file once it has all of it. False when there is no such download,
   * "late" when every byte was already handed over and ComfyUI is saving it.
   */
  stop(id: string): boolean | "late" {
    const d = this.all.get(id);
    if (!d) return false;
    if (d.status === "saving") return "late";
    if (d.status === "starting" || d.status === "downloading") {
      d.status = "stopped";
      d.finishedAt = Date.now();
      d.abort.abort();
    } else this.all.delete(id);
    this.tell(true);
    return true;
  }

  private managerSeen: { url: string; at: number; value: { found: boolean; version?: string } } | null = null;

  /** Whether this ComfyUI has ComfyUI-Manager, and which. Asked at most every half minute: the list of downloads is read often. */
  async manager(comfy: Comfy): Promise<{ found: boolean; version?: string }> {
    const seen = this.managerSeen;
    if (seen && seen.url === comfy.client.baseUrl && Date.now() - seen.at < 30_000) return seen.value;
    let value: { found: boolean; version?: string };
    try {
      const res = await fetch(`${comfy.client.baseUrl}/v2/manager/version`, { signal: AbortSignal.timeout(5000) });
      value = res.ok ? { found: true, version: (await res.text()).trim().slice(0, 40) } : { found: false };
    } catch {
      value = { found: false };
    }
    this.managerSeen = { url: comfy.client.baseUrl, at: Date.now(), value };
    return value;
  }

  /**
   * Ask ComfyUI-Manager to fetch a file. `self` is the address ComfyUI can reach Afflatus at;
   * the bytes then flow through serve().
   */
  async start(comfy: Comfy, self: string, want: { file: string; folder: string; title: string; source: string; headers?: Record<string, string>; total?: number }): Promise<DownloadView> {
    const name = want.file.split(/[\\/]/).pop() ?? "";
    const sub = want.file.split(/[\\/]/).slice(0, -1).filter(Boolean).join("/");
    if (!MODEL_FILE.test(name) || /[:*?"<>|]/.test(name)) throw Object.assign(new Error(`"${name}" is not a model file Afflatus can download.`), { statusCode: 400 });
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(want.folder) || /\.\./.test(`${want.folder}/${sub}`)) throw Object.assign(new Error("that is not a models folder"), { statusCode: 400 });
    const busy = [...this.all.values()].find((d) => d.file === want.file && d.folder === want.folder && (d.status === "starting" || d.status === "downloading" || d.status === "saving"));
    if (busy) return this.list().find((v) => v.id === busy.id)!;

    const d: Download = {
      id: randomUUID(), token: randomBytes(24).toString("hex"), comfy, source: want.source, headers: want.headers ?? {},
      file: want.file, folder: want.folder, title: want.title, bytes: 0, total: want.total ?? 0, status: "starting", abort: new AbortController(),
    };
    this.all.set(d.id, d);
    const post = (path: string, body: unknown) =>
      fetch(comfy.client.baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const type = MANAGER_TYPE[want.folder];
    try {
      const res = await post("/v2/manager/queue/install_model", {
        client_id: "afflatus", ui_id: d.id, name: want.title, type: type ?? "etc", base: "",
        // a folder Manager knows goes where ComfyUI keeps that kind (which may be another disk); a sub-folder or any other folder is a path under models/
        save_path: type && !sub ? "default" : [want.folder, sub].filter(Boolean).join("/"),
        url: `${self.replace(/\/+$/, "")}/api/downloads/fetch/${d.id}?t=${d.token}`,
        filename: name,
      });
      if (res.status === 404) throw new Error("This ComfyUI has no ComfyUI-Manager, which does the downloading. Install the custom node, then try again.");
      if (!res.ok) throw new Error(`ComfyUI-Manager refused the download (${res.status}: ${(await res.text()).slice(0, 160)})`);
      await post("/v2/manager/queue/start", {});
    } catch (err) {
      this.fail(d, unreachable(err) ? "ComfyUI is not answering." : (err as Error).message);
      return this.list().find((v) => v.id === d.id)!;
    }
    // Manager checks what it is allowed to do before it fetches: when it never comes, say why
    setTimeout(() => {
      if (d.status === "starting") {
        this.fail(d, "ComfyUI-Manager did not start the download. Either it is not allowed to (in its config.ini, set network_mode = personal_cloud or security_level = normal, then restart ComfyUI), or ComfyUI cannot reach Afflatus at the address it was given.");
      }
    }, this.startsWithinMs).unref();
    this.tell(true);
    return this.list().find((v) => v.id === d.id)!;
  }

  /**
   * The one-time address Manager fetches: the file streamed through, its bytes counted. Null when the
   * id and token do not match a download that is waiting (the address works once).
   */
  async serve(id: string, token: string): Promise<{ stream: Readable; size: number } | { error: string } | null> {
    const d = this.all.get(id);
    if (!d || d.token !== token || d.status !== "starting") return null;
    d.status = "downloading";
    this.tell(true);
    let res: Response;
    try {
      res = await fetch(d.source, { headers: { "User-Agent": "afflatus", Accept: "*/*", ...d.headers }, redirect: "follow", signal: d.abort.signal });
    } catch (err) {
      this.fail(d, `The download did not start: ${(err as Error).message}`);
      return { error: d.error! };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || /text\/html|application\/json/.test(type)) {
      const refused = res.status === 401 || res.status === 403 || /text\/html/.test(type);
      this.fail(d, refused ? "The site refused the download. For Civitai, save a key in Settings (Finding missing files): some files need an account." : `The site answered ${res.status}.`);
      return { error: d.error! };
    }
    const size = Number(res.headers.get("content-length")) || 0;
    if (size) d.total = size;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        d.bytes += chunk.length;
        this.tell();
        done(null, chunk);
      },
    });
    // pipe() does not pass an error on: a source that breaks (the site drops it, or it is stopped) ends what Manager is reading
    const source = Readable.fromWeb(res.body as WebStream);
    source.on("error", (err) => counter.destroy(err));
    const stream = source.pipe(counter);
    stream.on("error", (err) => this.fail(d, `The download was interrupted: ${err.message}`));
    stream.on("end", () => {
      if (d.status !== "downloading") return;
      // Manager writes the file once it has all of it: wait until ComfyUI lists it
      d.status = "saving";
      this.tell(true);
      void this.untilListed(d);
    });
    return { stream, size };
  }

  /** The other end of the one-time address went away before the end. */
  dropped(id: string): void {
    const d = this.all.get(id);
    if (d?.status === "downloading") this.fail(d, "ComfyUI-Manager dropped the connection.");
  }

  private async untilListed(d: Download): Promise<void> {
    const name = d.file.split(/[\\/]/).pop()!.toLowerCase();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, this.listedEveryMs));
      const files = await d.comfy.client.models(d.folder).catch(() => [] as string[]);
      if (files.some((f) => f.split(/[\\/]/).pop()!.toLowerCase() === name)) {
        d.status = "done";
        d.finishedAt = Date.now();
        // what was worked out about this ComfyUI no longer holds: it has one more file
        d.comfy.forgetAll();
        this.tell(true);
        this.events.emit("models");
        this.events.emit("setup");
        return;
      }
    }
    this.fail(d, "All of it was sent, but ComfyUI does not list the file. Look at ComfyUI's own window for what went wrong (a full disk, or not enough memory to hold the file).");
  }
}
