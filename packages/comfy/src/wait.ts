import { ComfyUnreachable, type ComfyClient, type HistoryEntry } from "./client";

/** ComfyUI stopped answering for too long, or forgot the prompt (it restarted): the job can be tried again. */
export class ComfyLost extends Error {}
/** The prompt was stopped, by Afflatus or from ComfyUI's own interface. */
export class ComfyCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}
/** The graph ran and ComfyUI reported an error. */
export class ComfyFailed extends Error {}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Counted only while the prompt runs: time spent waiting behind other work doesn't count. */
  timeoutMs: number;
  pollMs?: number;
  /** How long ComfyUI may be unreachable mid-job before the job counts as lost. */
  offlineMs?: number;
  /** While there is no history yet, look in ComfyUI's queue every this many polls. */
  queueCheckEvery?: number;
}

/** Wait for a submitted prompt to finish and return its outputs, by output node id. */
export async function waitForOutputs(
  client: ComfyClient, promptId: string, opts: WaitOptions,
): Promise<NonNullable<HistoryEntry["outputs"]>> {
  const pollMs = opts.pollMs ?? 750;
  const offlineMs = opts.offlineMs ?? 90_000;
  const every = opts.queueCheckEvery ?? 8;
  let deadline = Date.now() + opts.timeoutMs;
  let unreachableSince: number | null = null;
  let absentChecks = 0;
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
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
      const error = entry.status.messages?.find((m) => m[0] === "execution_error")?.[1];
      throw new ComfyFailed(String(error?.exception_message ?? "ComfyUI reported an error").trim().slice(0, 600));
    }
    if (entry.status?.completed) return entry.outputs ?? {};
  }
}
