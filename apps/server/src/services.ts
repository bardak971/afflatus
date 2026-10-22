import { lockMachine } from "./lock-api";
import { Rented } from "./rented";
import { Comfy, NO_COMFY_URL, type MachineComfy } from "./comfy";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Db, DbKind } from "./db";
import type { LibraryChange } from "./events";
import { Downloads } from "./downloads";
import { ModelHashes } from "./modelHashes";
import { PodFiles } from "./podFiles";
import { PodOutside } from "./podOutside";
import { presetsWithFiles } from "./presetFiles";
import { ShippedPresets, shippedPresetsDir } from "./presetFiles";
import { DEFAULT_QUEUE_OPTIONS, Queue, type QueueOptions } from "./queue";
import { podFetchOf } from "./queuePlan";
import { Registry } from "./registry";
import { readSettings, type Machine } from "./settings";
import { Linked, RoutedStorage } from "./linked";
import { fillKeptBytes } from "./media";
import type { Storage } from "./storage";
import { keepOf, sweep } from "./sweep";
import { fold } from "./renders";
import type { InfoLookup } from "@afflatus/comfy";
import type { ModelInfo } from "@afflatus/core";
import { readJson } from "./queueModel";
import { Timelines } from "./timelines";
import { sweepIdleDrafts } from "./drafts";
import { Updates } from "./modelUpdates";
import { Precompute, type PrecomputeOptions } from "./precompute";
import { Notify } from "./notify";
import { Access } from "./access";
import { Hunt } from "./hunt";
import { OfficialSizes } from "./officialSizes";

/** Everything the routes need, built once at start (and once per test). */
export interface Services {
  db: Db;
  dbKind: DbKind;
  storage: Storage;
  /** Folders linked to a directory of the disk. */
  linked: Linked;
  /** The built-in recipes and the imported workflows. */
  registry: Registry;
  /** The first ComfyUI of the settings: the one the setup, downloads, node packs and "open in ComfyUI" talk to. A new one is made when its address changes. */
  comfy(): Promise<Comfy>;
  /** Every ComfyUI of the settings, the first first, each with its client (made again when its address changes). */
  machines(): Promise<MachineComfy[]>;
  /** The ComfyUI of this machine id; the first one for an id that is gone. */
  comfyOf(id: string | null | undefined): Promise<Comfy>;
  queue: Queue;
  timelines: Timelines;
  /** Model files being fetched into ComfyUI. */
  downloads: Downloads;
  /** Rented machines: pods on RunPod, read, started and stopped (rented.ts). */
  rented: Rented;
  /** What the user is told of on Telegram, Discord and in the browser (notify.ts). */
  notify: Notify;
  /** The optional password: the sessions, the limits, the reset codes (access.ts). */
  access: Access;
  /** The GPU hunt: a rented GPU deployed the moment one the user wants is free (hunt.ts). */
  hunt: Hunt;
  /** The model files rented pods are getting (podFiles.ts). */
  podFiles: PodFiles;
  /** The pods' time at work from outside Afflatus, for Queue › Costs (podOutside.ts). */
  podOutside: PodOutside;
  /** The presets that ship with Afflatus (the repository's `presets/` folder). */
  shippedPresets: ShippedPresets;
  /** Newer versions of the model files on Civitai. */
  updates: Updates;
  /** How large the families' official files are, by address (officialSizes.ts). */
  officialSizes: OfficialSizes;
  /** Every model file of this computer hashed once, and which site has it (modelHashes.ts). */
  hashes: ModelHashes;
  /** The first sweep done, which runs in the background from the start (the tests wait for it, so that it does not sweep what they set up). */
  started: Promise<void>;
  /** What the timeline editor reads of its clips, measured in the background once stored (null: off, as in most tests). */
  precompute: Precompute | null;
  close(): Promise<void>;
}

export async function createServices(
  db: Db, dbKind: DbKind, own: Storage, queueOptions: QueueOptions = DEFAULT_QUEUE_OPTIONS,
  /** Where the shipped presets are read from: the repository's folder (or PRESETS_DIR) unless said otherwise; null for none. And the data folder, where the downloads' state file is kept between runs. */
  dirs: { shippedPresets?: string | null; dataDir?: string; precompute?: PrecomputeOptions | false } = {},
): Promise<Services> {
  // Afflatus's own files and the files of linked folders are read through the same door
  const storage = new RoutedStorage(own);
  const registry = new Registry(db);
  /** One client per machine id, made again when that machine's address changes; a machine taken out of the settings is closed. */
  const pool = new Map<string, Comfy>();
  registry.onChange = () => pool.forEach((c) => c.forgetScan());
  await registry.load();
  // what was read off the model files, parsed once: read again after something is written to it (a "models" event)
  let info: Promise<InfoLookup> | null = null;
  const infoOf = (): Promise<InfoLookup> => {
    info ??= (async () => {
      const rows = await db.selectFrom("model_info").select(["folder", "file", "info"]).execute();
      const known = new Map(rows.map((r) => [`${r.folder}/${r.file}`, readJson<ModelInfo>(r.info, {})]));
      return (folder: string, file: string) => known.get(`${folder}/${file}`);
    })();
    info.catch(() => {
      info = null;
    });
    return info;
  };
  const clientOf = (m: Machine): Comfy => {
    let c = pool.get(m.id);
    if (c?.url !== m.url) {
      c?.close();
      c = new Comfy(m.url, registry, m.token);
      c.overrides = async () => (await readSettings(db)).slotFiles;
      c.infoOf = infoOf;
      // every step's live preview kept, only while data/keep-previews exists: what the swap judge is measured on
      // (HANDOVER-swap-motion.md's sibling plan, 2026-10-19), never on in normal use
      if (dirs.dataDir) c.monitor.onStepPreview = keepPreview(join(dirs.dataDir, "keep-previews"));
      pool.set(m.id, c);
    }
    // a token set, renewed or taken off goes with the next call; an open socket stays open (the lock let it in)
    c.client.token = m.token;
    // a machine of this PC's has its GPU's power read, for its renders' electricity; a rented pod is billed by the hour
    c.home = !m.rented;
    return c;
  };
  const machines = async (): Promise<MachineComfy[]> => {
    const s = await readSettings(db);
    for (const [id, c] of pool) {
      if (s.machines.some((m) => m.id === id)) continue;
      c.close();
      pool.delete(id);
    }
    return s.machines.map((machine) => ({ machine, comfy: clientOf(machine) }));
  };
  // with no machine at all (a new install before its first launch, a rented-only one with no pod), what asks "the first
  // ComfyUI" (a node list, a model folder) is given one at an address nothing listens on: it is told ComfyUI does not
  // answer, as with one that is off, and never reaches a ComfyUI the user did not add (one on 8188 they chose not to use)
  let nowhere: Comfy | null = null;
  const firstOf = (all: MachineComfy[]) => all[0]?.comfy ?? (nowhere ??= new Comfy(NO_COMFY_URL, registry));
  const comfy = async () => firstOf(await machines());
  const comfyOf = async (id: string | null | undefined) => {
    const all = await machines();
    return all.find((x) => x.machine.id === id)?.comfy ?? firstOf(all);
  };
  const queue = new Queue(db, storage, machines, registry, queueOptions);
  queue.events.on("models", () => {
    info = null;
  });
  // a rented pod that is not running takes no work, and its row says what it is and costs
  const rented = new Rented(db, queue, queue.events, async (id) => (await machines()).find((m) => m.machine.id === id)?.comfy ?? null);
  queue.unavailable = (id) => rented.unavailable(id);
  queue.fitsBalance = (ms) => rented.fitsBalance(ms);
  queue.balanceNeed = (machine, recipeId, renderMs, fetchMs) => rented.balanceNeed(machine, recipeId, renderMs, fetchMs);
  // a pod up and not locked is locked (its address is public)
  rented.lockPod = (id) => lockMachine({ db, queue, machines }, id, { local: false, renew: false });
  // a pod's time at work queued in its ComfyUI from outside Afflatus, kept for Queue › Costs: used, not idle
  const podOutside = new PodOutside(db);
  queue.onOutside = (id, outside) => podOutside.note(id, outside);
  rented.outsideTimed = (id) => podOutside.timing(id);
  rented.run();
  // a render's end, a pod stopped, a cap: told where the user asked (notify.ts), never in the way of what it is about
  const notify = new Notify({ db, storage, registry, events: queue.events, stillFor: () => queue.stillFor(), batchCost: (from, to, notBefore) => rented.batchCost(from, to, notBefore) });
  queue.tell = rented.tell = (kind, notice) => notify.say(kind, notice);
  // a pod's ComfyUI found started again without its render (an older image's death): the pod is terminated as a crash
  queue.podCrashed = (id, why) => rented.podCrashed(id, why);
  // a render lost on a deployed pod: its death asked of the pod before it goes again (a crash seen late was run again elsewhere)
  queue.diedLate = (id) => rented.diedLate(id);
  notify.watch();
  // the reset codes and the sign-ins go to the data folder's log file as well as the console (none in the tests)
  const access = new Access(db, notify, { logFile: dirs.dataDir ? join(dirs.dataDir, "logs", "afflatus.log") : undefined });
  const timelines = new Timelines(db, storage, registry, queue.events);
  queue.clips = timelines;
  const precompute = dirs.precompute === false ? null : new Precompute(db, timelines.media, dirs.precompute);
  // a linked file that changed on the disk: what the timelines derived from it (strips, motion, scenes) goes too
  const linked = new Linked(db, storage, queue.events, timelines);
  await linked.load();
  // what changed in the linked directories while Afflatus was not running: read in the background
  void linked.scanAll();
  // unkept results to the bin after a day, the bin emptied after a week, drafts left empty thrown away: checked at start and every hour
  const runSweep = () =>
    readSettings(db).then((s) => sweep(db, storage, Date.now(), keepOf(s)))
      // what went to the bin, or only out of it for good
      .then((r) => (r.binned || r.erased) && queue.events.emit("library", { change: r.binned ? "binned" : "erased" } satisfies LibraryChange))
      .then(() => sweepIdleDrafts(db, registry))
      // the times of renders older than they are kept one by one become figures per model and day
      .then(async () => fold(db, (await readSettings(db)).renderHistoryDays))
      .catch((err) => console.warn("[sweep]", (err as Error).message));
  // what the items made before 0075_kept_bytes keep beside their file, counted in their sizes: read once, in the background
  void fillKeptBytes(db, storage).catch((err) => console.warn("[kept bytes]", (err as Error).message));
  const sweeper = setInterval(runSweep, 60 * 60_000);
  sweeper.unref();
  const swept = runSweep();
  const downloads = new Downloads(queue.events, dirs.dataDir ? join(dirs.dataDir, "downloads.json") : undefined);
  // the node packs renders ask for are installed by each ComfyUI's Manager: one without it does without them (queuePacks.ts);
  // one that did not answer is not known to lack it (null), and its jobs wait for a real answer
  queue.managerOf = async (comfy) => {
    const m = await downloads.manager(comfy);
    return m.unknown ? null : m.found;
  };
  // and a restart for them waits for the downloads that run in that ComfyUI's process
  queue.downloadingIn = (comfy) => downloads.runsIn(comfy);
  const shippedPresets = new ShippedPresets(dirs.shippedPresets === undefined ? shippedPresetsDir() : dirs.shippedPresets);
  const machineOf = async (id: string) => (await machines()).find((m) => m.machine.id === id);
  let podFilesTold: NodeJS.Timeout | null = null;
  const podFiles = new PodFiles({
    db, downloads,
    comfyOf: async (id) => (await machineOf(id))?.comfy ?? null,
    cloudOf: async (id) => (await machineOf(id))?.machine.rented?.cloud ?? null,
    lookup: { db, presets: () => presetsWithFiles({ db, shippedPresets }), families: () => registry.families(), comfyDir: async () => (await readSettings(db)).comfyDir },
    settings: () => readSettings(db),
    // its pod up: a pod filling its volume takes no render, but gets its files
    alive: (id) => rented.podDown(id) === null,
    gone: (id) => rented.podGone(id),
    // its ComfyUI is not restarted under work from outside Afflatus either (its own page's): that would be lost with it
    busy: (id) => queue.busyOn(id),
    makesRoom: async (id) => Boolean((await machineOf(id))?.machine.rented?.makeRoom),
    onVolume: async (id) => Boolean((await machineOf(id))?.machine.rented?.volume),
    // a file there now, or one that failed: the pod's folders and its node list (whose choices name the files) are read
    // again, and its jobs looked at again
    settled: (id) => {
      void machineOf(id).then((m) => {
        m?.comfy.forgetAll();
        queue.nudge();
      });
    },
    // the pods' rows are in the queue's view (rentedOf): a file's progress is said as the queue is, every 2 s at most
    changed: () => {
      if (podFilesTold) return;
      podFilesTold = setTimeout(() => {
        podFilesTold = null;
        queue.events.emit("queue");
      }, 2000);
      podFilesTold.unref();
    },
  });
  queue.podFetch = podFetchOf(podFiles);
  // a pod's row says the files it is getting
  queue.rentedOf = (m) => {
    const row = rented.view(m);
    return row ? { ...row, files: podFiles.view(m.id), packs: podFiles.packsView(m.id), disk: podFiles.diskOf(m.id) } : null;
  };
  // a ComfyUI of its own's row says the model files downloading into it (a set's Fill, a missing model's Download), as a
  // pod's are said: it is getting files, not idle
  const UNDER_WAY = new Set(["starting", "downloading", "saving"]);
  queue.downloadsOf = (m, first) =>
    downloads.list().filter((d) => UNDER_WAY.has(d.status) && (d.machine ? d.machine === m.id : first)).map((d) => ({
      file: d.file, folder: d.folder, state: d.status === "starting" ? "next" : "fetching", tier: "ahead", bytes: d.bytes, total: d.total, jobs: [],
    }));
  // their progress said as the queue is, every 2 s at most (a pod's come through podFiles' own)
  let downloadsTold: NodeJS.Timeout | null = null;
  queue.events.on("downloads", () => {
    if (downloadsTold) return;
    downloadsTold = setTimeout(() => {
      downloadsTold = null;
      queue.events.emit("queue");
    }, 2000);
    downloadsTold.unref();
  });
  // a deployed pod up: the files its deploy asked for come after what its jobs wait for; the ones left out never come
  rented.forgetFiles = (id) => podFiles.forget(id);
  rented.filesLeft = (id) => {
    const files = podFiles.view(id);
    const waiting = files.filter((f) => f.state === "next" || f.state === "fetching");
    return { left: waiting.length, total: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), waiting: waiting.map((f) => f.file), failed: files.filter((f) => f.state === "failed").map((f) => ({ file: f.file, error: f.error ?? "failed" })) };
  };
  rented.onUp = (id, files, leaveOut) => {
    podFiles.leaveOut(id, leaveOut);
    podFiles.want(id, files.map(({ file, folder, url, civitai, size }) => ({ file, folder, ...(url ? { url } : {}), ...(civitai ? { civitai } : {}), ...(size ? { size } : {}) })), { tier: "ahead" });
  };
  // what pods are getting is followed every second, while any is
  const podFilesTimer = setInterval(() => void podFiles.tick().catch((err) => console.warn("[pod files]", (err as Error).message)), 1000);
  podFilesTimer.unref();
  const services: Services = {
    db, dbKind, storage, linked, registry, comfy, machines, comfyOf, queue, timelines, rented, notify, access, podFiles, podOutside, downloads,
    shippedPresets,
    officialSizes: new OfficialSizes(db, () => registry.families(), async () => (await readSettings(db)).civitaiLookups),
    updates: null as unknown as Updates,
    hashes: null as unknown as ModelHashes,
    hunt: null as unknown as Hunt,
    started: swept.then(() => undefined),
    precompute,
    async close() {
      services.hunt.stop();
      clearInterval(sweeper);
      clearInterval(podFilesTimer);
      rented.stop();
      notify.stop();
      access.stop();
      await precompute?.stop();
      // a hash pass under way (a checkpoint read in full takes a minute) ends before the database closes under it
      clearTimeout(firstHashes);
      clearInterval(checker);
      await services.hashes.stop();
      queue.stop();
      await queue.idle();
      await podOutside.settled();
      pool.forEach((c) => c.close());
      await db.destroy();
    },
  };
  services.updates = new Updates(services);
  // a hunt kept from before carries on; its notices go where the others do, its summary with the queue's status
  services.hunt = new Hunt(services);
  services.hunt.tell = (kind, notice) => notify.say(kind, notice);
  queue.huntOf = (held) => services.hunt.summary(held);
  await services.hunt.run();
  // every model file hashed once, a minute after the start (and on "Hash now"), waiting while this computer renders
  services.hashes = new ModelHashes(services);
  // work queued in its ComfyUI from outside Afflatus holds the disk as a render of Afflatus's does
  services.hashes.runningOn = (id) => queue.busyOn(id);
  const firstHashes = setTimeout(() => void services.hashes.run(), 60_000);
  firstHashes.unref();
  // the daily check for newer model versions rides on the hourly sweep: it only runs when the user asked for it. What
  // goes wrong is logged and kept on the report (daily), never thrown at a timer
  const daily = () => void services.updates.daily().catch((err) => console.warn("[updates]", (err as Error).message));
  // the hashing rides on it too: a file added or replaced since the last pass is hashed and matched within the hour, not
  // at the next start (a pass that finds nothing changed only lists the folders; it waits while this computer renders)
  const checker = setInterval(() => {
    daily();
    void services.hashes.run();
  }, 60 * 60_000);
  checker.unref();
  const firstCheck = setTimeout(daily, 30_000);
  firstCheck.unref();
  const closeBefore = services.close;
  services.close = async () => {
    clearInterval(checker);
    clearTimeout(firstCheck);
    clearTimeout(firstHashes);
    await closeBefore();
  };
  return services;
}

/**
 * Each step's live preview written to `dir/<prompt id>/step-<n>-sigma-<s>.<ext>`, while `dir` exists (made by hand for a
 * measuring series, removed after): the swap judge's material. Best effort, never in a render's way.
 */
function keepPreview(dir: string) {
  return (promptId: string, at: { step: number; steps: number; sigma: number | null }, bytes: Uint8Array, mime: string): void => {
    if (!existsSync(dir)) return;
    const ext = mime === "video/mp4" ? "mp4" : mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : "jpg";
    const name = `step-${String(at.step).padStart(2, "0")}-of-${at.steps}-sigma-${at.sigma === null ? "x" : at.sigma.toFixed(3)}.${ext}`;
    void mkdir(join(dir, promptId), { recursive: true }).then(() => writeFile(join(dir, promptId, name), bytes)).catch(() => {});
  };
}
