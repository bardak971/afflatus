import { fileName } from "./media";
import { civitaiVersion } from "./civitai";
import type { Comfy } from "./comfy";
import { filesIn } from "@afflatus/comfy";
import { isOfficialFile } from "@afflatus/core";
import type { Db } from "./db";
import { PASSING, type Downloads } from "./downloads";
import { stat } from "node:fs/promises";
import { GUESSED, MEASURED_FROM, measuredRange, recordFetch, recordMeasure, type MeasureKind, type Range } from "./podMeasures";
import { localCopy, measureKind, podSource, presetsOf, type PodSource, type SourceLookup } from "./podSources";
import { PACKS_MS, PodPacks, type PodPackView } from "./podPacks";
import { PACK_UPLOADS, uploadFile } from "./podUpload";
import type { Settings } from "./settings";
import { assertPublicUrl, fetchPublic } from "./outbound";
import { olderThan } from "./version";

/**
 * The model files a rented pod is getting, per pod: what its waiting jobs need first, in the order the queue asked for
 * them, then the files asked for "ahead" (a model set's, a job's that went home this time) with what the line has left.
 * Each comes from its site straight onto the pod (the node pack's download, from the site's own link: the pod cannot reach
 * Afflatus), or, for a file no site is known for, is sent from this computer (podUpload.ts).
 *
 * The money rule: a file that is moving holds the pod's idle time (moving()), so that a pod is never stopped or terminated
 * by its idle stop mid-download (the owner: a pod must not be lost for downloading); its idle time runs again from when
 * the last file is in or failed. Only bytes that come count: a download or upload with nothing new for STALL_MS no longer
 * holds it, so a stuck fetch cannot bill for ever, and the caps, the balance, the watchdog and a Stop by hand act as
 * before. A file that cannot be had is said once and stays failed for that pod: its jobs go elsewhere (queue.ts).
 */

export type PodFileState = "next" | "fetching" | "ready" | "failed";

export interface PodFileView {
  file: string;
  folder: string;
  state: PodFileState;
  /** "need": a job waits for it; "ahead": for later. */
  tier: "need" | "ahead";
  bytes: number;
  /** 0 while not known. */
  total: number;
  /** Where it comes from: Hugging Face, Civitai, another address, or this computer. */
  via?: "hf" | "civitai" | "url" | "upload";
  error?: string;
  /** The jobs that wait for it. */
  jobs: string[];
}

export interface PodFileWant {
  file: string;
  folder: string;
  /** Where it is had, when the caller knows (a job's missing file, a preset's or a set's file). */
  url?: string;
  civitai?: { version: number; pick?: string };
  /** Bytes, when known. */
  size?: number;
}

interface Entry extends PodFileView {
  /** The order "need" files are fetched in: when it was first needed. */
  needAt: number;
  source?: PodSource | null;
  url?: string;
  civitai?: { version: number; pick?: string };
  downloadId?: string;
  upload?: AbortController;
  /** When its bytes started coming, for its speed. */
  flowingAt?: number;
  /** When its bytes last moved, and how many there were then: a file under way holds the pod's idle time only while they move. */
  movedAt?: number;
  movedBytes?: number;
  /** When all of it was on the pod (the pack had it whole), for its speed. */
  wholeAt?: number;
  /** Put back in line after a passing failure (ComfyUI not answering, its line full): how many times, and not before when. */
  tries?: number;
  notBefore?: number;
  /** Afflatus put it there (downloaded or sent), not found there: only such a file is ever deleted to make room. */
  fetched?: boolean;
  /** When a job last asked for it, or it came: the longest unused goes first when room is made. */
  usedAt?: number;
  /** Put back in line once already because the disk was full (diskFull): a second time, it fails. */
  roomTried?: boolean;
  /** Asked for by the user (the deploy's files, a model set): never dropped for want of a job (dropUnsought). */
  byUser?: boolean;
  /** The waiting jobs the queue's plan sent it for (need or ahead): once none of them may run here, it is dropped. */
  sentFor?: string[];
}

/** A pod's disk as its node pack said it (0.19.0 on): the bytes free and in all, and when it was read. */
export interface PodDisk {
  free: number;
  total: number;
  at: number;
}

export interface PodFilesDeps {
  db: Db;
  downloads: Downloads;
  /** The machine's ComfyUI, while there is one to reach. */
  comfyOf(machine: string): Promise<Comfy | null>;
  /** Its cloud (RunPod's secure or community), for the speeds measured on it. */
  cloudOf(machine: string): Promise<string | null>;
  lookup: SourceLookup;
  settings(): Promise<Pick<Settings, "civitaiKey" | "downloadModels" | "civitaiLookups"> & Partial<Pick<Settings, "huggingFaceToken">>>;
  /** Whether the machine's pod runs now: nothing starts or moves on one that does not. */
  alive(machine: string): boolean;
  /**
   * Whether the machine's pod is down for good (stopped, terminated, or not on RunPod at two reads in a row): what it was
   * getting is forgotten, its container went with it. Without it, a pod not alive is.
   */
  gone?(machine: string): boolean;
  /** Whether a job runs on the machine now, or work from outside Afflatus: its ComfyUI is not restarted under a render (podPacks.ts). */
  busy(machine: string): boolean;
  /** Something changed: the pod's row says it. */
  changed?(): void;
  /**
   * A file came to a pod or left it (`files`), or failed there, or its node packs were loaded: the queue looks at its jobs
   * again, and what lists the pod's files is read again only when they changed (a failure changes none of them).
   */
  settled?(machine: string, files: boolean): void;
  /** Whether the pod makes room on its disk (its Make room, rentedSchema.makeRoom): the models it fetched that no waiting job needs are deleted. */
  makesRoom?(machine: string): Promise<boolean>;
  /** Whether the machine's pod runs on a network volume: its models are on the volume, whose room is then what is said full. */
  onVolume?(machine: string): Promise<boolean>;
  /** A stretch of installing node packs for its jobs is over (podPacks.ts packsTime): kept for Costs. */
  packsTime?(machine: string, from: number, to: number): void;
}

/** A file whose size nothing says yet is planned as this large. */
const ASSUMED_BYTES = 8 * 2 ** 30;
/** How long a source found for a file, and a range measured, are kept before being asked again (the queue asks often). */
const KEEP_MS = 60_000;

/** How many of a pod's files come at once: two downloads share its line well, and one upload this computer's. */
const DOWNLOADS_AT_ONCE = 2;
const UPLOADS_AT_ONCE = 1;
/**
 * What the node pack answers a download or an upload of a file it has, or is getting (downloads.py, uploads.py): checked
 * against the pod's own list before the file is taken for there.
 */
const THERE = /\(409: that file is there already/;
/** How many times a passing failure puts a file back in line before it is failed, and the first wait (doubled each time). */
const TRIES = 4;
const RETRY_MS = 15_000;
/** How long the files landing on a pod without letting a job start are gathered into one read of its files (landed). */
const LANDINGS_MS = 5_000;
/** How long a file under way may bring no new byte and still hold its pod's idle time (moving()). */
const STALL_MS = 5 * 60_000;
/**
 * A disk that is full, as the node pack says it (downloads.py: a write that found no room, a file that does not fit beside
 * the downloads under way; uploads.py and a download asked for with its size: 507). It stays full: never asked again as is.
 */
const DISK_FULL = /disk is full|no space left|\(507[:)]/i;
/** A file Afflatus itself held back for want of room on the pod's disk or its volume (roomFor, diskFull). */
const NO_ROOM = /^(the pod's disk|its volume) is full/;
/** Room kept free on a pod's disk beside its models: ComfyUI's outputs, its temporary files, the pack's .part files. */
const DISK_MARGIN = 2 * 2 ** 30;
/** How often a pod's disk is read again (GET /afflatus/disk): its row says it, and a file is held against it before it starts. */
const DISK_EVERY_MS = 15_000;
const gbSaid = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
const keyOf = (folder: string, file: string) => `${folder}|${fileName(file).toLowerCase()}`;

export class PodFiles {
  private readonly pods = new Map<string, Map<string, Entry>>();
  private seq = 0;
  private ticking: Promise<void> | null = null;
  /** A file smaller than this is not measured (podMeasures.ts MEASURED_FROM; smaller in tests). */
  measuredFrom = MEASURED_FROM;
  /** The first wait before an upload's piece is sent again (shorter in tests). */
  uploadBackoffMs = 2000;
  /** How long a file may bring nothing and still hold its pod's idle time (shorter in tests). */
  stallMs = STALL_MS;
  /** How old a disk read may be when a file is held against it before it starts (0 in tests). */
  diskFreshMs = 5_000;
  /** Each pod's disk as last read; null: its node pack is too old to say (before 0.19.0). */
  private readonly disks = new Map<string, PodDisk | null>();
  private readonly diskReads = new Map<string, Promise<PodDisk | null>>();
  /** Each pod's Make room, as last read (with its disk, and before room is looked for). */
  private readonly making = new Map<string, boolean>();
  private makes(machine: string): boolean {
    return this.making.get(machine) ?? false;
  }
  private async readMakes(machine: string): Promise<boolean> {
    const [makes, volume] = await Promise.all([this.d.makesRoom?.(machine).catch(() => false), this.d.onVolume?.(machine).catch(() => false)]);
    this.making.set(machine, makes ?? false);
    this.onVolumes.set(machine, volume ?? false);
    return makes ?? false;
  }
  /** Each pod's being on a network volume, as last read with its Make room. */
  private readonly onVolumes = new Map<string, boolean>();
  /** What is full when a file finds no room: the volume the pod's models are on, or the pod's own disk. */
  private fullSaid(machine: string): string {
    return this.onVolumes.get(machine) ? "its volume is full" : "the pod's disk is full";
  }

  /**
   * Whether files are coming to a pod now: one under way whose bytes moved within the last stallMs. What holds its idle
   * time (rented.ts keepOrStop): a download is waited for, a stuck one is not. A download's bytes are read from the
   * download list here, not only at the next pass, so that the answer is never a pass behind.
   */
  moving(machine: string): boolean {
    const now = Date.now();
    for (const e of this.pods.get(machine)?.values() ?? []) {
      if (e.state !== "fetching") continue;
      const v = e.downloadId ? this.d.downloads.get(e.downloadId) : null;
      if (v) this.moved(e, v.bytes);
      const at = e.movedAt ?? e.flowingAt;
      if (at !== undefined && now - at < this.stallMs) return true;
    }
    return false;
  }

  /** Its bytes as last seen: the time they last moved is kept when they did. */
  private moved(e: Entry, bytes: number): void {
    if (bytes === e.movedBytes) return;
    e.movedBytes = bytes;
    e.movedAt = Date.now();
  }

  /** A pod's disk as last read, for its row: null while not known (not read yet, or a node pack too old to say). */
  diskOf(machine: string): PodDisk | null {
    return this.disks.get(machine) ?? null;
  }

  /** Its disk, read again when the last read is older than `fresh` ms (one read at a time). */
  private disk(machine: string, fresh = DISK_EVERY_MS): Promise<PodDisk | null> {
    const kept = this.disks.get(machine);
    if (kept === null || (kept && Date.now() - kept.at < fresh)) return Promise.resolve(kept);
    let reading = this.diskReads.get(machine);
    if (!reading) {
      reading = (async () => {
        const comfy = await this.d.comfyOf(machine).catch(() => null);
        const got = comfy ? await comfy.client.disk().catch(() => null) : null;
        await this.readMakes(machine);
        // an older pack: nothing to read, nothing held against its files (its own 507 still refuses a file larger than its room)
        if (got === "absent") this.disks.set(machine, null);
        else if (got) {
          const was = this.disks.get(machine);
          this.disks.set(machine, { free: got.free, total: got.total, at: Date.now() });
          if (!was || Math.abs(was.free - got.free) > 2 ** 28) this.d.changed?.();
        }
        return this.disks.get(machine) ?? null;
      })().finally(() => this.diskReads.delete(machine));
      this.diskReads.set(machine, reading);
    }
    return reading;
  }

  /** What the files under way on a pod still have to write: room its free bytes do not have for anything else. */
  private underway(machine: string, but?: Entry): number {
    return this.ordered(machine).filter((e) => e !== but && e.state === "fetching").reduce((n, e) => n + Math.max(0, e.total - e.bytes), 0);
  }

  /**
   * The files Afflatus fetched onto a pod that no job waiting or running needs (nor one of `keep`), the longest unused first:
   * what Make room deletes. Never a file the pod had before (its image's, its volume's).
   */
  private async spare(machine: string, keep: Set<string> = new Set()): Promise<Entry[]> {
    const ready = this.ordered(machine).filter((e) => e.state === "ready" && e.fetched && !keep.has(keyOf(e.folder, e.file)));
    const ids = [...new Set(ready.flatMap((e) => e.jobs))];
    const active = new Set(ids.length ? (await this.d.db.selectFrom("jobs").select("id").where("id", "in", ids).where("status", "in", ["queued", "running"]).execute()).map((j) => j.id) : []);
    // a file a waiting job of this pod still needs (one that wants it next) is kept too
    const wanted = new Set(this.ordered(machine).filter((e) => e.state !== "ready" && e.state !== "failed").map((e) => keyOf(e.folder, e.file)));
    return ready.filter((e) => !e.jobs.some((j) => active.has(j)) && !wanted.has(keyOf(e.folder, e.file))).sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
  }

  /**
   * Room on the pod's disk for `bytes` more, beside the files under way and the margin: made by deleting what it fetched and
   * no job needs (`spare`) when the pod makes room. Null when there is room (or its disk cannot be read: the pack still
   * refuses what does not fit), else why there is none, for the file's or the job's line.
   */
  private async roomFor(machine: string, bytes: number, but?: Entry, mayDelete = true): Promise<string | null> {
    const disk = await this.disk(machine, this.diskFreshMs);
    if (!disk) return null;
    const room = () => this.disks.get(machine)!.free - this.underway(machine, but) - DISK_MARGIN;
    if (room() >= bytes) return null;
    const makes = await this.readMakes(machine);
    if (makes && mayDelete) {
      const comfy = await this.d.comfyOf(machine).catch(() => null);
      for (const e of comfy ? await this.spare(machine, but ? new Set([keyOf(but.folder, but.file)]) : undefined) : []) {
        if (room() >= bytes) break;
        const removed = await comfy!.client.removeModel(e.folder, e.file).catch((err: Error) => {
          console.warn(`[pod files] ${e.file} not removed from ${machine}: ${err.message}`);
          return null;
        });
        if (removed === null) continue;
        this.pods.get(machine)?.delete(keyOf(e.folder, e.file));
        console.log(`[pod files] ${e.file} (${gbSaid(removed)}) removed from ${machine} to make room`);
        const d = this.disks.get(machine)!;
        this.disks.set(machine, { ...d, free: d.free + removed });
        this.d.settled?.(machine, true);
        this.d.changed?.();
      }
      // what the disk says now, not what was added up
      this.disks.set(machine, { ...this.disks.get(machine)!, at: 0 });
      await this.disk(machine, 0);
      if (room() >= bytes) return null;
    }
    const free = Math.max(0, this.disks.get(machine)!.free - this.underway(machine, but));
    return `${this.fullSaid(machine)}: ${gbSaid(free)} free, ${gbSaid(bytes)} needed${makes ? ", and nothing it fetched can be deleted (its waiting jobs need it)" : " (Make room is off)"}`;
  }

  /**
   * Whether these files fit on the pod's disk, for the queue before it sends a job there: the ones not there yet, of the
   * sizes known, against its free bytes and (when it makes room) what it could delete. Null: they fit, or it is not known.
   */
  async short(machine: string, files: PodFileWant[]): Promise<string | null> {
    const disk = this.disks.get(machine);
    void this.disk(machine);
    if (!disk) return null;
    const keys = new Set(files.map((f) => keyOf(f.folder, f.file)));
    await this.readMakes(machine);
    let need = 0;
    for (const f of files) {
      const e = this.pods.get(machine)?.get(keyOf(f.folder, f.file));
      if (e?.state === "ready") continue;
      if (e?.state === "fetching") continue;
      const src = e?.source !== undefined ? e.source : await this.sourceOf(f, false);
      const size = e?.total || f.size || (src ? await this.sizeOf(f, src) : 0);
      // a size nothing says is not held against the job: the pack refuses the file if it does not fit
      if (size !== ASSUMED_BYTES) need += size;
    }
    const spare = this.makes(machine) ? (await this.spare(machine, keys)).reduce((n, e) => n + e.total, 0) : 0;
    const room = disk.free - this.underway(machine) - DISK_MARGIN + spare;
    if (need <= room) return null;
    return `${this.onVolumes.get(machine) ? "its volume is short" : "its disk is short"}: ${gbSaid(need)} to fetch, ${gbSaid(Math.max(0, disk.free - this.underway(machine)))} free${this.makes(machine) ? `, ${gbSaid(spare)} it could delete` : " (Make room is off)"}`;
  }

  /** The node packs pods get for their jobs, beside the files. */
  private readonly packs: PodPacks;

  constructor(private readonly d: PodFilesDeps) {
    this.packs = new PodPacks({ comfyOf: d.comfyOf, busy: d.busy, beforeRestart: (m) => this.requeueFetching(m), packsTime: d.packsTime });
  }

  /** No job may start on the machine: its node packs wait for its ComfyUI to restart, or it restarts now. */
  holding(machine: string): boolean {
    return this.packs.holding(machine);
  }

  /** How long a file put back in line after a passing failure waits before it is asked again (shorter in tests). */
  retryMs = RETRY_MS;

  /** How long files that land without letting a job start are gathered before the pod's files are read again (landed). */
  landingsMs = LANDINGS_MS;
  /** The read of the pod's files that waits for the files landing meanwhile, by machine (landed). */
  private readonly landings = new Map<string, NodeJS.Timeout>();

  /**
   * A file is on the pod: its folders and node list are read again (settled), at once when it lets one of its jobs start
   * (every file that job waits for is there) or no other file is coming to it, else once with the others landing within
   * LANDINGS_MS. Each landing read the node list and every folder again: about 7 times a deploy, a few MB each. A deploy's
   * files are no job's (e.jobs empty) though the jobs waiting need them: its last one gathered, the queue learnt of it 5 s
   * late, the pod billed and idle meanwhile.
   */
  private landed(machine: string, e: Entry): void {
    const pod = [...(this.pods.get(machine)?.values() ?? [])];
    const last = !pod.some((o) => o !== e && (o.state === "next" || o.state === "fetching"));
    const starts = last || e.jobs.some((job) => pod.every((o) => o.state === "ready" || !o.jobs.includes(job)));
    const waiting = this.landings.get(machine);
    if (starts) {
      if (waiting) clearTimeout(waiting);
      this.landings.delete(machine);
      this.d.settled?.(machine, true);
      return;
    }
    if (waiting) return;
    const timer = setTimeout(() => {
      this.landings.delete(machine);
      this.d.settled?.(machine, true);
    }, this.landingsMs);
    timer.unref?.();
    this.landings.set(machine, timer);
  }

  /** Everything the pod is getting put back in line: its ComfyUI restarts, and its downloads and uploads live in its process. */
  private requeueFetching(machine: string): void {
    for (const e of this.pods.get(machine)?.values() ?? []) if (e.state === "fetching") this.requeue(e);
  }

  /**
   * A file under way stopped and put back in line, as it was before it started. The pod's node pack keeps what it fetched of
   * it, and its next download carries on from there: a file given its place to one a job waits for, or cut by ComfyUI's
   * restart for node packs, was fetched again from its first byte (21 GB 60 % done: about 50 s of a billed pod).
   */
  private requeue(e: Entry): void {
    if (e.downloadId) this.d.downloads.stop(e.downloadId, true);
    e.upload?.abort();
    e.state = "next";
    e.bytes = 0;
    delete e.downloadId;
    delete e.flowingAt;
    delete e.movedAt;
    delete e.movedBytes;
    delete e.wholeAt;
  }

  /** A passing failure: the file asked again a little later, a few times; then it is failed for that pod. */
  private retryLater(machine: string, e: Entry, why: string): true {
    const tries = (e.tries ?? 0) + 1;
    if (tries >= TRIES) return this.fail(machine, e, why);
    this.requeue(e);
    e.tries = tries;
    e.notBefore = Date.now() + this.retryMs * 2 ** (tries - 1);
    console.warn(`[pod files] ${e.file} on ${machine}: ${why}; asked again`);
    return true;
  }

  /** Whether this entry is still the pod's (a pod forgotten, or the file asked anew, while an answer was awaited). */
  private current(machine: string, e: Entry): boolean {
    return this.pods.get(machine)?.get(keyOf(e.folder, e.file)) === e;
  }

  /**
   * Whether the pod's own list of the folder has the file, its .gguf files too (filesIn: a GGUF a volume holds was said
   * missing, and failed or fetched again); null when its ComfyUI does not answer.
   */
  private async onPod(machine: string, e: Entry): Promise<boolean | null> {
    const comfy = await this.d.comfyOf(machine);
    if (!comfy) return null;
    return filesIn(comfy.client, e.folder).then((files) => files.some((f) => fileName(f) === fileName(e.file)), () => null);
  }

  /** "There already" from the pack: the pod's own list says whether it is there (else it is still coming: asked again later). */
  private async confirmThere(machine: string, e: Entry): Promise<void> {
    const listed = await this.onPod(machine, e);
    if (!this.current(machine, e)) return;
    if (listed) await this.ready(machine, e, false);
    else this.retryLater(machine, e, "a copy of it is still on its way to the pod");
  }

  /**
   * Node packs a job planned onto the pod needs there (machineScans.ts Lack.packs): installed through its Manager, then its
   * ComfyUI restarted once nothing renders there. Only for a job that will run there: a restart is not made ahead.
   */
  wantPacks(machine: string, names: string[], job: string): void {
    if (this.packs.want(machine, names, job)) {
      this.d.changed?.();
      void this.tick();
    }
  }

  /** Why these node packs cannot come to that pod; null when they can. */
  failedPacks(machine: string, names: string[]): string | null {
    return this.packs.failed(machine, names);
  }

  /** How long a node pack Manager cannot find yet waits before it is asked again (podPacks.ts; shorter in tests). */
  set packRetryMs(ms: number) {
    this.packs.retryMs = ms;
  }

  /** The node packs a pod is getting, for its row. */
  packsView(machine: string): PodPackView[] {
    return this.packs.view(machine);
  }

  /**
   * Files for a pod: "need" (a job waits for them, `job` when given) comes before "ahead"; a file ahead asked as needed moves
   * up. `sentFor`: the queue's plan sent it for that job (dropUnsought); left out, the user asked for it.
   */
  want(machine: string, files: PodFileWant[], o: { tier: "need" | "ahead"; job?: string; sentFor?: string }): void {
    let pod = this.pods.get(machine);
    if (!pod) this.pods.set(machine, (pod = new Map()));
    let changed = false;
    for (const f of files) {
      const key = keyOf(f.folder, f.file);
      let e = pod.get(key);
      if (!e) {
        e = { file: f.file, folder: f.folder, state: "next", tier: o.tier, bytes: 0, total: f.size ?? 0, jobs: [], needAt: o.tier === "need" ? ++this.seq : Infinity };
        if (f.url) e.url = f.url;
        if (f.civitai) e.civitai = f.civitai;
        pod.set(key, e);
        changed = true;
      } else if (o.tier === "need" && e.tier === "ahead") {
        e.tier = "need";
        e.needAt = ++this.seq;
        changed = true;
      }
      if (!o.sentFor) e.byUser = true;
      else if (!e.sentFor?.includes(o.sentFor)) (e.sentFor ??= []).push(o.sentFor);
      if (o.job && !e.jobs.includes(o.job)) {
        e.jobs.push(o.job);
        changed = true;
      }
      if (o.job) e.usedAt = Date.now();
    }
    if (changed) {
      this.d.changed?.();
      void this.tick();
    }
  }

  /**
   * Files the queue's plan sent a pod for jobs none of which may run there any more (done, cancelled, pinned elsewhere):
   * stopped while they come, and forgotten. Two pods pulled 40 GB for jobs pinned to a third one in the meantime, and nothing
   * could stop them (2026-10-18). What the user asked for, and what is there already, stays.
   */
  dropUnsought(machine: string, mayRun: (job: string) => boolean): void {
    // a pod asked for node packs alone has no files: its packs are looked at all the same
    const pod = this.pods.get(machine) ?? new Map<string, Entry>();
    let changed = false;
    for (const [key, e] of pod) {
      if (e.byUser || !e.sentFor?.length || (e.state !== "next" && e.state !== "fetching") || e.sentFor.some(mayRun)) continue;
      if (e.downloadId && e.state === "fetching") this.d.downloads.stop(e.downloadId);
      e.upload?.abort();
      pod.delete(key);
      changed = true;
    }
    // the node packs asked for those jobs alone, not installing yet: no install, no restart of its ComfyUI for them
    if (this.packs.drop(machine, mayRun)) changed = true;
    if (changed) {
      this.d.changed?.();
      void this.tick();
    }
  }

  /** Whether the pod holds or is getting files the plan sent it for this job. */
  holdsFor(machine: string, job: string): boolean {
    return [...(this.pods.get(machine)?.values() ?? [])].some((e) => e.sentFor?.includes(job) && e.state !== "failed");
  }

  /** A job's files on that pod: all there ("ready"), one that cannot be had ("failed", with why), or still coming; null when it asked for none. */
  jobState(machine: string, job: string): { state: "ready" | "waiting" | "failed"; error?: string; files: PodFileView[] } | null {
    const mine = [...(this.pods.get(machine)?.values() ?? [])].filter((e) => e.jobs.includes(job));
    const packs = this.packs.jobPacks(machine, job);
    if (!mine.length && !packs.length) return null;
    const failed = mine.find((e) => e.state === "failed");
    const files = mine.map((e) => this.viewOf(e));
    if (failed) return { state: "failed", error: `${fileName(failed.file)}: ${failed.error ?? "it could not be had"}`, files };
    const pack = packs.find((p) => p.state === "failed");
    if (pack) return { state: "failed", error: `the node pack ${pack.name}: ${pack.error ?? "it was not installed"}`, files };
    return { state: mine.every((e) => e.state === "ready") && packs.every((p) => p.state === "ready") ? "ready" : "waiting", files };
  }

  /** Files the user left out of the pod (unticked at its deploy): never fetched there, and the jobs that use one stay elsewhere. */
  leaveOut(machine: string, files: Array<{ file: string; folder: string }>): void {
    let pod = this.pods.get(machine);
    if (!pod) this.pods.set(machine, (pod = new Map()));
    for (const f of files) {
      const key = keyOf(f.folder, f.file);
      if (pod.get(key)?.state === "ready") continue;
      pod.set(key, { file: f.file, folder: f.folder, state: "failed", error: "left out when the pod was deployed", tier: "ahead", bytes: 0, total: 0, jobs: [], needAt: Infinity, source: null });
    }
    this.d.changed?.();
  }

  /** Where a file would come from and how large it is, before it is asked for (the Deploy dialog): null for what is not known. */
  async about(f: PodFileWant): Promise<{ via: "hf" | "civitai" | "url" | "upload" | null; size: number | null }> {
    // what is known only: the lists that ask this ask it of many files at once, and a site is asked only for a pod's fetch
    const src = await this.sourceOf(f, false);
    if (!src) return { via: null, size: f.size ?? null };
    const size = f.size ?? (await this.sizeOf(f, src));
    return { via: measureKind(src), size: size === ASSUMED_BYTES ? null : size };
  }

  /** Whether a file failed on that pod already (asking again would fail again): its reason. */
  failed(machine: string, folder: string, file: string): string | null {
    const e = this.pods.get(machine)?.get(keyOf(folder, file));
    return e?.state === "failed" ? e.error ?? "it could not be had" : null;
  }

  /**
   * How long until these files are on the pod (ms), for the queue's plan: what is left of each, at the slow end of the
   * speeds measured from its source (or a cautious guess before any was), one after the other. Infinity when one has no
   * source at all: the pod is then never the sooner place for its job.
   */
  async untilThere(machine: string, files: PodFileWant[], packs: string[] = []): Promise<number> {
    // its node packs installed and ComfyUI restarted: about four minutes on a pod just up, beside the files
    let ms = packs.length && !this.packs.ready(machine, packs) ? PACKS_MS : 0;
    for (const f of files) {
      const e = this.pods.get(machine)?.get(keyOf(f.folder, f.file));
      if (e?.state === "ready") continue;
      const src = e?.source !== undefined ? e.source : await this.sourceOf(f, true);
      if (!src) return Infinity;
      const kind = measureKind(src);
      const left = e?.total ? e.total - e.bytes : f.size ?? (await this.sizeOf(f, src));
      const range = await this.rangeOf(kind, await this.d.cloudOf(machine));
      ms += (left / (range?.low ?? GUESSED[kind].low)) * 1000;
    }
    return ms;
  }

  private readonly sources = new Map<string, { at: number; value: Promise<PodSource | null> }>();
  /** Where a file comes from (podSources.ts), kept a minute; `live`: a site may be asked (a pod's fetch, the queue's plan for it). */
  private sourceOf(f: PodFileWant, live: boolean): Promise<PodSource | null> {
    // the source given is part of the key: a set's Civitai version is not taken for a job's file with none; and what is
    // known only is not taken for what a site was asked
    const key = `${keyOf(f.folder, f.file)}|${f.url ?? ""}|${f.civitai?.version ?? ""}|${live ? "live" : "known"}`;
    const kept = this.sources.get(key);
    if (kept && Date.now() - kept.at < KEEP_MS) return kept.value;
    const value = podSource(this.d.lookup, { file: f.file, folder: f.folder, ...(f.url ? { url: f.url } : {}), ...(f.civitai ? { civitai: f.civitai } : {}) }, { live });
    // a lookup that failed (the database) is not kept: asked again next time, not taken for "no source" a minute long
    value.catch(() => this.sources.delete(key));
    const safe = value.catch(() => null);
    this.sources.set(key, { at: Date.now(), value: safe });
    return safe;
  }

  private readonly ranges = new Map<string, { at: number; value: Promise<Range | null> }>();
  private rangeOf(kind: Exclude<MeasureKind, "boot">, cloud: string | null): Promise<Range | null> {
    const key = `${kind}|${cloud ?? ""}`;
    const kept = this.ranges.get(key);
    if (kept && Date.now() - kept.at < KEEP_MS) return kept.value;
    const value = measuredRange(this.d.db, kind, cloud).catch(() => null);
    this.ranges.set(key, { at: Date.now(), value });
    return value;
  }

  private readonly sizes = new Map<string, { at: number; value: Promise<number> }>();
  /** A file's size before it is fetched, kept a minute: the queue asks for every waiting job at every pass. */
  private sizeOf(f: PodFileWant, src: PodSource): Promise<number> {
    const key = keyOf(f.folder, f.file);
    const kept = this.sizes.get(key);
    if (kept && Date.now() - kept.at < KEEP_MS) return kept.value;
    const value = this.readSize(f, src);
    this.sizes.set(key, { at: Date.now(), value });
    return value;
  }

  /** A file's size before it is fetched: this computer's copy's, a preset's that names it, the site's, else a cautious guess. */
  private async readSize(f: PodFileWant, src: PodSource): Promise<number> {
    const path = src.kind === "upload" ? src.path : await localCopy(await this.d.lookup.comfyDir(), f.folder, f.file);
    const size = path ? (await stat(path).catch(() => null))?.size : undefined;
    if (size) return size;
    const name = fileName(f.file).toLowerCase();
    for (const p of await presetsOf(this.d.lookup).catch(() => [])) {
      const named = p.files.find((x) => x.folder === f.folder && fileName(x.file).toLowerCase() === name && x.size);
      if (named?.size) return named.size;
    }
    // the site asked, when looking things up is on: Hugging Face says a file's size on its address (X-Linked-Size, on the
    // redirect to its storage, whose own length is the redirect's), Civitai with the version's files
    const settings = await this.d.settings().catch(() => null);
    if (settings?.civitaiLookups) {
      if (src.kind === "civitai") {
        const found = await civitaiVersion(src.version, src.pick ?? fileName(f.file), settings.civitaiKey, src.sha256).catch(() => null);
        if (found?.file.sizeKB) return Math.round(found.file.sizeKB * 1024);
      } else if (src.kind === "url" && measureKind(src) === "hf") {
        // judged as any address fetched on a user's say-so (outbound.ts), redirects too; the size is on the first answer
        let said = 0;
        const seen = (res: Response) => (said ||= Number(res.headers.get("x-linked-size") ?? 0));
        const res = await Promise.resolve()
          .then(() => assertPublicUrl(src.url))
          .then(() => fetchPublic(src.url, { method: "HEAD", signal: AbortSignal.timeout(10_000) }, [], 1, seen))
          .catch(() => null);
        if (res) seen(res);
        if (said > 0) return said;
      }
    }
    return ASSUMED_BYTES;
  }

  /** A pod's files as its row lists them: needed ones in the order they are fetched, then the ones ahead. */
  view(machine: string): PodFileView[] {
    return this.ordered(machine).map((e) => this.viewOf(e));
  }

  /**
   * Files deleted from the pod's volume (the volume viewer): no longer there, and the room they took free again. A file that
   * failed for want of room goes back in line, its disk is read again before it starts, and the pod's folders are read again.
   */
  freed(machine: string, files: ReadonlyArray<{ folder: string; file: string }>): void {
    const pod = this.pods.get(machine);
    for (const f of files) if (pod?.get(keyOf(f.folder, f.file))?.state === "ready") pod.delete(keyOf(f.folder, f.file));
    for (const e of pod?.values() ?? []) {
      if (e.state !== "failed" || !(NO_ROOM.test(e.error ?? "") || DISK_FULL.test(e.error ?? ""))) continue;
      e.state = "next";
      e.bytes = 0;
      delete e.error;
      delete e.downloadId;
      e.roomTried = false;
    }
    const d = this.disks.get(machine);
    if (d) this.disks.set(machine, { ...d, at: 0 });
    this.d.settled?.(machine, true);
    this.d.changed?.();
    void this.tick();
  }

  /** The pod is gone (terminated, stopped, removed): what it was getting is stopped and forgotten. */
  forget(machine: string): void {
    const pod = this.pods.get(machine);
    if (!pod) return;
    for (const e of pod.values()) {
      if (e.downloadId && e.state === "fetching") this.d.downloads.stop(e.downloadId);
      e.upload?.abort();
    }
    this.pods.delete(machine);
    this.disks.delete(machine);
    this.packs.forget(machine);
    clearTimeout(this.landings.get(machine));
    this.landings.delete(machine);
    this.d.changed?.();
  }

  /** Follow what is under way and start what may start, on every pod. Called every second, and at once on a change. */
  tick(): Promise<void> {
    // one pass at a time: a slow site's answer is not asked for twice
    this.ticking ??= this.pass().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private viewOf(e: Entry): PodFileView {
    const { file, folder, state, tier, bytes, total, via, error, jobs } = e;
    return { file, folder, state, tier, bytes, total, ...(via ? { via } : {}), ...(error ? { error } : {}), jobs: [...jobs] };
  }

  private ordered(machine: string): Entry[] {
    return [...(this.pods.get(machine)?.values() ?? [])].sort((a, b) => a.needAt - b.needAt);
  }

  private async pass(): Promise<void> {
    let changed = false;
    for (const machine of [...new Set([...this.pods.keys(), ...this.packs.machines()])]) {
      // a pod stopped or gone: its container's files went with it (a volume's stay, and its scan says so at its next start).
      // One RunPod read without it is not that (its list can come back short): what was under way would start again from
      // nothing, the uploads cut, the files left out at its deploy asked for again
      if (this.d.gone?.(machine) ?? !this.d.alive(machine)) {
        this.forget(machine);
        continue;
      }
      // not up now (being stopped, or one read without it): nothing moves, and nothing is forgotten
      if (!this.d.alive(machine)) continue;
      for (const e of this.ordered(machine)) if (e.state === "fetching" && e.downloadId && this.follow(machine, e)) changed = true;
      // its ComfyUI restarts for node packs: nothing starts until it is back
      if (this.packs.restartingNow(machine)) continue;
      const under = this.ordered(machine).filter((e) => e.state === "fetching");
      let downloads = under.filter((e) => e.via !== "upload").length;
      let uploads = under.filter((e) => e.via === "upload").length;
      const now = Date.now();
      // a file a job waits for never waits behind files ahead: one of those gives it its place (and starts again later)
      const needed = this.ordered(machine).some((o) => o.tier === "need" && o.state === "next" && o.via !== "upload" && (o.notBefore ?? 0) <= now);
      if (needed && downloads >= DOWNLOADS_AT_ONCE) {
        const ahead = under.filter((o) => o.tier === "ahead" && o.via !== "upload").pop();
        if (ahead) {
          this.requeue(ahead);
          downloads--;
          changed = true;
        }
      }
      for (const e of this.ordered(machine)) {
        if (e.state !== "next" || (e.notBefore ?? 0) > now) continue;
        // a file ahead takes only what the line has left once every file a job waits for has started
        if (e.tier === "ahead" && this.ordered(machine).some((o) => o.tier === "need" && o.state === "next")) continue;
        if (e.source === undefined) {
          e.source = await this.sourceOf(e, true);
          if (e.source) e.via = measureKind(e.source);
        }
        if (!e.source) {
          await this.failUnlessThere(machine, e, "no site is known for it, and this computer's ComfyUI has no copy to send");
          changed = true;
          continue;
        }
        // asked again: a file a job waits for may have been asked for while this one's source was looked up
        if (e.tier === "ahead" && this.ordered(machine).some((o) => o.tier === "need" && o.state === "next")) continue;
        if (e.via === "upload" ? uploads >= UPLOADS_AT_ONCE : downloads >= DOWNLOADS_AT_ONCE) continue;
        // its size known before it starts: the pack is told it (and refuses what does not fit), and it is held against the disk
        if (!e.total) {
          const size = await this.sizeOf(e, e.source);
          if (size !== ASSUMED_BYTES) e.total = size;
        }
        if (e.total) {
          // a file for later deletes nothing to come: left out quietly, and asked again if a job comes to need it
          const full = await this.roomFor(machine, e.total, e, e.tier === "need");
          if (full && e.tier === "ahead") {
            this.pods.get(machine)?.delete(keyOf(e.folder, e.file));
            changed = true;
            continue;
          }
          if (full) {
            this.fail(machine, e, full);
            changed = true;
            continue;
          }
        }
        if (e.via === "upload") uploads++;
        else downloads++;
        e.state = "fetching";
        changed = true;
        void this.begin(machine, e);
      }
    }
    // the node packs: installs followed, ComfyUI restarted once they are in and nothing renders there
    for (const machine of this.packs.machines()) {
      if (!this.d.alive(machine)) continue;
      const r = await this.packs.pass(machine).catch(() => ({ changed: false, loaded: false }));
      if (r.changed) changed = true;
      // its restart forgot what was known of it already (podPacks.ts followRestart)
      if (r.loaded) this.d.settled?.(machine, false);
    }
    if (changed) this.d.changed?.();
  }

  /** How a download goes, from the download list: true when its state changed. */
  private follow(machine: string, e: Entry): boolean {
    const v = this.d.downloads.get(e.downloadId!);
    if (!v) return this.fail(machine, e, "its download was lost: Afflatus was restarted, or it was taken off the list");
    // whole on the pod once the pack is done with it (ComfyUI listing it comes a moment after): its speed ends there
    if (v.status === "saving" || v.status === "done") e.wholeAt ??= Date.now();
    // waiting its turn at the pack (its line full, a 429 waited out in downloads.ts): its clock starts once the pack takes
    // it, or the wait is kept as fetch time and lowers the speed measured on that cloud (deployOverhead, the hunt's pick)
    if (v.status === "starting" && v.waiting) {
      e.flowingAt = Date.now();
      e.movedAt = e.flowingAt;
    }
    const moved = v.bytes !== e.bytes || (v.total || e.total) !== e.total;
    this.moved(e, v.bytes);
    e.bytes = v.bytes;
    if (v.total) e.total = v.total;
    if (v.status === "done") {
      void this.ready(machine, e);
      return true;
    }
    // the pack has a file of that name, or is getting one: its own list says which
    if (v.status === "error" && THERE.test(v.error ?? "")) {
      e.state = "fetching";
      delete e.downloadId;
      void this.confirmThere(machine, e);
      return true;
    }
    // the disk filled up under it (or the pack refused it for want of room): never tried again as it is
    const full = [v.status === "error" ? v.error : null, v.note].find((x) => x && DISK_FULL.test(x));
    if (full) {
      if (v.status !== "error") this.d.downloads.stop(e.downloadId!);
      return this.diskFull(machine, e, full);
    }
    if (v.status === "error" && PASSING.test(v.error ?? "")) return this.retryLater(machine, e, v.error!);
    if (v.status === "error" || v.status === "stopped") return this.fail(machine, e, v.error ?? "it was stopped");
    return moved;
  }

  private async begin(machine: string, e: Entry): Promise<void> {
    try {
      const comfy = await this.d.comfyOf(machine);
      if (!comfy) throw new Error("the pod's ComfyUI cannot be reached");
      const src = e.source!;
      if (src.kind === "upload") return await this.send(machine, comfy, e, src.path);
      const settings = await this.d.settings();
      // a family's own official file is no lookup, and a deploy or a queued job asked for it (the consent, as a Download
      // pressed on it is in fetchFile.ts): fetched whatever these say, so a fresh install's pod gets what its screens promise
      const official = src.kind === "url" && isOfficialFile(this.d.lookup.families(), { url: src.url, file: e.file });
      if (!official && !settings.downloadModels) throw new Error("downloading into ComfyUI is turned off (Settings › Models › Missing models)");
      if (!official && !settings.civitaiLookups) throw new Error("looking up models online is turned off, so Hugging Face and Civitai are not asked (Settings › Models)");
      const name = e.file.split(/[\\/]/).pop()!;
      let source: string;
      let headers: Record<string, string> | undefined;
      let total = e.total;
      if (src.kind === "civitai") {
        // a version found by this computer's copy's hash: its file of these bytes, not the one of the closest name
        const found = await civitaiVersion(src.version, src.pick ?? name, settings.civitaiKey, src.sha256);
        if (!found?.file.downloadUrl) throw new Error("Civitai lists no file of that version to download");
        source = found.file.downloadUrl;
        headers = settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined;
        total = Math.round((found.file.sizeKB ?? 0) * 1024) || total;
      } else {
        source = src.url;
        // a gated model's file is signed only for an account that accepted its terms: the user's token, to Hugging Face alone
        if (settings.huggingFaceToken && /^https:\/\/(huggingface\.co|hf\.co)\//i.test(source)) headers = { Authorization: `Bearer ${settings.huggingFaceToken}` };
      }
      // its clock starts as it is asked for: a pod's two at a time start at once, and a fast file is done before the next look
      e.flowingAt = Date.now();
      e.movedAt = e.flowingAt;
      e.movedBytes = 0;
      if (!this.current(machine, e)) return;
      const started = await this.d.downloads.start(comfy, "", { file: e.file, folder: e.folder, title: name, source, ...(headers ? { headers } : {}), ...(total ? { total } : {}), machine, directOnly: true, filesRead: true, ...((e.tries ?? 0) + 1 < TRIES ? { quietPassing: true } : {}) });
      // the pod forgotten (stopped, gone) while its download was asked for: stopped, not left running for nothing
      if (!this.current(machine, e) || e.state !== "fetching") {
        this.d.downloads.stop(started.id);
        return;
      }
      e.downloadId = started.id;
      if (started.total) e.total = started.total;
    } catch (err) {
      if (!this.current(machine, e)) return;
      const message = (err as Error).message;
      if (THERE.test(message)) await this.confirmThere(machine, e);
      else if (DISK_FULL.test(message)) this.diskFull(machine, e, message);
      else if (PASSING.test(message)) this.retryLater(machine, e, message);
      else await this.failUnlessThere(machine, e, message);
      this.d.changed?.();
    }
  }

  /** A file only this computer has, sent to the pod. */
  private async send(machine: string, comfy: Comfy, e: Entry, path: string): Promise<void> {
    const version = await comfy.client.packVersion().catch(() => null);
    // no answer is a moment of the pod's (asked again later); an answer of an older pack is for good
    if (!version) throw new Error("the pod's ComfyUI did not answer");
    if (olderThan(version, PACK_UPLOADS)) throw new Error(`the pod's Afflatus node pack takes no upload before ${PACK_UPLOADS}`);
    const stop = new AbortController();
    e.upload = stop;
    e.flowingAt = Date.now();
    e.movedAt = e.flowingAt;
    e.movedBytes = 0;
    try {
      await uploadFile({
        client: comfy.client, path, folder: e.folder, file: e.file, signal: stop.signal, backoffMs: this.uploadBackoffMs,
        onBytes: (bytes, total) => {
          this.moved(e, bytes);
          e.bytes = bytes;
          e.total = total;
          this.d.changed?.();
        },
      });
      if (this.current(machine, e)) await this.ready(machine, e);
    } catch (err) {
      const message = (err as Error).message;
      if (stop.signal.aborted || !this.current(machine, e)) return;
      if (THERE.test(message)) await this.confirmThere(machine, e);
      else if (DISK_FULL.test(message)) this.diskFull(machine, e, message);
      else if (PASSING.test(message)) this.retryLater(machine, e, message);
      else await this.failUnlessThere(machine, e, message);
    } finally {
      delete e.upload;
      void this.tick();
    }
  }

  /** Its file is on the pod; its speed is kept (unless it was there already). */
  private async ready(machine: string, e: Entry, measured = true): Promise<void> {
    e.state = "ready";
    // one it brought (not one found there): the only kind Make room ever deletes
    if (measured) e.fetched = true;
    e.usedAt = Date.now();
    void this.disk(machine, 0);
    if (e.total) e.bytes = e.total;
    this.d.changed?.();
    this.landed(machine, e);
    if (measured && e.flowingAt && e.via) {
      const to = e.wholeAt ?? Date.now();
      const ms = to - e.flowingAt;
      await this.d.cloudOf(machine)
        .then((cloud) => recordMeasure(this.d.db, { kind: e.via!, cloud, bytes: e.total || e.bytes, ms }, this.measuredFrom))
        .catch((err: Error) => console.warn(`[pod files] a speed not kept: ${err.message}`));
      await recordFetch(this.d.db, { machine, file: e.file, folder: e.folder, via: e.via, bytes: e.total || e.bytes, from: e.flowingAt, to })
        .catch((err: Error) => console.warn(`[pod files] a fetch not kept: ${err.message}`));
    }
    void this.tick();
  }

  /**
   * A file that cannot be had from here (no source, lookups or downloads turned off, a refusal) may be on the pod already (a
   * volume that holds it): ready then, as the pod's own list says; failed otherwise.
   */
  private async failUnlessThere(machine: string, e: Entry, error: string): Promise<void> {
    const listed = await this.onPod(machine, e);
    if (!this.current(machine, e)) return;
    if (listed) await this.ready(machine, e, false);
    else this.fail(machine, e, error);
  }

  /**
   * The pod's disk had no room for it: once, when the pod makes room, it is put back in line (what it fetched and no job
   * needs is deleted before it starts again, roomFor); else it fails, and its jobs go elsewhere.
   */
  private diskFull(machine: string, e: Entry, why: string): true {
    void this.disk(machine, 0);
    if (e.tier === "need" && this.makes(machine) && !e.roomTried) {
      e.roomTried = true;
      e.state = "next";
      e.bytes = 0;
      delete e.downloadId;
      this.d.changed?.();
      return true;
    }
    const said = /^(the pod's disk|its volume) is full/.test(why) ? why : `${this.fullSaid(machine)} (${why.replace(/^.*?(the disk|no space)/i, "$1").slice(0, 200)})${this.makes(machine) ? "" : "; Make room is off"}`;
    return this.fail(machine, e, said);
  }

  private fail(machine: string, e: Entry, error: string): true {
    e.state = "failed";
    e.error = error;
    console.warn(`[pod files] ${e.file} (${e.folder}) failed on ${machine}: ${error}`);
    this.d.settled?.(machine, false);
    return true;
  }
}
