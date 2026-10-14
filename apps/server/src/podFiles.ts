import { fileName } from "./media";
import { civitaiVersion } from "./civitai";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import type { Downloads } from "./downloads";
import { recordMeasure } from "./podMeasures";
import { measureKind, podSource, type PodSource, type SourceLookup } from "./podSources";
import { PACK_UPLOADS, uploadFile } from "./podUpload";
import type { Settings } from "./settings";
import { olderThan } from "./version";

/**
 * The model files a rented pod is getting, per pod: what its waiting jobs need first, in the order the queue asked for
 * them, then the files asked for "ahead" (a model set's, a job's that went home this time) with what the line has left.
 * Each comes from its site straight onto the pod (the node pack's download, from the site's own link: the pod cannot reach
 * Afflatus), or, for a file no site is known for, is sent from this computer (podUpload.ts).
 *
 * The money rule: a file ahead never keeps a pod. It starts only while the pod has work (a job running there or waiting
 * for it); a pod with none goes idle on time and ends as its idle action says, whatever it was getting. A file that
 * cannot be had is said once and stays failed for that pod: its jobs go elsewhere (queue.ts).
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
}

export interface PodFilesDeps {
  db: Db;
  downloads: Downloads;
  /** The machine's ComfyUI, while there is one to reach. */
  comfyOf(machine: string): Promise<Comfy | null>;
  /** Whether the pod has work: a job running there or waiting for it. Files ahead start only then. */
  working(machine: string): boolean;
  /** Its cloud (RunPod's secure or community), for the speeds measured on it. */
  cloudOf(machine: string): Promise<string | null>;
  lookup: SourceLookup;
  settings(): Promise<Pick<Settings, "civitaiKey" | "downloadModels" | "civitaiLookups">>;
  /** Something changed: the pod's row says it. */
  changed?(): void;
}

/** How many of a pod's files come at once: two downloads share its line well, and one upload this computer's. */
const DOWNLOADS_AT_ONCE = 2;
const UPLOADS_AT_ONCE = 1;
/** What the node pack answers a download of a file it has already (downloads.py): the pod has it. */
const THERE = /\(409: that file is there already/;
const keyOf = (folder: string, file: string) => `${folder}|${fileName(file).toLowerCase()}`;

export class PodFiles {
  private readonly pods = new Map<string, Map<string, Entry>>();
  private seq = 0;
  private ticking: Promise<void> | null = null;
  /** The first wait before an upload's piece is sent again (shorter in tests). */
  uploadBackoffMs = 2000;

  constructor(private readonly d: PodFilesDeps) {}

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
    if (!mine.length) return null;
    const failed = mine.find((e) => e.state === "failed");
    const files = mine.map((e) => this.viewOf(e));
    if (failed) return { state: "failed", error: `${fileName(failed.file)}: ${failed.error ?? "it could not be had"}`, files };
    return { state: mine.every((e) => e.state === "ready") ? "ready" : "waiting", files };
  }

  /** Whether a file failed on that pod already (asking again would fail again): its reason. */
  failed(machine: string, folder: string, file: string): string | null {
    const e = this.pods.get(machine)?.get(keyOf(folder, file));
    return e?.state === "failed" ? e.error ?? "it could not be had" : null;
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
    for (const machine of [...this.pods.keys()]) {
      for (const e of this.ordered(machine)) if (e.state === "fetching" && e.downloadId && this.follow(machine, e)) changed = true;
      const under = this.ordered(machine).filter((e) => e.state === "fetching");
      let downloads = under.filter((e) => e.via !== "upload").length;
      let uploads = under.filter((e) => e.via === "upload").length;
      for (const e of this.ordered(machine)) {
        if (e.state !== "next") continue;
        // a file ahead takes only what the line has left, and only while the pod has work
        if (e.tier === "ahead" && (!this.d.working(machine) || this.ordered(machine).some((o) => o.tier === "need" && o.state === "next"))) continue;
        if (e.source === undefined) {
          e.source = await podSource(this.d.lookup, { file: e.file, folder: e.folder, ...(e.url ? { url: e.url } : {}), ...(e.civitai ? { civitai: e.civitai } : {}) }).catch(() => null);
          if (e.source) e.via = measureKind(e.source);
        }
        if (!e.source) {
          this.fail(e, "no site is known for it, and this computer's ComfyUI has no copy to send");
          changed = true;
          continue;
        }
        if (e.via === "upload" ? uploads >= UPLOADS_AT_ONCE : downloads >= DOWNLOADS_AT_ONCE) continue;
        if (e.via === "upload") uploads++;
        else downloads++;
        e.state = "fetching";
        changed = true;
        void this.begin(machine, e);
      }
    }
    if (changed) this.d.changed?.();
  }

  /** How a download goes, from the download list: true when its state changed. */
  private follow(machine: string, e: Entry): boolean {
    const v = this.d.downloads.get(e.downloadId!);
    if (!v) return this.fail(e, "its download was lost: Afflatus was restarted, or it was taken off the list");
    if (v.status === "downloading" && !e.flowingAt) e.flowingAt = Date.now();
    const moved = v.bytes !== e.bytes || (v.total || e.total) !== e.total;
    e.bytes = v.bytes;
    if (v.total) e.total = v.total;
    if (v.status === "done") {
      void this.ready(machine, e);
      return true;
    }
    // the pack has a file of that name already: the pod has it
    if (v.status === "error" && THERE.test(v.error ?? "")) {
      void this.ready(machine, e, false);
      return true;
    }
    if (v.status === "error" || v.status === "stopped") return this.fail(e, v.error ?? "it was stopped");
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
        const found = await civitaiVersion(src.version, src.pick ?? name, settings.civitaiKey);
        if (!found?.file.downloadUrl) throw new Error("Civitai lists no file of that version to download");
        source = found.file.downloadUrl;
        headers = settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined;
        total = Math.round((found.file.sizeKB ?? 0) * 1024) || total;
      } else source = src.url;
      const started = await this.d.downloads.start(comfy, "", { file: e.file, folder: e.folder, title: name, source, ...(headers ? { headers } : {}), ...(total ? { total } : {}), machine, directOnly: true });
      e.downloadId = started.id;
      if (started.total) e.total = started.total;
    } catch (err) {
      const message = (err as Error).message;
      if (THERE.test(message)) await this.ready(machine, e, false);
      else this.fail(e, message);
      this.d.changed?.();
    }
  }

  /** A file only this computer has, sent to the pod. */
  private async send(machine: string, comfy: Comfy, e: Entry, path: string): Promise<void> {
    const version = await comfy.client.packVersion().catch(() => null);
    if (!version || olderThan(version, PACK_UPLOADS)) throw new Error(`the pod's Afflatus node pack takes no upload before ${PACK_UPLOADS}`);
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
      await this.ready(machine, e);
    } catch (err) {
      if (!stop.signal.aborted) this.fail(e, (err as Error).message);
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
    if (measured && e.flowingAt && e.via) {
      await recordMeasure(this.d.db, { kind: e.via, cloud: await this.d.cloudOf(machine), bytes: e.total || e.bytes, ms: Date.now() - e.flowingAt }).catch(() => {});
    }
    void this.tick();
  }

  private fail(e: Entry, error: string): true {
    e.state = "failed";
    e.error = error;
    console.warn(`[pod files] ${e.file} (${e.folder}) failed: ${error}`);
    return true;
  }
}
