import { ComfyClient, Monitor, scan, systemLoadFromStatus, type Scan, type SystemLoad } from "@afflatus/comfy";
import type { NodeCatalog } from "@afflatus/core";
import type { Registry } from "./registry";

const SCAN_TTL_MS = 60_000;
const CATALOG_TTL_MS = 10 * 60_000;

/**
 * The one ComfyUI Afflatus talks to: its client, its websocket monitor, and what was last learned
 * about it. Rebuilt when the address in the settings changes.
 */
export class Comfy {
  readonly client: ComfyClient;
  readonly monitor: Monitor;
  private lastScan: { at: number; value: Promise<Scan> } | null = null;
  private lastCatalog: { at: number; value: Promise<NodeCatalog> } | null = null;

  constructor(readonly url: string, private readonly registry: Registry) {
    this.client = new ComfyClient(url);
    this.monitor = new Monitor(this.client);
  }

  /** What this ComfyUI can do. The node catalog is large, so the answer is kept for a while. */
  async scan(fresh = false): Promise<Scan> {
    // asked to look again ("Test" in Settings): the node list is read again too, it is what says which files there are
    if (fresh) this.lastCatalog = null;
    if (fresh || !this.lastScan || Date.now() - this.lastScan.at > SCAN_TTL_MS) {
      this.lastScan = { at: Date.now(), value: scan(this.client, this.registry.families(), this.registry.recipes()) };
    }
    const result = await this.lastScan.value;
    // an unreachable ComfyUI is asked again next time, not remembered
    if (!result.comfy.online) this.lastScan = null;
    return result;
  }

  /** The list of recipes changed: what was worked out no longer covers it. */
  forgetScan(): void {
    this.lastScan = null;
  }

  /** This ComfyUI has a file it did not have: nothing learned about it holds any more. */
  forgetAll(): void {
    this.lastScan = null;
    this.lastCatalog = null;
  }

  async catalog(): Promise<NodeCatalog> {
    if (!this.lastCatalog || Date.now() - this.lastCatalog.at > CATALOG_TTL_MS) {
      const value = this.client.catalog();
      this.lastCatalog = { at: Date.now(), value };
      value.catch(() => (this.lastCatalog = null));
    }
    return this.lastCatalog.value;
  }

  /** The machine's load: the monitor extension's latest broadcast if it is fresh, else ComfyUI's memory numbers. */
  async load(): Promise<SystemLoad | null> {
    this.monitor.ensure();
    const live = this.monitor.system;
    if (live && Date.now() - live.at < 5_000) return live;
    try {
      return systemLoadFromStatus(await this.client.status());
    } catch {
      return null;
    }
  }

  close(): void {
    this.monitor.close();
  }
}
