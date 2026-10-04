import type { Phase } from "@afflatus/core";
import type { ComfyClient } from "./client";
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
  preview: Preview;
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
 * Listens to one ComfyUI's websocket and keeps the progress and the latest live preview of the prompts
 * it was told to track. Best effort by design: a render completes through /history whether or not
 * this socket is up, so every failure here is swallowed.
 */
export class Monitor {
  private ws: WebSocket | null = null;
  private readonly tracked = new Map<string, Tracked>();
  /** Sockets opened under another client id, to follow a prompt queued before this process started. */
  private readonly borrowed = new Map<string, WebSocket>();
  /** The prompt ComfyUI is executing. Previews carry no prompt id: they belong to this one. */
  private current: Tracked | null = null;
  /** Called whenever a tracked prompt's progress or preview changed. */
  onChange: (promptId: string) => void = () => {};
  /** The latest load snapshot a monitor extension broadcast (about one a second), if one is installed. */
  system: SystemLoad | null = null;
  onSystem: (load: SystemLoad) => void = () => {};

  constructor(private readonly client: ComfyClient) {}

  /** Open the socket if it isn't. Call before submitting, so the first messages aren't missed. */
  ensure(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    try {
      const ws = new WebSocket(`${this.client.baseUrl.replace(/^http/i, "ws")}/ws?clientId=${this.client.clientId}`);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
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
    for (const promptId of [...this.borrowed.keys()]) this.release(promptId);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  track(t: Tracking): void {
    if (this.tracked.has(t.promptId)) return;
    this.tracked.set(t.promptId, {
      ...t, totalSteps: Math.max(1, t.totalSteps), done: 0, node: null, value: 0, max: 0, phase: "waiting",
      executing: null, samplingAt: null, stepsAtStart: 0, preview: { seq: 0 },
      clock: { phase: "waiting", at: Date.now() }, spent: {}, firstPass: null, vramPeak: null, heatPeak: null,
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
      const ws = new WebSocket(`${this.client.baseUrl.replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`);
      ws.binaryType = "arraybuffer";
      // what arrives here without a prompt id (the "you are on this node" greeting, previews) is about that prompt
      ws.onmessage = (ev) => this.onMessage(ev.data, promptId);
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.borrowed.get(promptId) === ws) this.borrowed.delete(promptId);
      };
      this.borrowed.set(promptId, ws);
    } catch {
      /* progress is best effort: the result still arrives through the history */
    }
  }

  private release(promptId: string): void {
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
  private static tick(r: Tracked): void {
    const at = Date.now();
    r.spent[r.clock.phase] = (r.spent[r.clock.phase] ?? 0) + (at - r.clock.at);
    r.clock.at = at;
  }

  progress(promptId: string): Progress {
    const r = this.tracked.get(promptId);
    if (!r) return { progress: 0, eta: 0, phase: "waiting", step: 0, steps: 0 };
    const steps = r.done + r.value;
    // the time left comes from the sampling rate alone: a cold model load would inflate it wildly
    let eta = 0;
    if (r.samplingAt && steps > r.stepsAtStart) {
      const perStep = (Date.now() - r.samplingAt) / 1000 / (steps - r.stepsAtStart);
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
    Monitor.tick(r);
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
    Monitor.tick(r);
    if (msg.type === "kj_preview_override") {
      if (typeof d.image !== "string" || !d.image) return;
      // before its first step, each sampling pass sends what it starts from: noise, and on a pass that is
      // handed a latent (Wan's low-noise model) a flat gray. Neither is the clip: what the last step showed stays
      if (d.step === 0) return;
      r.preview = {
        seq: r.preview.seq + 1,
        bytes: new Uint8Array(Buffer.from(d.image, "base64")),
        mime: typeof d.mime === "string" && d.mime ? d.mime : "image/jpeg",
      };
    } else if (msg.type === "execution_start") {
      r.phase = "loading";
      this.current = r;
    } else if (msg.type === "executing" && typeof d.node === "string") {
      this.catchUp(r, d.node);
      r.executing = d.node;
      r.phase = r.phases[d.node] ?? r.phase;
      this.current = r;
    } else if (msg.type === "progress") {
      const node = String(d.node ?? "");
      this.catchUp(r, node);
      // a new node reporting steps means the previous sampler is finished
      if (r.node && node !== r.node && r.max > 0 && r.value >= r.max) r.done += r.max;
      if (node !== r.node) r.value = 0;
      r.node = node;
      r.value = Number(d.value ?? 0);
      r.max = Number(d.max ?? 0);
      if (!r.samplingAt) {
        r.samplingAt = Date.now();
        r.stepsAtStart = r.done + r.value;
      }
      if (r.phases[node]) r.phase = r.phases[node];
      if (!r.firstPass) r.firstPass = { node, phase: r.phase, firstAt: Date.now(), firstValue: r.value, lastAt: Date.now(), lastValue: r.value };
      else if (r.firstPass.node === node && r.value > r.firstPass.lastValue) Object.assign(r.firstPass, { lastAt: Date.now(), lastValue: r.value });
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
