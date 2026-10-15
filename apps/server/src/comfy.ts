import { ComfyClient, ComfyLocked, Monitor, scan, systemLoadFromStatus, type InfoLookup, type Scan, type SystemLoad } from "@afflatus/comfy";
import type { NodeCatalog } from "@afflatus/core";
import { fileName } from "./media";
import type { Registry } from "./registry";
import type { Machine } from "./settings";

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
  /** The scan under way in the background while the last one is still answered (see scan). */
  private nextScan: Promise<Scan> | null = null;
  private lastCatalog: { at: number; value: Promise<NodeCatalog> } | null = null;
  /**
   * The pictures sent to this ComfyUI under a name their content gives, by folder and content hash (queueSubmit's picture
   * upload): the same picture in every window of a motion transfer goes up once. Forgotten when ComfyUI starts again (it
   * empties its temp folder then) and with everything else it is told.
   */
  readonly uploaded = new Map<string, { at: number; name: Promise<string> }>();

  constructor(readonly url: string, private readonly registry: Registry, token = "") {
    this.client = new ComfyClient(url, undefined, token);
    this.monitor = new Monitor(this.client);
    // the socket opening again means ComfyUI was restarted (or came back): its nodes and files may have
    // changed, a node pack just written among them, so nothing kept about it holds
    this.monitor.onOpen = (again) => {
      if (again) this.forgetAll();
    };
  }

  /** The files chosen by hand for the families' slots (Settings), read when a scan is made. */
  overrides?: () => Promise<Record<string, Record<string, string>>>;
  /** What is known of each model file from its header, read when a scan is made. */
  infoOf?: () => Promise<InfoLookup>;

  /**
   * What it can do. A scan older than a minute is answered as it is while a new one is made in the background (its node
   * list kept for ten minutes, its model folders listed again): the queue, the setup page and /metrics never wait on it.
   * Waited for: the first one, one asked `fresh` ("Test" in Settings, which reads the node list again too), one after
   * forgetScan or forgetAll, and one after the last found ComfyUI away.
   */
  async scan(fresh = false): Promise<Scan> {
    if (fresh) this.lastCatalog = null;
    if (fresh || !this.lastScan) {
      this.nextScan = null;
      this.lastScan = { at: Date.now(), value: this.scanNow() };
    } else if (Date.now() - this.lastScan.at > SCAN_TTL_MS && !this.nextScan) {
      const last = this.lastScan;
      const value = this.scanNow();
      this.nextScan = value;
      void value.then((result) => {
        // forgotten or asked afresh meanwhile: that one stands
        if (this.nextScan !== value) return;
        this.nextScan = null;
        if (this.lastScan === last) this.lastScan = { at: Date.now(), value };
        // an unreachable ComfyUI is asked again next time, not remembered
        if (!result.comfy.online && this.lastScan?.value === value) this.lastScan = null;
      }, () => {
        // a scan that failed outright leaves the last one standing, and the next call tries again
        if (this.nextScan === value) this.nextScan = null;
      });
    }
    const asked = this.lastScan;
    const result = await asked.value;
    // an unreachable ComfyUI is asked again next time, not remembered
    if (!result.comfy.online && this.lastScan === asked) this.lastScan = null;
    return result;
  }

  private scanNow(): Promise<Scan> {
    return (async () => scan(this.client, this.registry.families(), this.registry.recipes(), (await this.overrides?.()) ?? {}, (await this.infoOf?.()) ?? (() => undefined), () => this.catalog()))();
  }

  /** The list of recipes changed: what was worked out no longer covers it. */
  forgetScan(): void {
    this.lastScan = null;
    this.nextScan = null;
  }

  /** This ComfyUI has a file it did not have: nothing learned about it holds any more. */
  forgetAll(): void {
    this.lastScan = null;
    this.nextScan = null;
    this.lastCatalog = null;
    this.uploaded.clear();
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

  /** Whether ComfyUI answered the last `load()`: null before the first. A null load alone does not say (it may have no GPU figures). */
  answered: boolean | null = null;
  /** Whether the last `load()` found it locked against Afflatus's token: there, but a token to paste rather than a ComfyUI to start. */
  locked = false;

  /** The machine's load: the monitor extension's latest broadcast if it is fresh, else ComfyUI's memory numbers. */
  async load(): Promise<SystemLoad | null> {
    this.monitor.ensure();
    const live = this.monitor.system;
    if (live && Date.now() - live.at < 5_000) {
      this.answered = true;
      this.locked = false;
      return live;
    }
    try {
      const load = systemLoadFromStatus(await this.client.status());
      this.answered = true;
      this.locked = false;
      return load;
    } catch (err) {
      this.answered = false;
      this.locked = err instanceof ComfyLocked;
      return null;
    }
  }

  close(): void {
    this.monitor.close();
  }
}

/** A machine of the settings and the client of its ComfyUI. */
export interface MachineComfy {
  machine: Machine;
  comfy: Comfy;
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
