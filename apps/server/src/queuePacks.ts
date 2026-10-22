import { nodesOfPack, packOfNode } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { loadedOn } from "./jobFiles";
import { cannotWhy, installsUnasked, packFacts, packsLacked, packsSaid, type PackFacts, type PacksSaid, type PackWait } from "./jobPacks";
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
  /** Whether Afflatus downloads a file through this ComfyUI now (its node pack or its Manager, in ComfyUI's process). */
  downloading?(comfy: Comfy): boolean;
  /** Something changed that the Queue shows, or that lets a job start: a new pass. */
  changed(): void;
}

/** How often the installs and a restart under way are looked at. */
const TICK_MS = 2000;
/** A pack whose install failed is done without for this long, then tried again when a job asks for it (Manager's settings may have changed). */
const AGAIN_MS = 30 * 60_000;

/**
 * The packs a job asks for there that it waits for: all of them when the machine installs unasked (Always) or its row said
 * Install for each; else, under Ask, only those its row said Install for, or that are being installed already for another
 * job (it waits for those anyway). One being installed for another job is no Install for the job's other packs.
 */
export function packsToWant(names: string[], o: { unasked: boolean; said: PacksSaid; underWay: ReadonlySet<string> }): string[] {
  return o.unasked ? names : names.filter((n) => o.said.install?.includes(n) || o.underWay.has(n));
}

export class OwnPacks {
  readonly packs: PodPacks;
  /** The jobs waiting for packs, as their Queue rows show them, by job id. */
  private readonly waits = new Map<string, PackWait>();
  /** The jobs that wait, each with the packs it said Run without for (keepOnly); null until the first pass. */
  private waiting: Map<string, string[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly d: OwnPacksDeps) {
    this.packs = new PodPacks({
      comfyOf: async (machine) => d.lane(machine)?.comfy ?? null,
      // ComfyUI is never restarted under a render, Afflatus's or anyone's, nor under a download of Afflatus's that runs in
      // ComfyUI's process (it would die with it): the restart waits for it to end
      busy: (machine) => this.busyWith(d.lane(machine)) !== null,
      // nor for a pack no job wants any more: its jobs were cancelled, or said Run without
      stillWanted: (job, pack) => !this.waiting || (this.waiting.has(job) && !this.waiting.get(job)!.includes(pack)),
    });
    this.packs.againMs = AGAIN_MS;
    // Manager's list of packs has long been loaded on a ComfyUI of the user's own: a pack it cannot find is not there
    this.packs.resolveTries = 1;
  }

  /** What a machine is busy with, that its ComfyUI is not restarted under; null when it is free. */
  private busyWith(lane: Lane | undefined): string | null {
    if (!lane) return "nothing known of it";
    if (lane.running || lane.starting) return "a render";
    if (outsideBusy(lane)) return "work from outside Afflatus";
    if (lane.comfy && this.d.downloading?.(lane.comfy)) return "a download through its ComfyUI";
    return null;
  }

  /**
   * What can come to a machine: its card, its Manager, the packs that failed there. A failed one is so for AGAIN_MS only:
   * then a job asking for it has it tried again (Manager's settings may have changed).
   */
  async facts(lane: Lane): Promise<PackFacts> {
    const failed = new Map(this.packs.failing(lane.id).map((e) => [e.name, e.error ?? "its install failed"]));
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
    const loaded = await loadedOn(lane.core, row, { id: lane.id, comfy: lane.comfy, scan, own: true }, { facts, said }).catch(() => null);
    const { soft, hard, unknown } = packsLacked(loaded);
    if (!soft.length && !hard.length) return this.goes(row.id);
    if (unknown.length || hard.some((p) => cannotWhy(facts, p))) return this.goes(row.id);
    const names = [...soft.map((s) => s.pack), ...hard];
    // a pack loaded here once that the node list has none of now (read after it was found loaded, so after that restart)
    // is gone, and asked for again: kept as loaded, the job waited for good under "installed"
    const loadedOnce = names.filter((n) => this.packs.view(lane.id).some((e) => e.name === n && e.state === "ready"));
    const catalog = loadedOnce.length ? await lane.comfy.catalog().catch(() => null) : null;
    if (catalog) this.packs.unready(lane.id, loadedOnce.filter((n) => !nodesOfPack(n).some((node) => node in catalog)));
    // asked for already (Always, its row's Install, or another job's on this machine): it waits for them. Under Ask, each
    // pack on its own: another job's install brings that one, never the job's others unasked
    const underWay = new Set(this.packs.view(lane.id).filter((e) => e.state !== "failed").map((e) => e.name));
    const go = packsToWant(names, { unasked: installsUnasked(lane.machine!), said, underWay });
    const asked = go.length === names.length;
    // with the node types it lacks of each: the restart counts a pack loaded once ComfyUI lists them, not by its first node
    const lacks: Record<string, string[]> = {};
    for (const node of loaded?.missingNodes ?? []) {
      const pack = packOfNode(node)?.name;
      if (pack && go.includes(pack)) (lacks[pack] ??= []).push(node);
    }
    if (go.length && this.packs.want(lane.id, go, row.id, lacks)) this.tick();
    const view = this.packs.view(lane.id).filter((e) => names.includes(e.name));
    const failed = view.find((e) => e.state === "failed");
    const state: PackWait["state"] = !asked ? "ask" : this.packs.restartingNow(lane.id) ? "restarting" : failed ? "failed" : view.some((e) => e.state === "installing") ? "installing" : view.length && view.every((e) => e.state === "installed" || e.state === "ready") ? "installed" : "next";
    const busy = state === "installed" ? (this.busyWith(lane) ?? undefined) : undefined;
    this.waits.set(row.id, {
      machine: lane.id, state,
      packs: names.map((name) => ({ name, ...(soft.find((s) => s.pack === name) ? { without: soft.find((s) => s.pack === name)!.without } : {}) })),
      ...(failed?.error ? { error: failed.error } : {}), ...(failed?.unloaded ? { unloaded: true as const } : {}), ...(busy ? { waitsFor: busy } : {}),
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

  /**
   * The jobs that wait (`queued`): what the others waited for is dropped, unless being installed, and their rows forgotten;
   * so is a pack every job that wanted it said Run without for, which frees a machine held for its restart.
   */
  keepOnly(queued: ReadonlyArray<Pick<JobRow, "id" | "packs">>): void {
    this.waiting = new Map(queued.map((r) => [r.id, packsSaid(r).without ?? []]));
    for (const job of [...this.waits.keys()]) if (!this.waiting.has(job)) this.waits.delete(job);
    for (const machine of this.packs.machines()) this.packs.drop(machine, (job, pack) => this.waiting!.has(job) && !this.waiting!.get(job)!.includes(pack));
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
      // a machine taken out of the settings meanwhile: what it waited for goes with it, or a pack it held for its restart
      // would keep this timer going for good
      if (!this.d.lane(machine)) {
        this.packs.forget(machine);
        continue;
      }
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
