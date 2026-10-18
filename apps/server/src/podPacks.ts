import { nodesOfPack } from "@afflatus/core";
import type { Comfy } from "./comfy";

/**
 * The node packs a rented pod gets for its jobs, beside its model files (podFiles.ts): the packs most video forms use are in
 * the pod image already; another one a waiting job needs (Impact, GGUF, controlnet_aux…) is installed through the pod's
 * ComfyUI-Manager (the image sets it to install for a pod locked to Afflatus), by its name in Manager's list, then ComfyUI
 * is restarted through Manager to load it, once nothing renders there. A pack Manager does not install stays failed for
 * that pod: its jobs go elsewhere.
 */

export type PodPackState = "next" | "installing" | "installed" | "ready" | "failed";

export interface PodPackView {
  name: string;
  state: PodPackState;
  error?: string;
  /** The waiting jobs that wait for it. */
  jobs: string[];
}

interface Entry extends PodPackView {
  task?: string;
  /** Asked again after Manager could not find it yet (its list of packs still loading on a pod just up): how many times, and not before when. */
  tries?: number;
  notBefore?: number;
  /** When its install was asked for (ms): one Manager never says anything of is failed after INSTALL_MS. */
  askedAt?: number;
}

export interface PodPacksDeps {
  comfyOf(machine: string): Promise<Comfy | null>;
  /** Whether a job runs on the machine now: ComfyUI is not restarted under a render. */
  busy(machine: string): boolean;
  /** ComfyUI is about to restart: what the pod was getting (in its process) is put back in line (podFiles.ts). */
  beforeRestart?(machine: string): void;
}

/** Manager keeps a history per client: Afflatus's own (packs.ts). */
const CLIENT = "afflatus";
/** How long a restart may take to answer again before the packs are said failed. */
const RESTART_MS = 5 * 60_000;
/** Manager's list of packs loads in the background on a pod just up (2 to 3 min on the real test): a pack it cannot find yet is asked again this often, so many times (5 min). */
const RETRY_MS = 20_000;
const TRIES = 15;
/** How long an install may go without Manager saying anything of it before it is failed (a pack's own install takes minutes at most). */
const INSTALL_MS = 15 * 60_000;
/** What installing and a restart are planned to take, before a pack is there (queue.ts's plan). */
export const PACKS_MS = 4 * 60_000;

export class PodPacks {
  private readonly pods = new Map<string, Map<string, Entry>>();
  /** A restart asked for, by machine: since when. */
  private readonly restarting = new Map<string, number>();
  private seq = 0;
  /** How long a pack Manager cannot find yet waits before it is asked again (shorter in tests). */
  retryMs = RETRY_MS;

  constructor(private readonly d: PodPacksDeps) {}

  want(machine: string, names: string[], job?: string): boolean {
    let pod = this.pods.get(machine);
    if (!pod) this.pods.set(machine, (pod = new Map()));
    let changed = false;
    for (const name of names) {
      let e = pod.get(name);
      if (!e) {
        pod.set(name, (e = { name, state: "next", jobs: [] }));
        changed = true;
      }
      if (job && !e.jobs.includes(job)) {
        e.jobs.push(job);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Packs asked for jobs none of which may run on the pod any more, not being installed yet (or installed and waiting for the
   * restart): dropped, so that its ComfyUI is not restarted for them. One Manager is installing is left to finish.
   */
  drop(machine: string, mayRun: (job: string) => boolean): boolean {
    const pod = this.pods.get(machine);
    if (!pod) return false;
    let changed = false;
    for (const [name, e] of pod) {
      if (!e.jobs.length || e.jobs.some(mayRun) || (e.state !== "next" && e.state !== "installed")) continue;
      pod.delete(name);
      changed = true;
    }
    return changed;
  }

  /** Why these packs cannot come to that pod (Manager refused one); null when they can. */
  failed(machine: string, names: string[]): string | null {
    const e = names.map((n) => this.pods.get(machine)?.get(n)).find((x) => x?.state === "failed");
    return e ? `the node pack ${e.name}: ${e.error ?? "ComfyUI-Manager did not install it"}` : null;
  }

  /** Whether all these packs are loaded there. */
  ready(machine: string, names: string[]): boolean {
    return names.every((n) => this.pods.get(machine)?.get(n)?.state === "ready");
  }

  jobPacks(machine: string, job: string): Entry[] {
    return [...(this.pods.get(machine)?.values() ?? [])].filter((e) => e.jobs.includes(job));
  }

  view(machine: string): PodPackView[] {
    return [...(this.pods.get(machine)?.values() ?? [])].map(({ name, state, error, jobs }) => ({ name, state, ...(error ? { error } : {}), jobs: [...jobs] }));
  }

  forget(machine: string): void {
    this.pods.delete(machine);
    this.restarting.delete(machine);
  }

  machines(): string[] {
    return [...this.pods.keys()];
  }

  /** Its ComfyUI restarts now (asked to, not back yet). */
  restartingNow(machine: string): boolean {
    return this.restarting.has(machine);
  }

  /** No job may start on the machine: its packs wait for its ComfyUI to restart, or it restarts now. */
  holding(machine: string): boolean {
    return this.restarting.has(machine) || [...(this.pods.get(machine)?.values() ?? [])].some((e) => e.state === "installed");
  }

  /** One look at a pod's packs: follow a restart, follow Manager's installs, start what waits, restart once they are in. */
  async pass(machine: string): Promise<{ changed: boolean; loaded: boolean }> {
    const pod = this.pods.get(machine);
    if (!pod?.size) return { changed: false, loaded: false };
    const comfy = await this.d.comfyOf(machine);
    if (!comfy) return { changed: false, loaded: false };
    const all = [...pod.values()];
    if (this.restarting.has(machine)) return this.followRestart(machine, comfy, all);
    let changed = await this.followInstalls(comfy, all);
    changed = (await this.startInstalls(comfy, all)) || changed;
    changed = (await this.restartWhenIn(machine, comfy, all)) || changed;
    return { changed, loaded: false };
  }

  /** A restart under way: done once ComfyUI answers again with a node of each pack; failed when it does not come back. */
  private async followRestart(machine: string, comfy: Comfy, all: Entry[]): Promise<{ changed: boolean; loaded: boolean }> {
    const since = this.restarting.get(machine)!;
    const back = await comfy.client.status().then(() => true, () => false);
    if (back && Date.now() - since > 3000) {
      this.restarting.delete(machine);
      comfy.forgetAll();
      // loaded only when ComfyUI knows a node of the pack now: a restart that did not happen (or a pack that failed at its
      // import) leaves it failed, never "ready" with its nodes missing
      for (const e of all.filter((x) => x.state === "installed")) {
        const node = nodesOfPack(e.name)[0];
        const has = !node || (await comfy.client.raw(`/object_info/${encodeURIComponent(node)}`, { signal: AbortSignal.timeout(15_000) })
          .then(async (r) => (r.ok ? Boolean(((await r.json().catch(() => ({}))) as Record<string, unknown>)[node]) : false), () => false));
        Object.assign(e, has ? { state: "ready" } : { state: "failed", error: "ComfyUI did not load it after its restart (the pod's log says why)" });
      }
      return { changed: true, loaded: true };
    }
    if (Date.now() - since > RESTART_MS) {
      this.restarting.delete(machine);
      for (const e of all) if (e.state === "installed") Object.assign(e, { state: "failed", error: "ComfyUI did not come back after its restart" });
      return { changed: true, loaded: false };
    }
    return { changed: false, loaded: false };
  }

  /** Installs asked for: Manager's history says how each went; one that says nothing for too long failed (a ComfyUI restarted meanwhile forgets it). */
  private async followInstalls(comfy: Comfy, all: Entry[]): Promise<boolean> {
    const installing = all.filter((e) => e.state === "installing");
    if (!installing.length) return false;
    let changed = false;
    const res = await comfy.client.raw(`/v2/manager/queue/history?client_id=${CLIENT}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const history = res?.ok ? (((await res.json().catch(() => ({}))) as { history?: Record<string, { result?: string; status?: { status_str?: string } }> }).history ?? {}) : {};
    for (const e of installing) {
      const h = e.task ? history[e.task] : undefined;
      if (!h) {
        if (Date.now() - (e.askedAt ?? Date.now()) > INSTALL_MS) {
          Object.assign(e, { state: "failed", error: `ComfyUI-Manager did not say it was installed in ${INSTALL_MS / 60_000} min` });
          changed = true;
        }
        continue;
      }
      const ok = h.result === "success" || h.status?.status_str === "success";
      // not in Manager's list of packs yet: it is still loading it on a pod just up, asked again in a moment
      if (!ok && /Cannot resolve install target/.test(h.result ?? "") && (e.tries ?? 0) + 1 < TRIES) {
        Object.assign(e, { state: "next", tries: (e.tries ?? 0) + 1, notBefore: Date.now() + this.retryMs });
        delete e.task;
        changed = true;
        continue;
      }
      Object.assign(e, ok ? { state: "installed" } : { state: "failed", error: !h.result || h.result === "failed" ? "ComfyUI-Manager did not install it (its security level, or the pack's own install failed: the pod's log says)" : h.result.slice(0, 200) });
      changed = true;
    }
    return changed;
  }

  /** The next ones asked for, all at once: one restart loads them all. Manager's queue not started: that batch failed. */
  private async startInstalls(comfy: Comfy, all: Entry[]): Promise<boolean> {
    const next = all.filter((e) => e.state === "next" && (e.notBefore ?? 0) <= Date.now());
    if (!next.length || all.some((e) => e.state === "installing")) return false;
    const asked: Entry[] = [];
    for (const e of next) {
      const task = `afflatus-pack-${++this.seq}-${Date.now()}`;
      const res = await comfy.client.raw("/v2/manager/queue/task", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ ui_id: task, client_id: CLIENT, kind: "install", params: { id: e.name, version: "latest", selected_version: "latest", mode: "cache", channel: "default" } }),
      }).catch(() => null);
      if (!res) Object.assign(e, { state: "failed", error: "the pod's ComfyUI did not answer" });
      else if (res.status === 404) Object.assign(e, { state: "failed", error: "the pod has no ComfyUI-Manager" });
      else if (!res.ok) Object.assign(e, { state: "failed", error: `ComfyUI-Manager refused it (${res.status})` });
      else {
        Object.assign(e, { state: "installing", task, askedAt: Date.now() });
        asked.push(e);
      }
    }
    if (asked.length) {
      const started = await comfy.client.raw("/v2/manager/queue/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!started?.ok) for (const e of asked) Object.assign(e, { state: "failed", error: `ComfyUI-Manager did not start its installs (${started?.status ?? "no answer"})` });
    }
    return true;
  }

  /**
   * Every install done and some in: ComfyUI restarted to load them, never under a render. What the pod was getting is put
   * back in line first (its downloads live in ComfyUI's process, which the restart replaces). A refusal of the restart fails
   * the packs (they would never load).
   */
  private async restartWhenIn(machine: string, comfy: Comfy, all: Entry[]): Promise<boolean> {
    if (all.some((e) => e.state === "installing" || e.state === "next") || !all.some((e) => e.state === "installed") || this.d.busy(machine)) return false;
    this.d.beforeRestart?.(machine);
    this.restarting.set(machine, Date.now());
    // the process replaces itself as it answers: a dropped connection is the restart under way
    const res = await comfy.client.raw("/v2/manager/reboot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res && !res.ok) {
      this.restarting.delete(machine);
      for (const e of all) if (e.state === "installed") Object.assign(e, { state: "failed", error: `ComfyUI-Manager refused to restart ComfyUI (${res.status})` });
    }
    return true;
  }
}
