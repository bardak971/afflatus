import { BOOT_PORT, podUrl, type Pod } from "./runpod";

/**
 * A deployed pod's boot as its card, the pill and its log tab say it. First from what RunPod says of the pod: running with
 * no uptime yet, its image is still being pulled onto the host (ten minutes on a host new to it, seconds on one that has it);
 * up, ComfyUI is starting. Then, on the Afflatus image, from its boot log (deploy/runpod/bootlog.py), read through RunPod's
 * proxy on BOOT_PORT with the pod's token: the step its start is at, and why it stopped when it did. RunPod's own ComfyUI
 * image has no boot log, nor the Afflatus image before 0.1.12: nothing answers there, and only RunPod's data is said.
 */

/** A line of the boot log: when (the pod's clock, ISO), and what. */
export interface BootLine {
  t: string;
  m: string;
}

/** What a pod's boot log said at its last read. */
export interface BootLog {
  lines: BootLine[];
  /** The step its start is at (start.sh's `step`, then ComfyUI's own course); null before the first. */
  step: string | null;
  /** Why its start stopped, when it did (start.sh's `failed`, broken.py's GPU): its last step, said by the pod. */
  failed: string | null;
}

/** Where a booting pod is: its image pulled, ComfyUI starting, or a step its boot log says; with when its deploy began (ms). */
export interface BootView {
  phase: "pulling" | "starting" | "step";
  step: string | null;
  failed: boolean;
  from: number;
}

const ROUTE = "/afflatus/boot";
/** What is kept of a log at most: the pod serves its last 300 lines; one line longer than this is cut. */
const MAX_LINES = 300;
const MAX_LINE = 2000;
const STEP = /^\[afflatus-pod\] step: (.+)$/;
const FAILED = /^\[afflatus-pod\] failed: (.+)$/;
/**
 * ComfyUI's own course once start.sh started it, from the lines it prints on the way: its devices read (then its nodes and
 * the custom nodes load, the longest part on a volume full of packs), the custom nodes loaded (then its server starts).
 */
const COMFY_STEPS: Array<[RegExp, string]> = [
  [/^Total VRAM /, "loading custom nodes"],
  [/^Import times for custom nodes/, "starting ComfyUI server"],
];

/** A boot log's step and failure, from its lines: the last step said, ComfyUI's own course after "starting ComfyUI". */
export function bootStep(lines: readonly BootLine[]): { step: string | null; failed: string | null } {
  let step: string | null = null;
  let failed: string | null = null;
  let comfy = false;
  for (const { m } of lines) {
    const said = STEP.exec(m);
    if (said) {
      step = said[1]!.trim();
      // a start again (a container RunPod started anew) begins a new course: what failed before is not this one
      failed = null;
      comfy = step === "starting ComfyUI";
      continue;
    }
    const why = FAILED.exec(m);
    if (why) {
      failed = why[1]!.trim();
      continue;
    }
    if (comfy) for (const [mark, words] of COMFY_STEPS) if (mark.test(m)) step = words;
  }
  return { step, failed };
}

/** What a boot log says of its node packs: when that step began and the next one, and the Python packages installed per pack. */
export interface BootPacks {
  /** ISO, the pod's clock; `to` null while the step after has not come yet. */
  from: string;
  to: string | null;
  installs: Array<{ pack: string; ms: number }>;
}

const PACKS_STEP = "putting in the node packs";
// the pack's name without the count the start puts after it ("ComfyUI-KJNodes (1/2)")
const INSTALL_STEP = /^installing the Python packages of (.+?)(?: \(\d+\/\d+\))?$/;

/**
 * Its node packs' time, from the boot log's steps: from "putting in the node packs" to the first step after the installs of
 * their Python packages, each install as long as up to the step after it. A start again (its first step said anew) begins a
 * new course, as bootStep has it. Null before that step was said.
 */
export function bootPacks(lines: readonly BootLine[]): BootPacks | null {
  let out: BootPacks | null = null;
  let installing: { pack: string; at: number } | null = null;
  for (const { t, m } of lines) {
    const said = STEP.exec(m);
    if (!said) continue;
    const step = said[1]!.trim();
    const at = Date.parse(t);
    if (step === "checking the GPU") {
      out = null;
      installing = null;
      continue;
    }
    if (step === PACKS_STEP) {
      out = { from: t, to: null, installs: [] };
      installing = null;
      continue;
    }
    if (!out || out.to !== null) continue;
    if (installing && Number.isFinite(at)) out.installs.push({ pack: installing.pack, ms: Math.max(0, at - installing.at) });
    installing = null;
    const pack = INSTALL_STEP.exec(step);
    if (pack && Number.isFinite(at)) installing = { pack: pack[1]!.trim(), at };
    else out.to = t;
  }
  return out;
}

/** The pod's answer read: its lines (bounded, as the pod bounds them), its step. Null when it is not the boot log's shape. */
export function parseBootLog(body: unknown): BootLog | null {
  const raw = (body as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(raw)) return null;
  const lines = raw
    .filter((l): l is { t: unknown; m: unknown } => Boolean(l) && typeof l === "object")
    .filter((l) => typeof l.t === "string" && typeof l.m === "string")
    .slice(-MAX_LINES)
    .map((l) => ({ t: (l.t as string).slice(0, 40), m: (l.m as string).slice(-MAX_LINE) }));
  return { lines, ...bootStep(lines) };
}

/**
 * Where a booting pod is, one rule for every screen: its boot log's step when it has one (its failure first), else RunPod's
 * word: no uptime yet, its image is being pulled (the container is not there); up, ComfyUI is starting.
 */
export function bootOf(pod: Pick<Pod, "uptime"> | null, log: BootLog | null, from: number): BootView {
  if (log?.failed) return { phase: "step", step: log.failed, failed: true, from };
  if (log?.step) return { phase: "step", step: log.step, failed: false, from };
  return { phase: pod?.uptime !== null && pod?.uptime !== undefined ? "starting" : "pulling", step: null, failed: false, from };
}

/**
 * The boot logs of the pods, read through RunPod's proxy and kept: a read that fails (no server there, the pod gone) keeps
 * what was read before, so that a start that broke still shows its last lines. Never an error said for a pod that has no
 * boot log.
 */
export class BootLogs {
  private readonly kept = new Map<string, { log: BootLog | null; at: number; reading: Promise<BootLog | null> | null }>();
  fetcher: typeof fetch = fetch;
  now: () => number = Date.now;

  /** The log last read of a machine's pod; null before any was. */
  get(machine: string): BootLog | null {
    return this.kept.get(machine)?.log ?? null;
  }

  /**
   * The pod's boot log read again, at most every `everyMs` (one read at a time): the log as it stands after. Its token is the
   * machine's, the one the pod was given for its lock (LOCK_ENV).
   */
  async read(machine: string, pod: string, token: string, everyMs: number): Promise<BootLog | null> {
    const k = this.kept.get(machine) ?? { log: null, at: 0, reading: null };
    this.kept.set(machine, k);
    if (k.reading) return k.reading;
    if (this.now() - k.at < everyMs) return k.log;
    k.at = this.now();
    k.reading = this.fetchLog(pod, token)
      .then((log) => {
        // a log that came back empty after one had lines (a container started anew, its /tmp emptied) is taken as it is
        if (log) k.log = log;
        return k.log;
      })
      .finally(() => {
        k.reading = null;
      });
    return k.reading;
  }

  forget(machine: string): void {
    this.kept.delete(machine);
  }

  private async fetchLog(pod: string, token: string): Promise<BootLog | null> {
    if (!token) return null;
    try {
      const res = await this.fetcher(`${podUrl(pod, BOOT_PORT)}${ROUTE}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return parseBootLog(await res.json().catch(() => null));
    } catch {
      return null;
    }
  }
}
