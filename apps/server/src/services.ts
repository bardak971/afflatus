import { Comfy } from "./comfy";
import { join } from "node:path";
import type { Db, DbKind } from "./db";
import { Downloads } from "./downloads";
import { ShippedPresets, shippedPresetsDir } from "./presetFiles";
import { DEFAULT_QUEUE_OPTIONS, Queue, type QueueOptions } from "./queue";
import { Registry } from "./registry";
import { readSettings } from "./settings";
import { Linked, RoutedStorage } from "./linked";
import type { Storage } from "./storage";
import { sweep } from "./sweep";
import { fold } from "./renders";
import type { InfoLookup } from "@afflatus/comfy";
import type { ModelInfo } from "@afflatus/core";
import { readJson } from "./queueModel";
import { Timelines } from "./timelines";
import { sweepIdleDrafts } from "./drafts";
import { Updates } from "./modelUpdates";
import { Precompute, type PrecomputeOptions } from "./precompute";

/** Everything the routes need, built once at start (and once per test). */
export interface Services {
  db: Db;
  dbKind: DbKind;
  storage: Storage;
  /** Folders linked to a directory of the disk. */
  linked: Linked;
  /** The built-in recipes and the imported workflows. */
  registry: Registry;
  /** The ComfyUI at the address in the settings. A new one is made when the address changes. */
  comfy(): Promise<Comfy>;
  queue: Queue;
  timelines: Timelines;
  /** Model files being fetched into ComfyUI. */
  downloads: Downloads;
  /** The presets that ship with Afflatus (the repository's `presets/` folder). */
  shippedPresets: ShippedPresets;
  /** Newer versions of the model files on Civitai. */
  updates: Updates;
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
  let current: Comfy | null = null;
  registry.onChange = () => current?.forgetScan();
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
  const comfy = async () => {
    const { comfyUrl } = await readSettings(db);
    if (current?.url !== comfyUrl) {
      current?.close();
      current = new Comfy(comfyUrl, registry);
      current.overrides = async () => (await readSettings(db)).slotFiles;
      current.infoOf = infoOf;
    }
    return current;
  };
  const queue = new Queue(db, storage, comfy, registry, queueOptions);
  queue.events.on("models", () => {
    info = null;
  });
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
    sweep(db, storage)
      .then((r) => (r.binned || r.erased) && queue.events.emit("library"))
      .then(() => sweepIdleDrafts(db, registry))
      // the times of renders older than they are kept one by one become figures per model and day
      .then(async () => fold(db, (await readSettings(db)).renderHistoryDays))
      .catch((err) => console.warn("[sweep]", (err as Error).message));
  const sweeper = setInterval(runSweep, 60 * 60_000);
  sweeper.unref();
  void runSweep();
  const services: Services = {
    db, dbKind, storage, linked, registry, comfy, queue, timelines, downloads: new Downloads(queue.events, dirs.dataDir ? join(dirs.dataDir, "downloads.json") : undefined),
    shippedPresets: new ShippedPresets(dirs.shippedPresets === undefined ? shippedPresetsDir() : dirs.shippedPresets),
    updates: null as unknown as Updates,
    precompute,
    async close() {
      clearInterval(sweeper);
      await precompute?.stop();
      queue.stop();
      await queue.idle();
      current?.close();
      await db.destroy();
    },
  };
  services.updates = new Updates(services);
  // the daily check for newer model versions rides on the hourly sweep: it only runs when the user asked for it. What
  // goes wrong is logged and kept on the report (daily), never thrown at a timer
  const daily = () => void services.updates.daily().catch((err) => console.warn("[updates]", (err as Error).message));
  const checker = setInterval(daily, 60 * 60_000);
  checker.unref();
  const firstCheck = setTimeout(daily, 30_000);
  firstCheck.unref();
  const closeBefore = services.close;
  services.close = async () => {
    clearInterval(checker);
    clearTimeout(firstCheck);
    await closeBefore();
  };
  return services;
}
