import type { Comfy } from "./comfy";
import { loadedOn } from "./jobFiles";
import { cannotWhy, installsUnasked, packFacts, packsLacked, packsSaid, type PackFacts, type PackWait } from "./jobPacks";
import { PodPacks } from "./podPacks";
import { outsideBusy } from "./queueOutside";
import type { JobRow, Lane } from "./queueModel";

/**
 * The node packs a render asks for on a ComfyUI of the user's own (jobPacks.ts): a job planned there whose packs the machine
 * lacks waits for them, and they are installed through its ComfyUI-Manager when its rule says Always, or once its Queue row
 * was told Install and restart (Ask). ComfyUI is then restarted, as a rented pod's is (podPacks.ts), only once nothing renders
 * there, from Afflatus or from outside (its own page, another tool). A pack that cannot come (no Manager, its install failed)
 * is done without: the job runs, and says so.
 */

export interface OwnPacksDeps {
  lane(id: string): Lane | undefined;
  /** Whether this ComfyUI has ComfyUI-Manager (downloads.ts manager); null when it cannot be told. */
  manager(comfy: Comfy): Promise<boolean | null>;
  /** Something changed that the Queue shows, or that lets a job start: a new pass. */
  changed(): void;
}

/** How often the installs and a restart under way are looked at. */
const TICK_MS = 2000;
/** A pack whose install failed is done without for this long, then tried again when a job asks for it (Manager's settings may have changed). */
const AGAIN_MS = 30 * 60_000;

export class OwnPacks {
  readonly packs: PodPacks;
  /** The jobs waiting for packs, as their Queue rows show them, by job id. */
  private readonly waits = new Map<string, PackWait>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly d: OwnPacksDeps) {
    this.packs = new PodPacks({
      comfyOf: async (machine) => d.lane(machine)?.comfy ?? null,
      // ComfyUI is never restarted under a render, Afflatus's or anyone's
      busy: (machine) => {
        const lane = d.lane(machine);
        return !lane || Boolean(lane.running || lane.starting) || outsideBusy(lane);
      },
    });
    this.packs.againMs = AGAIN_MS;
  }

  /** What can come to a machine: its card, its Manager, the packs that failed there. */
  async facts(lane: Lane): Promise<PackFacts> {
    const failed = new Map(this.packs.view(lane.id).filter((e) => e.state === "failed").map((e) => [e.name, e.error ?? "its install failed"]));
    const manager = lane.comfy ? await this.d.manager(lane.comfy).catch(() => null) : null;
    return packFacts(lane.device, manager, failed, lane.machine?.name || lane.id);
  }

  /**
   * Whether a job may start on a machine of the user's own now: it lacks no pack it asks for there, or none that can come
   * (one it cannot run without and that cannot come: it goes, and its submit says why). Else it waits, its packs asked
   * for when the machine installs unasked or its row said Install, and its row says where they stand.
   */
  async mayStart(lane: Lane, row: JobRow): Promise<boolean> {
    if (lane.machine?.rented || !lane.comfy) return true;
    const scan = await lane.comfy.scan().catch(() => null);
    if (!scan?.comfy.online) return true;
    const said = packsSaid(row);
    const facts = await this.facts(lane);
    const loaded = await loadedOn(lane.core, row, { id: lane.id, comfy: lane.comfy, scan }, { facts, said }).catch(() => null);
    const { soft, hard, unknown } = packsLacked(loaded);
    if (!soft.length && !hard.length) return this.goes(row.id);
    if (unknown.length || hard.some((p) => cannotWhy(facts, p))) return this.goes(row.id);
    const names = [...soft.map((s) => s.pack), ...hard];
    // asked for already (Always, its row's Install, or another job's on this machine): it waits for them
    const asked = installsUnasked(lane.machine!) || names.every((n) => said.install?.includes(n)) || this.packs.view(lane.id).some((e) => names.includes(e.name) && e.state !== "failed");
    if (asked && this.packs.want(lane.id, names, row.id)) this.tick();
    const view = this.packs.view(lane.id).filter((e) => names.includes(e.name));
    const failed = view.find((e) => e.state === "failed");
    const state: PackWait["state"] = !asked ? "ask" : this.packs.restartingNow(lane.id) ? "restarting" : failed ? "failed" : view.some((e) => e.state === "installing") ? "installing" : view.length && view.every((e) => e.state === "installed" || e.state === "ready") ? "installed" : "next";
    const busy = state === "installed" ? (outsideBusy(lane) ? "work from outside Afflatus" : lane.running ? "a render" : undefined) : undefined;
    this.waits.set(row.id, {
      machine: lane.id, state,
      packs: names.map((name) => ({ name, ...(soft.find((s) => s.pack === name) ? { without: soft.find((s) => s.pack === name)!.without } : {}) })),
      ...(failed?.error ? { error: failed.error } : {}), ...(busy ? { waitsFor: busy } : {}),
    });
    return false;
  }

  private goes(job: string): true {
    this.waits.delete(job);
    return true;
  }

  /** Where a waiting job's packs stand, for its Queue row; undefined when it waits for none. */
  waitOf(job: string): PackWait | undefined {
    return this.waits.get(job);
  }

  /** No job starts on the machine: its packs wait for ComfyUI to restart, or it restarts now. */
  holding(machine: string): boolean {
    return this.packs.holding(machine);
  }

  /** The jobs that are gone: what they waited for is dropped, unless being installed; their rows forgotten. */
  keepOnly(active: ReadonlySet<string>): void {
    for (const job of [...this.waits.keys()]) if (!active.has(job)) this.waits.delete(job);
    for (const machine of this.packs.machines()) this.packs.drop(machine, (job) => active.has(job));
  }

  /** The installs and restarts looked at every TICK_MS while any is under way. */
  private tick(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pass();
    }, TICK_MS);
  }

  private async pass(): Promise<void> {
    let changed = false;
    let busy = false;
    for (const machine of this.packs.machines()) {
      const r = await this.packs.pass(machine).catch(() => ({ changed: false, loaded: false }));
      if (r.changed || r.loaded) changed = true;
      if (this.packs.restartingNow(machine) || this.packs.view(machine).some((e) => e.state !== "ready" && e.state !== "failed")) busy = true;
    }
    if (changed) this.d.changed();
    if (busy) this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
