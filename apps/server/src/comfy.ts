import { ComfyClient, ComfyLocked, Monitor, scan, systemLoadFromStatus, type InfoLookup, type Scan, type SystemLoad } from "@afflatus/comfy";
import type { NodeCatalog } from "@afflatus/core";
import { fileName } from "./media";
import { PowerLog } from "./power";
import type { Registry } from "./registry";
import type { Machine } from "./settings";

const SCAN_TTL_MS = 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
/** How long a node list that could not be read is answered as not read (see catalog). */
const CATALOG_FAILED_MS = 15_000;
/** How often a machine's GPU power is read at most, whoever asks: as often as the open pages read the load. */
const POWER_EVERY_MS = 1_800;
/** A node pack without the power route is asked again after this (it may have been updated without ComfyUI's socket closing). */
const POWER_ABSENT_MS = 10 * 60_000;

/**
 * Where "the first ComfyUI" is asked while there is no machine at all (services.ts): port 9 is the discard port, closed on
 * any ordinary computer, so every call is refused at once and nothing that listens is ever reached.
 */
export const NO_COMFY_URL = "http://127.0.0.1:9";

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
  private lastCatalog: { at: number; value: Promise<NodeCatalog>; failed?: true } | null = null;
  /**
   * The pictures sent to this ComfyUI under a name their content gives, by folder and content hash (queueSubmit's picture
   * upload): the same picture in every window of a motion transfer goes up once. Forgotten when ComfyUI starts again (it
   * empties its temp folder then) and with everything else it is told.
   */
  readonly uploaded = new Map<string, { at: number; name: Promise<string> }>();
  /**
   * The files this ComfyUI saved that Afflatus keeps a copy of (an H3 latent), by the key they are stored under: named where
   * they are there ("Afflatus/h3_00001_.safetensors [temp]"), so that a job on this machine that joins onto one names it
   * rather than sending it back up (queueSubmit's sendLatent). Forgotten with the pictures when ComfyUI starts again.
   */
  readonly kept = new Map<string, { at: number; name: string }>();

  constructor(readonly url: string, private readonly registry: Registry, token = "") {
    this.client = new ComfyClient(url, undefined, token);
    this.monitor = new Monitor(this.client);
    // the socket opening again means ComfyUI was restarted (or came back): its nodes and files may have
    // changed, a node pack just written among them, so nothing kept about it holds
    this.monitor.onOpen = (again) => {
      this.openedAt = Date.now();
      if (again) this.forgetAll();
      else this.onFirstAnswer?.();
    };
  }

  /**
   * When its socket last opened (ms; 0 before it ever did): a ComfyUI restarted since then, by hand or by anyone, loaded what
   * was on its disk, so what podPacks.ts remembers as on the disk and not loaded no longer holds.
   */
  openedAt = 0;

  /** Its socket opened the first time (it answers, maybe for the first time since it was added): services.ts looks for its folder then. */
  onFirstAnswer?: () => void;

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

  /** The scan kept, as it stands, without making one (null when none is): what a lookup that can list a folder instead reads. */
  scanKept(): Promise<Scan> | null {
    return this.lastScan?.value ?? null;
  }

  private scanNow(): Promise<Scan> {
    return (async () => scan(this.client, this.registry.families(), this.registry.recipes(), (await this.overrides?.()) ?? {}, (await this.infoOf?.()) ?? (() => undefined), () => this.catalog()))();
  }

  /** The list of recipes changed: what was worked out no longer covers it. */
  forgetScan(): void {
    this.lastScan = null;
    this.nextScan = null;
    // nor a node list that could not be read: one found answering again (queue.ts back) is read at once
    if (this.lastCatalog?.failed) this.lastCatalog = null;
  }

  /** ComfyUI started again (or what it is told no longer holds): nothing learned about it holds any more. */
  forgetAll(): void {
    // started again, maybe with a newer node pack that reads the power
    this.powerAbsentUntil = 0;
    this.forgetFiles();
    this.uploaded.clear();
    this.kept.clear();
  }

  /**
   * A model file came to it or left it: its folders and its node list (whose choices name the files) are read again. The
   * pictures it was sent and the files it saved are still there, and stay known: forgotten with the rest, each landing of a
   * pod's file had every window's reference photo sent again.
   */
  forgetFiles(): void {
    this.lastScan = null;
    this.nextScan = null;
    this.lastCatalog = null;
  }

  /** The node list is read again next time (a node pack was written, and ComfyUI may have loaded it). */
  forgetCatalog(): void {
    this.lastCatalog = null;
  }

  /**
   * Its node list, kept CATALOG_TTL_MS. One that could not be read is kept CATALOG_FAILED_MS, as the queue retries a machine
   * away (offlineRetryMs): forgotten at once, the next waiting job asked it again, so a ComfyUI that never answered held the
   * Queue screen 60 s per job, minutes on end, and one that refused was asked once per job at each read (the 2026-10-22
   * review, H-3 and M-10). Its socket opening again, a fresh scan and forgetCatalog read it at once all the same.
   */
  async catalog(): Promise<NodeCatalog> {
    const last = this.lastCatalog;
    if (!last || Date.now() - last.at > (last.failed ? CATALOG_FAILED_MS : CATALOG_TTL_MS)) {
      const value = this.client.catalog();
      const read: NonNullable<Comfy["lastCatalog"]> = { at: Date.now(), value };
      this.lastCatalog = read;
      value.catch(() => {
        if (this.lastCatalog === read) this.lastCatalog = { at: Date.now(), value, failed: true };
      });
    }
    return this.lastCatalog!.value;
  }

  /** Whether ComfyUI answered the last `load()`: null before the first. A null load alone does not say (it may have no GPU figures). */
  answered: boolean | null = null;
  /** Whether the last `load()` found it locked against Afflatus's token: there, but a token to paste rather than a ComfyUI to start. */
  locked = false;

  /** A machine of this PC's, not a rented pod: its GPU's power is read with its other figures (a pod is billed by the hour). */
  home = false;
  /** Its power readings: a render's energy is worked out from them when it ends (power.ts). */
  readonly power = new PowerLog();
  private powerSeen: { at: number; watts: number | null } | null = null;
  private powerAsking: Promise<number | null> | null = null;
  /** No power route on its node pack (none, or an older one): not asked again before then, nor before ComfyUI restarts. */
  private powerAbsentUntil = 0;

  /**
   * Its GPU's power now (watts), read from its node pack at most every POWER_EVERY_MS whoever asks (the open pages' load,
   * a render's progress): each reading is kept for the energy of the render it falls in. Null when it is not read.
   */
  async readPower(): Promise<number | null> {
    const at = Date.now();
    if (!this.home || at < this.powerAbsentUntil) return null;
    if (this.powerSeen && at - this.powerSeen.at < POWER_EVERY_MS) return this.powerSeen.watts;
    this.powerAsking ??= this.client.gpuPower().then((said) => {
      this.powerAsking = null;
      if (said === "absent") {
        this.powerAbsentUntil = Date.now() + POWER_ABSENT_MS;
        return null;
      }
      this.powerSeen = { at: Date.now(), watts: said };
      if (said !== null) this.power.add(said);
      return said;
    }, () => (this.powerAsking = null));
    return this.powerAsking;
  }

  /** The machine's load: the monitor extension's latest broadcast if it is fresh, else ComfyUI's memory numbers. */
  async load(): Promise<SystemLoad | null> {
    // its power rides on the open pages' reading of the load: never waited for
    if (this.home) void this.readPower();
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
