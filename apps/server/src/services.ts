import { Comfy } from "./comfy";
import type { Db, DbKind } from "./db";
import { Downloads } from "./downloads";
import { DEFAULT_QUEUE_OPTIONS, Queue, type QueueOptions } from "./queue";
import { Registry } from "./registry";
import { readSettings } from "./settings";
import { Linked, RoutedStorage } from "./linked";
import type { Storage } from "./storage";
import { sweep } from "./sweep";
import { fold } from "./renders";
import { Timelines } from "./timelines";

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
  close(): Promise<void>;
}

export async function createServices(db: Db, dbKind: DbKind, own: Storage, queueOptions: QueueOptions = DEFAULT_QUEUE_OPTIONS): Promise<Services> {
  // Afflatus's own files and the files of linked folders are read through the same door
  const storage = new RoutedStorage(own);
  const registry = new Registry(db);
  let current: Comfy | null = null;
  registry.onChange = () => current?.forgetScan();
  await registry.load();
  const comfy = async () => {
    const { comfyUrl } = await readSettings(db);
    if (current?.url !== comfyUrl) {
      current?.close();
      current = new Comfy(comfyUrl, registry);
    }
    return current;
  };
  const queue = new Queue(db, storage, comfy, registry, queueOptions);
  const timelines = new Timelines(db, storage, registry, queue.events);
  queue.clips = timelines;
  const linked = new Linked(db, storage, queue.events);
  await linked.load();
  // what changed in the linked directories while Afflatus was not running: read in the background
  void linked.scanAll();
  // unkept results to the bin after a day, the bin emptied after a week: checked at start and every hour
  const runSweep = () =>
    sweep(db, storage)
      .then((r) => (r.binned || r.erased) && queue.events.emit("library"))
      // the times of renders older than they are kept one by one become figures per model and day
      .then(async () => fold(db, (await readSettings(db)).renderHistoryDays))
      .catch((err) => console.warn("[sweep]", (err as Error).message));
  const sweeper = setInterval(runSweep, 60 * 60_000);
  sweeper.unref();
  void runSweep();
  return {
    db, dbKind, storage, linked, registry, comfy, queue, timelines, downloads: new Downloads(queue.events),
    async close() {
      clearInterval(sweeper);
      queue.stop();
      await queue.idle();
      current?.close();
      await db.destroy();
    },
  };
}
