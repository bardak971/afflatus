import { ComfyClient, Monitor, scan, systemLoadFromStatus, type InfoLookup, type Scan, type SystemLoad } from "@afflatus/comfy";
import type { NodeCatalog } from "@afflatus/core";
import { fileName } from "./media";
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
    // the socket opening again means ComfyUI was restarted (or came back): its nodes and files may have
    // changed, a node pack just written among them, so nothing kept about it holds
    this.monitor.onOpen = (again) => {
      if (again) this.forgetAll();
    };
  }

  /** What this ComfyUI can do. The node catalog is large, so the answer is kept for a while. */
  /** The files chosen by hand for the families' slots (Settings), read when a scan is made. */
  overrides?: () => Promise<Record<string, Record<string, string>>>;
  /** What is known of each model file from its header, read when a scan is made. */
  infoOf?: () => Promise<InfoLookup>;

  async scan(fresh = false): Promise<Scan> {
    // asked to look again ("Test" in Settings): the node list is read again too, it is what says which files there are
    if (fresh) this.lastCatalog = null;
    if (fresh || !this.lastScan || Date.now() - this.lastScan.at > SCAN_TTL_MS) {
      this.lastScan = { at: Date.now(), value: (async () => scan(this.client, this.registry.families(), this.registry.recipes(), (await this.overrides?.()) ?? {}, (await this.infoOf?.()) ?? (() => undefined)))() };
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

  /** The node list is read again next time (a node pack was written, and ComfyUI may have loaded it). */
  forgetCatalog(): void {
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

/** ComfyUI's model folders and the files in each, with a lookup by file name. */
export interface ModelIndex {
  folders: string[];
  lists: Array<{ folder: string; files: string[] }>;
  /**
   * Every folder that holds a file of this name (its basename, case not minding), with the file as ComfyUI
   * lists it; `first` names the folder to look in first (the one the loader reads from).
   */
  find(name: string, first?: string): Array<{ folder: string; file: string }>;
}

/** The folders and the files per folder of a ComfyUI, read once for one request. A folder that does not answer counts as empty. */
export async function modelIndex(comfy: Comfy): Promise<ModelIndex> {
  const client = comfy.client;
  const folders = await client.folders().catch(() => [] as string[]);
  const lists = await Promise.all(folders.map(async (folder) => ({ folder, files: await client.models(folder).catch(() => [] as string[]) })));
  return {
    folders, lists,
    find(name, first) {
      const wanted = fileName(name);
      const ordered = first ? [...lists].sort((x, y) => Number(y.folder === first) - Number(x.folder === first)) : lists;
      return ordered.flatMap((l) => {
        const file = l.files.find((f) => fileName(f) === wanted);
        return file ? [{ folder: l.folder, file }] : [];
      });
    },
  };
}
