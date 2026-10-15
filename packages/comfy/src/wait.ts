import { ComfyUnreachable, type ComfyClient, type HistoryEntry } from "./client";

/** ComfyUI stopped answering for too long, or forgot the prompt (it restarted): the job can be tried again. */
export class ComfyLost extends Error {}
/** The prompt was stopped, by Afflatus or from ComfyUI's own interface. */
export class ComfyCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}
/** Where a graph that ran failed, as ComfyUI's execution_error says it: the node, the exception's class and the end of its traceback. */
export interface ComfyFailure {
  nodeId: string | null;
  nodeType: string | null;
  exceptionType: string | null;
  /** The last lines of the Python traceback, the most telling ones; empty when ComfyUI sent none. */
  traceback: string;
}

/** The graph ran and ComfyUI reported an error. `failure`: where, when ComfyUI said it (its log rolls over, and the cause with it). */
export class ComfyFailed extends Error {
  constructor(message: string, readonly failure: ComfyFailure | null = null) {
    super(message);
  }
}

/** How many characters of a traceback's end are kept: the frames nearest the error, where the cause is read. */
const TRACEBACK_TAIL = 4000;

/**
 * ComfyUI's execution_error as one message, `${node_type} #${node_id}: ${exception_type}: ${message}` ("KSampler #3:
 * torch.OutOfMemoryError: Allocation on device"), with its parts and its traceback's tail kept apart for the job's record.
 */
export function failureOf(error: Record<string, unknown> | undefined): ComfyFailed {
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  const message = text(error?.exception_message) || "ComfyUI reported an error";
  const nodeType = text(error?.node_type) || null;
  const nodeId = text(error?.node_id) || null;
  const exceptionType = text(error?.exception_type) || null;
  const lines = Array.isArray(error?.traceback) ? (error.traceback as unknown[]).map(String) : typeof error?.traceback === "string" ? [error.traceback] : [];
  const traceback = lines.join("").trimEnd().slice(-TRACEBACK_TAIL);
  const node = nodeType || nodeId ? `${nodeType ?? "node"}${nodeId ? ` #${nodeId}` : ""}: ` : "";
  const full = `${node}${exceptionType ? `${exceptionType}: ` : ""}${message}`;
  return new ComfyFailed(full.slice(0, 600), nodeId || nodeType || exceptionType || traceback ? { nodeId, nodeType, exceptionType, traceback } : null);
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Counted only while the prompt runs: time spent waiting behind other work doesn't count. */
  timeoutMs: number;
  /** How often the history is asked for: every 750 ms, or every 5 s when `ended` tells the end. */
  pollMs?: number;
  /** How long ComfyUI may be unreachable mid-job before the job counts as lost. */
  offlineMs?: number;
  /** While there is no history yet, look in ComfyUI's queue every this many polls (8, or 2 with `ended`). */
  queueCheckEvery?: number;
  /**
   * Resolves when ComfyUI's websocket says the prompt is over (Monitor.ended): its history is then read at once. The
   * history asked for every 750 ms was 68 requests a minute per running render, though the socket says when it ends.
   */
  ended?: Promise<unknown>;
}

/** How often the history is asked for when the socket tells the end: in case it never does (dropped, an old ComfyUI). */
const FALLBACK_POLL_MS = 5_000;
/** Once the end is heard, the history is read at once, then again soon after this, twice as long each time: the end is told just before it is written. */
const AFTER_END_MS = 50;

/** Wait for a submitted prompt to finish and return its outputs, by output node id. */
export async function waitForOutputs(
  client: ComfyClient, promptId: string, opts: WaitOptions,
): Promise<NonNullable<HistoryEntry["outputs"]>> {
  const pollMs = opts.pollMs ?? (opts.ended ? FALLBACK_POLL_MS : 750);
  const offlineMs = opts.offlineMs ?? 90_000;
  const every = opts.queueCheckEvery ?? (opts.ended ? 2 : 8);
  let deadline = Date.now() + opts.timeoutMs;
  let unreachableSince: number | null = null;
  let absentChecks = 0;
  let heard = false;
  // a promise that fails says nothing of the end: it is then as one never told
  const ended = opts.ended?.then(() => { heard = true; }, () => new Promise<void>(() => {}));
  /** Once the end is heard, how long until the history is read again: it was read at once, and it may not be written yet. */
  let after = AFTER_END_MS;
  // a stop is heard at once too, not at the next look at the history
  const stopped = opts.signal && new Promise<void>((r) => (opts.signal!.aborted ? r() : opts.signal!.addEventListener("abort", () => r(), { once: true })));
  for (let i = 0; ; i++) {
    if (!heard) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([new Promise((r) => (timer = setTimeout(r, pollMs))), ...(ended ? [ended] : []), ...(stopped ? [stopped] : [])]);
      clearTimeout(timer);
    } else {
      await new Promise((r) => setTimeout(r, after));
      after = Math.min(pollMs, after * 2);
    }
    if (opts.signal?.aborted) throw new ComfyCancelled();
    if (Date.now() > deadline) throw new ComfyFailed("the render took too long and was given up");
    let entry: HistoryEntry | undefined;
    try {
      entry = await client.history(promptId);
      if (!entry && i % every === 0) {
        // no history yet: is it still in ComfyUI's queue? A prompt that is nowhere twice in a row is gone.
        const where = await client.queuePosition(promptId);
        if (where === "pending") deadline = Date.now() + opts.timeoutMs;
        absentChecks = where === "absent" ? absentChecks + 1 : 0;
        if (absentChecks >= 2 && !(await client.history(promptId))) throw new ComfyLost("ComfyUI lost the job (did it restart?)");
      }
      unreachableSince = null;
    } catch (err) {
      if (!(err instanceof ComfyUnreachable)) throw err;
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince > offlineMs) throw new ComfyLost("ComfyUI went offline during the render");
      continue;
    }
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      if (entry.status.messages?.some((m) => m[0] === "execution_interrupted")) throw new ComfyCancelled();
      throw failureOf(entry.status.messages?.find((m) => m[0] === "execution_error")?.[1]);
    }
    if (entry.status?.completed) return entry.outputs ?? {};
  }
}
