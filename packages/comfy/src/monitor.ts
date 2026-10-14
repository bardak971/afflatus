import type { Phase } from "@afflatus/core";
import type { ComfyClient, OutputFile } from "./client";
import { systemLoadFrom, type SystemLoad } from "./system";

/** What the monitor needs to know about a prompt to turn ComfyUI's messages into progress. */
export interface Tracking {
  promptId: string;
  totalSteps: number;
  /** Node id → the phase shown while it runs. */
  phases: Record<string, Phase>;
  /** The sampling passes in the order they run (see BuiltGraph.passes). */
  passes?: Array<{ node: string; steps: number }>;
  /**
   * The client id the prompt was queued with, when that was another process (this one started while
   * the prompt was already running). ComfyUI sends a prompt's progress only to the client that queued it.
   */
  clientId?: string;
  /**
   * What renders like this one usually take after the first sampling pass, from the record of past
   * renders: the passes that follow it, and the finishing (decoding, smoothing, saving). The time left
   * counts them; without them it is the steps left at the pace so far.
   */
  expect?: { laterMs?: number; finishMs?: number };
  /**
   * The steps a process that followed this prompt before had counted (saved on its job): a render picked up
   * again mid-way starts its count there, where which pass is running cannot say it (one node sampling chunk
   * after chunk, a graph without passes).
   */
  stepsDone?: number;
}

/** What was measured while a prompt ran: what the record of render times is made of. */
export interface Measured {
  /** Milliseconds in each phase. "loading" is everything before the first step: the model, the text, the pictures. */
  phases: Record<string, number>;
  /** Milliseconds per step of the first sampling pass; null when fewer than two steps were timed. */
  stepMs: number | null;
  /** The highest share of the GPU's memory in use, in percent, and the hottest it got; null when nothing reports them. */
  vramPeak: number | null;
  heatPeak: number | null;
}

export interface Progress {
  /** 0–0.99 while it runs: only the finished result is 1. */
  progress: number;
  /** Seconds left, 0 when unknown. */
  eta: number;
  phase: Phase | "waiting";
  step: number;
  steps: number;
}

/** The pictures one node of the prompt put out (a Preview Image on the way, the saver at the end). */
export interface Stage {
  node: string;
  files: OutputFile[];
}

export interface Preview {
  /** Goes up by one with every frame, so a viewer knows when to refetch. */
  seq: number;
  bytes?: Uint8Array;
  /** image/jpeg, image/png, or an animated video/mp4 / image/webp from KJNodes' preview node. */
  mime?: string;
}

interface Tracked extends Tracking {
  /** Steps of samplers that already finished. */
  done: number;
  node: string | null;
  value: number;
  max: number;
  phase: Phase | "waiting";
  executing: string | null;
  samplingAt: number | null;
  stepsAtStart: number;
  /** The saved count of a prompt picked up again (Tracking.stepsDone), within the total; 0 when there is none. */
  resumed: number;
  preview: Preview;
  /** What the prompt showed on the way: each preview or save node's pictures, in the order they came. */
  stages: Stage[];
  /** The phase time is being counted for, and since when. */
  clock: { phase: string; at: number };
  spent: Record<string, number>;
  /** The first node that reported steps: when its first and its latest step were reported, and which they were. */
  firstPass: { node: string; phase: string; firstAt: number; firstValue: number; lastAt: number; lastValue: number } | null;
  vramPeak: number | null;
  heatPeak: number | null;
}

const SAMPLER_PHASES: ReadonlyArray<string> = ["sampling", "refining", "restoring", "detailing"];
/**
 * The types an animated live preview (KJNodes) may say it is: the server sends the picture back under that type, so
 * whatever a ComfyUI message names (text/html, a script) would be a page of Afflatus's own. Anything else is read as a JPEG.
 */
const PREVIEW_MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/;
/** How long a dropped socket waits before it is opened again: doubling from the first wait to the longest. */
const RETRY = { firstMs: 500, mostMs: 15_000 };

/**
 * Listens to one ComfyUI's websocket and keeps the progress and the latest live preview of the prompts
 * it was told to track. Best effort by design: a render completes through /history whether or not
 * this socket is up, so every failure here is swallowed.
 */
export class Monitor {
  private ws: WebSocket | null = null;
  private readonly tracked = new Map<string, Tracked>();
  /** Sockets opened under another client id, to follow a prompt queued before this process started. */
  private readonly borrowed = new Map<string, WebSocket>();
  /** Sockets to open again after they dropped (a ComfyUI restart, a network blip): "own", or a borrowed socket's prompt id. */
  private readonly retries = new Map<string, { waitMs: number; timer: ReturnType<typeof setTimeout> | null }>();
  /** The prompt ComfyUI is executing. Previews carry no prompt id: they belong to this one. */
  private current: Tracked | null = null;
  /** Called whenever a tracked prompt's progress or preview changed. */
  onChange: (promptId: string) => void = () => {};
  /** The latest load snapshot a monitor extension broadcast (about one a second), if one is installed. */
  system: SystemLoad | null = null;
  onSystem: (load: SystemLoad) => void = () => {};
  /** Called when the socket opens; `again` after the first time, which is how a ComfyUI restart shows (what it had may have changed). */
  onOpen: (again: boolean) => void = () => {};
  private opened = 0;
  private readonly now: () => number;

  /** @param opts.now the clock phases and steps are timed by (a test's own) */
  constructor(private readonly client: ComfyClient, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Open the socket if it isn't. Call before submitting, so the first messages aren't missed. */
  ensure(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.cancelRetry("own");
    try {
      const ws = new WebSocket(this.client.socketUrl(this.client.clientId));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.retries.delete("own");
        try {
          this.onOpen(this.opened++ > 0);
        } catch {
          /* a listener's problem is not the socket's */
        }
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        // dropped while prompts are followed: opened again, so their progress does not wait for the next submit
        if (this.tracked.size) this.retry("own", () => this.ensure());
      };
      ws.onerror = () => {};
      this.ws = ws;
    } catch {
      this.ws = null;
    }
  }

  /** Resolves when the socket is open (or failed to open): for tests and for "connect, then submit". */
  ready(): Promise<void> {
    this.ensure();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.CONNECTING) return Promise.resolve();
    return new Promise((resolve) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => resolve(), { once: true });
      ws.addEventListener("close", () => resolve(), { once: true });
    });
  }

  close(): void {
    for (const promptId of new Set([...this.borrowed.keys(), ...this.retries.keys()])) if (promptId !== "own") this.release(promptId);
    this.cancelRetry("own");
    this.retries.delete("own");
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  /** Open a dropped socket again later, waiting twice as long after each failed try, up to RETRY.mostMs. */
  private retry(key: string, open: () => void): void {
    const r = this.retries.get(key) ?? { waitMs: 0, timer: null };
    if (r.timer) return;
    r.waitMs = Math.min(RETRY.mostMs, r.waitMs ? r.waitMs * 2 : RETRY.firstMs);
    r.timer = setTimeout(() => {
      r.timer = null;
      open();
    }, r.waitMs);
    r.timer.unref?.();
    this.retries.set(key, r);
  }

  private cancelRetry(key: string): void {
    const r = this.retries.get(key);
    if (r?.timer) clearTimeout(r.timer);
    if (r) r.timer = null;
  }

  track(t: Tracking): void {
    if (this.tracked.has(t.promptId)) return;
    const totalSteps = Math.max(1, t.totalSteps);
    this.tracked.set(t.promptId, {
      ...t, totalSteps, done: 0, node: null, value: 0, max: 0, phase: "waiting",
      executing: null, samplingAt: null, stepsAtStart: 0, resumed: Math.min(totalSteps, Math.max(0, Math.floor(t.stepsDone ?? 0))), preview: { seq: 0 }, stages: [],
      clock: { phase: "waiting", at: this.now() }, spent: {}, firstPass: null, vramPeak: null, heatPeak: null,
    });
    if (t.clientId && t.clientId !== this.client.clientId) this.listenAs(t.clientId, t.promptId);
  }

  untrack(promptId: string): void {
    this.tracked.delete(promptId);
    if (this.current?.promptId === promptId) this.current = null;
    this.release(promptId);
  }

  /**
   * Follow a prompt that another client queued: connect under that client's id. ComfyUI then sends
   * this socket the prompt's progress, starting with the node it is on right now.
   */
  private listenAs(clientId: string, promptId: string): void {
    try {
      const ws = new WebSocket(this.client.socketUrl(clientId));
      ws.binaryType = "arraybuffer";
      // what arrives here without a prompt id (the "you are on this node" greeting, previews) is about that prompt
      ws.onmessage = (ev) => this.onMessage(ev.data, promptId);
      ws.onopen = () => this.retries.delete(promptId);
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.borrowed.get(promptId) !== ws) return;
        this.borrowed.delete(promptId);
        // dropped while the prompt is still followed: listened to again under the same id
        if (this.tracked.has(promptId)) this.retry(promptId, () => { if (this.tracked.has(promptId) && !this.borrowed.has(promptId)) this.listenAs(clientId, promptId); });
      };
      this.borrowed.set(promptId, ws);
    } catch {
      /* progress is best effort: the result still arrives through the history */
    }
  }

  private release(promptId: string): void {
    this.cancelRetry(promptId);
    this.retries.delete(promptId);
    const ws = this.borrowed.get(promptId);
    this.borrowed.delete(promptId);
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  /** A render joined midway: the passes that run before this node are done. */
  private catchUp(r: Tracked, node: string): void {
    const at = r.passes?.findIndex((p) => p.node === node) ?? -1;
    if (at > 0 && r.done === 0 && !r.node) r.done = r.passes!.slice(0, at).reduce((sum, p) => sum + p.steps, 0);
  }

  /** The phase a prompt is in, as it is shown. ComfyUI loads the weights inside the first sampler: until it reports a step, that sampler is still "loading". */
  private static phaseOf(r: Tracked): string {
    return SAMPLER_PHASES.includes(r.phase) && !r.samplingAt ? "loading" : r.phase;
  }

  /** Count the time since the last message for the phase it was spent in. Called before a message changes the phase. */
  private tick(r: Tracked): void {
    const at = this.now();
    r.spent[r.clock.phase] = (r.spent[r.clock.phase] ?? 0) + (at - r.clock.at);
    r.clock.at = at;
  }

  progress(promptId: string): Progress {
    const r = this.tracked.get(promptId);
    if (!r) return { progress: 0, eta: 0, phase: "waiting", step: 0, steps: 0 };
    // picked up again: the saved count shows from the start, before the first step is heard
    const steps = Math.max(r.done + r.value, r.resumed);
    // the time left comes from the sampling rate alone: a cold model load would inflate it wildly
    let eta = 0;
    if (r.samplingAt && steps > r.stepsAtStart) {
      const perStep = (this.now() - r.samplingAt) / 1000 / (steps - r.stepsAtStart);
      const finish = (r.expect?.finishMs ?? 2000) / 1000;
      const first = r.passes?.[0];
      // a second pass does not go at the pace of the first: what it usually takes is known from past renders
      if (first && r.passes!.length > 1 && r.expect?.laterMs !== undefined && steps < first.steps) eta = (first.steps - steps) * perStep + r.expect.laterMs / 1000 + finish;
      else eta = Math.max(0, (r.totalSteps - steps) * perStep + finish);
    }
    return {
      progress: Math.min(0.99, steps / r.totalSteps), eta, phase: Monitor.phaseOf(r) as Progress["phase"],
      step: Math.min(r.totalSteps, steps), steps: r.totalSteps,
    };
  }

  /** What was measured of a prompt so far. Read it before the prompt is untracked. */
  measured(promptId: string): Measured | null {
    const r = this.tracked.get(promptId);
    if (!r) return null;
    this.tick(r);
    const phases = { ...r.spent };
    const p = r.firstPass;
    const stepMs = p && p.lastValue > p.firstValue ? (p.lastAt - p.firstAt) / (p.lastValue - p.firstValue) : null;
    // the first step is only reported once it is done: its time was counted as loading, and is a step's
    if (p && stepMs && (phases.loading ?? 0) > stepMs) {
      phases.loading = phases.loading! - stepMs;
      phases[p.phase] = (phases[p.phase] ?? 0) + stepMs;
    }
    return { phases, stepMs, vramPeak: r.vramPeak, heatPeak: r.heatPeak };
  }

  preview(promptId: string): Preview {
    return this.tracked.get(promptId)?.preview ?? { seq: 0 };
  }

  /** What a prompt showed on the way, node by node, so far. */
  stages(promptId: string): Stage[] {
    return this.tracked.get(promptId)?.stages ?? [];
  }

  /** @param about the prompt a message is about when it does not say (a socket borrowed for one prompt) */
  private onMessage(raw: unknown, about?: string): void {
    if (typeof raw !== "string") {
      // a binary frame is a live preview of the running prompt: [u32 event = 1][u32 1 = JPEG, 2 = PNG][image]
      const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : null;
      const r = this.current ?? (about ? this.tracked.get(about) : undefined);
      if (!buf || buf.length < 9 || !r) return;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (view.getUint32(0) !== 1) return;
      r.preview = { seq: r.preview.seq + 1, bytes: buf.subarray(8), mime: view.getUint32(4) === 2 ? "image/png" : "image/jpeg" };
      this.onChange(r.promptId);
      return;
    }
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const load = systemLoadFrom(msg.type, msg.data);
    if (load) {
      this.system = load;
      this.peaks(load);
      this.onSystem(load);
      return;
    }
    const d = msg.data ?? {};
    // KJNodes' animated preview carries no prompt id either
    const r = typeof d.prompt_id === "string"
      ? this.tracked.get(d.prompt_id)
      : msg.type === "kj_preview_override" ? this.current
      : about ? this.tracked.get(about) : undefined;
    if (!r) return;
    this.tick(r);
    if (msg.type === "kj_preview_override") {
      if (typeof d.image !== "string" || !d.image) return;
      // before its first step, each sampling pass sends what it starts from: noise, and on a pass that is
      // handed a latent (Wan's low-noise model) a flat gray. Neither is the clip: what the last step showed stays
      if (d.step === 0) return;
      r.preview = {
        seq: r.preview.seq + 1,
        bytes: new Uint8Array(Buffer.from(d.image, "base64")),
        mime: typeof d.mime === "string" && PREVIEW_MIME.test(d.mime) ? d.mime : "image/jpeg",
      };
    } else if (msg.type === "execution_start") {
      r.phase = "loading";
      this.current = r;
    } else if (msg.type === "execution_cached" && Array.isArray(d.nodes)) {
      // the passes ComfyUI still had from the prompt before (the same seed, the same settings) do not run: their steps are done
      const cached = new Set(d.nodes.map(String));
      if (!r.node) r.done += (r.passes ?? []).filter((p) => cached.has(p.node)).reduce((sum, p) => sum + p.steps, 0);
    } else if (msg.type === "executed" && typeof d.node === "string") {
      // a node that puts pictures out: a preview on the way, or a save. Kept in order, for the strip under the live preview
      const out = (d.output ?? {}) as { images?: unknown; gifs?: unknown };
      const files = [...(Array.isArray(out.images) ? out.images : []), ...(Array.isArray(out.gifs) ? out.gifs : [])]
        .filter((f): f is OutputFile => Boolean(f) && typeof (f as OutputFile).filename === "string")
        // what a loader was given, from ComfyUI's input folder (LoadVideo shows its video so): not something the workflow made
        .filter((f) => f.type !== "input")
        .map((f) => ({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" }));
      if (!files.length) return;
      r.stages = [...r.stages.filter((s) => s.node !== d.node), { node: d.node, files }];
    } else if (msg.type === "executing" && typeof d.node === "string") {
      this.catchUp(r, d.node);
      r.executing = d.node;
      r.phase = r.phases[d.node] ?? r.phase;
      this.current = r;
    } else if (msg.type === "progress") {
      const node = String(d.node ?? "");
      // tiled VAE decodes and upscale models report their tiles as progress too: they are not steps of the
      // bar (counting them after the first sampler pins it at 0.99 and collapses the time left), but they do
      // say which phase the render is on. Only a node whose phase is unknown is taken for a sampler on trust
      const phase = r.phases[node];
      const samples = phase === undefined || SAMPLER_PHASES.includes(phase) || Boolean(r.passes?.some((p) => p.node === node));
      if (!samples) {
        r.executing = node;
        if (phase) r.phase = phase;
        this.current = r;
        r.clock.phase = Monitor.phaseOf(r);
        this.onChange(r.promptId);
        return;
      }
      this.catchUp(r, node);
      const value = Number(d.value ?? 0);
      // the first step heard after a pick-up: the count goes on from the saved one (the pace is timed from here, over
      // the steps seen from here), unless which pass runs already says more
      if (r.resumed && !r.node) r.done = Math.max(r.done, r.resumed - value);
      // a new node reporting steps means the previous sampler is finished
      if (r.node && node !== r.node && r.max > 0 && r.value >= r.max) r.done += r.max;
      // the same node counting from the start again: a node that samples piece by piece (H3's latent re-sample,
      // tile after tile; a face detailer, face after face) finished one piece, and its steps stay counted
      else if (node === r.node && r.max > 0 && value < r.value) r.done += r.max;
      if (node !== r.node) r.value = 0;
      r.node = node;
      r.value = value;
      r.max = Number(d.max ?? 0);
      const at = this.now();
      if (!r.samplingAt) {
        r.samplingAt = at;
        r.stepsAtStart = r.done + r.value;
      }
      if (r.phases[node]) r.phase = r.phases[node];
      if (!r.firstPass) r.firstPass = { node, phase: r.phase, firstAt: at, firstValue: r.value, lastAt: at, lastValue: r.value };
      else if (r.firstPass.node === node && r.value > r.firstPass.lastValue) Object.assign(r.firstPass, { lastAt: at, lastValue: r.value });
      this.current = r;
    } else return;
    r.clock.phase = Monitor.phaseOf(r);
    this.onChange(r.promptId);
  }

  /** The highest the GPU's memory and heat got while a prompt was running. */
  peaks(load: SystemLoad): void {
    const r = this.current;
    const gpu = load.gpus[0];
    if (!r || !gpu) return;
    if (gpu.vramTotal > 0) r.vramPeak = Math.max(r.vramPeak ?? 0, gpu.vramPercent);
    if (gpu.temperature !== undefined) r.heatPeak = Math.max(r.heatPeak ?? 0, gpu.temperature);
  }
}
