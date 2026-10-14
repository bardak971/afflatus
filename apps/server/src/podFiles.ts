import { fileName } from "./media";
import { civitaiVersion } from "./civitai";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import type { Downloads } from "./downloads";
import { stat } from "node:fs/promises";
import { MEASURED_FROM, measuredRange, recordMeasure, type MeasureKind, type Range } from "./podMeasures";
import { localCopy, measureKind, podSource, type PodSource, type SourceLookup } from "./podSources";
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
 * The money rule: a download is never work. Files ahead come in the time the pod is billed for anyway (after what a job
 * waits for), and a pod with nothing to render goes idle on time and ends as its idle action says, whatever it was still
 * getting (with a volume, what came stays for the next deploy). A file that cannot be had is said once and stays failed
 * for that pod: its jobs go elsewhere (queue.ts).
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
  /** When all of it was on the pod (the pack had it whole), for its speed. */
  wholeAt?: number;
  /** Put back in line after a passing failure (ComfyUI not answering, its line full): how many times, and not before when. */
  tries?: number;
  notBefore?: number;
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
  /** Whether the machine's pod runs now: what a pod no longer running was getting is forgotten (its container went with it). */
  alive(machine: string): boolean;
  /** Whether a job runs on the machine now: its ComfyUI is not restarted under a render (podPacks.ts). */
  busy(machine: string): boolean;
  /** Something changed: the pod's row says it. */
  changed?(): void;
  /** A file came to a pod, or failed there: what lists the pod's files is read again, and the queue looks at its jobs again. */
  settled?(machine: string): void;
}

/**
 * What the queue plans with before a source was ever measured: the slow end of what is usual, bytes a second (a pod's
 * line to Hugging Face and Civitai, this computer's upload). Never said to the user: a speed is said only once measured.
 */
const ASSUMED: Record<Exclude<MeasureKind, "boot">, number> = { hf: 30 * 2 ** 20, civitai: 20 * 2 ** 20, url: 20 * 2 ** 20, upload: 3 * 2 ** 20 };
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
/** A failure that passes (ComfyUI not answering for a moment, restarting, its line full): the file is asked again later. */
const PASSING = /not answering|cannot be reached|no longer knows the download|did not answer|does not answer with|\((429|5\d\d)[:)]|fetch failed|ECONN|socket|timed? ?out|aborted/i;
/** How many times a passing failure puts a file back in line before it is failed, and the first wait (doubled each time). */
const TRIES = 4;
const RETRY_MS = 15_000;
const keyOf = (folder: string, file: string) => `${folder}|${fileName(file).toLowerCase()}`;

export class PodFiles {
  private readonly pods = new Map<string, Map<string, Entry>>();
  private seq = 0;
  private ticking: Promise<void> | null = null;
  /** A file smaller than this is not measured (podMeasures.ts MEASURED_FROM; smaller in tests). */
  measuredFrom = MEASURED_FROM;
  /** The first wait before an upload's piece is sent again (shorter in tests). */
  uploadBackoffMs = 2000;

  /** The node packs pods get for their jobs, beside the files. */
  private readonly packs: PodPacks;

  constructor(private readonly d: PodFilesDeps) {
    this.packs = new PodPacks({ comfyOf: d.comfyOf, busy: d.busy, beforeRestart: (m) => this.requeueFetching(m) });
  }

  /** No job may start on the machine: its node packs wait for its ComfyUI to restart, or it restarts now. */
  holding(machine: string): boolean {
    return this.packs.holding(machine);
  }

  /** How long a file put back in line after a passing failure waits before it is asked again (shorter in tests). */
  retryMs = RETRY_MS;

  /** Everything the pod is getting put back in line: its ComfyUI restarts, and its downloads and uploads live in its process. */
  private requeueFetching(machine: string): void {
    for (const e of this.pods.get(machine)?.values() ?? []) if (e.state === "fetching") this.requeue(e);
  }

  /** A file under way stopped and put back in line, as it was before it started. */
  private requeue(e: Entry): void {
    if (e.downloadId) this.d.downloads.stop(e.downloadId);
    e.upload?.abort();
    e.state = "next";
    e.bytes = 0;
    delete e.downloadId;
    delete e.flowingAt;
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

  /** Whether the pod's own list of the folder has the file; null when its ComfyUI does not answer. */
  private async onPod(machine: string, e: Entry): Promise<boolean | null> {
    const comfy = await this.d.comfyOf(machine);
    return (await comfy?.client.models(e.folder).then((files) => files.some((f) => fileName(f) === fileName(e.file)), () => null)) ?? null;
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

  /** Files for a pod: "need" (a job waits for them, `job` when given) comes before "ahead"; a file ahead asked as needed moves up. */
  want(machine: string, files: PodFileWant[], o: { tier: "need" | "ahead"; job?: string }): void {
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
      if (o.job && !e.jobs.includes(o.job)) {
        e.jobs.push(o.job);
        changed = true;
      }
    }
    if (changed) {
      this.d.changed?.();
      void this.tick();
    }
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
      ms += (left / (range?.low ?? ASSUMED[kind])) * 1000;
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
    for (const p of await this.d.lookup.presets().catch(() => [])) {
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

  /** The pod is gone (terminated, stopped, removed): what it was getting is stopped and forgotten. */
  forget(machine: string): void {
    const pod = this.pods.get(machine);
    if (!pod) return;
    for (const e of pod.values()) {
      if (e.downloadId && e.state === "fetching") this.d.downloads.stop(e.downloadId);
      e.upload?.abort();
    }
    this.pods.delete(machine);
    this.packs.forget(machine);
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
      // a pod stopped or gone: its container's files went with it (a volume's stay, and its scan says so at its next start)
      if (!this.d.alive(machine)) {
        this.forget(machine);
        continue;
      }
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
      if (r.loaded) this.d.settled?.(machine);
    }
    if (changed) this.d.changed?.();
  }

  /** How a download goes, from the download list: true when its state changed. */
  private follow(machine: string, e: Entry): boolean {
    const v = this.d.downloads.get(e.downloadId!);
    if (!v) return this.fail(machine, e, "its download was lost: Afflatus was restarted, or it was taken off the list");
    // whole on the pod once the pack is done with it (ComfyUI listing it comes a moment after): its speed ends there
    if (v.status === "saving" || v.status === "done") e.wholeAt ??= Date.now();
    const moved = v.bytes !== e.bytes || (v.total || e.total) !== e.total;
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
      if (!settings.downloadModels) throw new Error("downloading into ComfyUI is turned off (Settings › Models › Missing models)");
      if (!settings.civitaiLookups) throw new Error("looking up models online is turned off, so Hugging Face and Civitai are not asked (Settings › Models)");
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
      if (!this.current(machine, e)) return;
      const started = await this.d.downloads.start(comfy, "", { file: e.file, folder: e.folder, title: name, source, ...(headers ? { headers } : {}), ...(total ? { total } : {}), machine, directOnly: true });
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
    try {
      await uploadFile({
        client: comfy.client, path, folder: e.folder, file: e.file, signal: stop.signal, backoffMs: this.uploadBackoffMs,
        onBytes: (bytes, total) => {
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
    if (e.total) e.bytes = e.total;
    this.d.changed?.();
    this.d.settled?.(machine);
    if (measured && e.flowingAt && e.via) {
      const ms = (e.wholeAt ?? Date.now()) - e.flowingAt;
      await this.d.cloudOf(machine)
        .then((cloud) => recordMeasure(this.d.db, { kind: e.via!, cloud, bytes: e.total || e.bytes, ms }, this.measuredFrom))
        .catch((err: Error) => console.warn(`[pod files] a speed not kept: ${err.message}`));
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

  private fail(machine: string, e: Entry, error: string): true {
    e.state = "failed";
    e.error = error;
    console.warn(`[pod files] ${e.file} (${e.folder}) failed on ${machine}: ${error}`);
    this.d.settled?.(machine);
    return true;
  }
}
