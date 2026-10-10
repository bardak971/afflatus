import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "./db";
import type { Services } from "./services";

/**
 * Live updates to every open page, as server-sent events: "queue", "library", "progress" and the rest
 * say what to refetch; "system" carries the load of ComfyUI's machine for the monitor bar. One set of
 * listeners on the queue's events and one load timer serve every connection: the timer runs only while
 * someone is connected, and each tick asks ComfyUI once, however many tabs are open.
 */

const LOAD_EVERY_MS = 2000;
/** Progress can arrive many times a second: pass on at most four. */
const PROGRESS_EVERY_MS = 250;
/** A beat on every connection, whatever ComfyUI answers: a page that hears nothing for a while knows the stream is dead (a proxy can keep it open after the server went). */
const PING_EVERY_MS = 10_000;
const RELAYED = ["queue", "library", "models", "timeline", "entities", "downloads", "setup"] as const;

/**
 * What a "library" event says changed, when its sender knows, so that a page reads again only the lists it touched (live.ts,
 * the web's data.ts libraryReads). `change`, what happened:
 * - "fields": the items' own fields (a name, a size read): nothing came, went or moved, no count changed. `name`: the new
 *   name of a rename, which a page writes in place.
 * - "kept": kept or not (`kept` says which); the disk use's split and the expiring count move too.
 * - "places": a project or a folder made or renamed: the folders and the projects, no item.
 * - "added": new items (a finished render, an upload, a cut, a frame, a mirror, an export).
 * - "moved": items filed in other folders; `kept` when filing kept them.
 * - "binned": items to the bin or back from it.
 * - "erased": items gone from the bin for good: the bin and the disk use only.
 * `items`, the items concerned, and `folders`, the folders they came into, left or sit in (null: in no folder), when known:
 * left out, any may have. Sent with nothing (`emit("library")`): anything may have changed, and every list is read.
 */
export interface LibraryChange {
  change?: "fields" | "kept" | "places" | "added" | "moved" | "binned" | "erased";
  items?: string[];
  folders?: Array<string | null>;
  kept?: boolean;
  name?: string;
}
const CHANGES = new Set(["fields", "kept", "places", "added", "moved", "binned", "erased"]);
/** At most this many ids go out with an event: past it none are listed, which a page reads as "any of them". */
const MAX_IDS = 200;
/** The folders a change touched, each once: those of the rows, and any more named (null: in no folder; undefined: none). */
export const foldersOf = (rows: ReadonlyArray<{ folder_id: string | null }>, ...more: Array<string | null | undefined>): Array<string | null> =>
  [...new Set<string | null>([...rows.map((r) => r.folder_id), ...more.filter((f) => f !== undefined)])];
/**
 * What a finished render added: its items and their folders, read off its generation. A failed read says nothing, which
 * reads every list: the render is done either way.
 */
export async function addedBy(db: Db, generationId: string): Promise<LibraryChange | undefined> {
  const made = await db.selectFrom("assets").select(["id", "folder_id"]).where("generation_id", "=", generationId).execute().catch(() => null);
  return made ? { change: "added", items: made.map((a) => a.id), folders: foldersOf(made) } : undefined;
}
/** What goes out with a "library" event: the change as said, or nothing (read everything) for anything else. */
export function libraryFrame(said: unknown): LibraryChange {
  const c = said as LibraryChange | undefined;
  if (!c || typeof c !== "object" || !c.change || !CHANGES.has(c.change)) return {};
  const items = Array.isArray(c.items) ? c.items.filter((i) => typeof i === "string") : undefined;
  const folders = Array.isArray(c.folders) ? c.folders.filter((f) => f === null || typeof f === "string") : undefined;
  return {
    change: c.change,
    // a list cut short would leave the page sure the rest did not change: too long, it goes out as "any"
    ...(items && items.length <= MAX_IDS ? { items } : {}),
    ...(folders && folders.length <= MAX_IDS ? { folders } : {}),
    ...(typeof c.kept === "boolean" ? { kept: c.kept } : {}),
    ...(typeof c.name === "string" ? { name: c.name } : {}),
  };
}

export function registerEvents(app: FastifyInstance, s: Services, version: string): void {
  const clients = new Set<FastifyReply>();
  const send = (event: string, data: unknown = {}) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const reply of clients) reply.raw.write(frame);
  };
  const sendSystem = async () => send("system", { load: await (await s.comfy()).load().catch(() => null) });

  // every connection used to add its own listeners: the limit that warns about a leak does not apply to a fan-out
  s.queue.events.setMaxListeners(0);
  for (const name of RELAYED) s.queue.events.on(name, (said?: unknown) => send(name, name === "library" ? libraryFrame(said) : {}));
  let lastProgress = 0;
  let trailing: NodeJS.Timeout | null = null;
  // with the running job's figures (from memory: no query per event): the page changes its queue in place and asks for nothing (live.ts)
  const sendProgress = () => {
    lastProgress = Date.now();
    void s.queue
      .progress()
      .then((r) => send("progress", r ? { id: r.id, progress: r.progress, eta: r.eta, phase: r.phase, step: r.step, steps: r.steps, previewSeq: r.previewSeq, stages: r.stages, previewMime: r.previewMime ?? null, seed: r.seed, spilling: r.spilling } : undefined))
      .catch(() => send("progress"));
  };
  // one send at most every PROGRESS_EVERY_MS, and one after the last of a burst: the last figures (the "Decoding" phase) always go out
  s.queue.events.on("progress", () => {
    const wait = PROGRESS_EVERY_MS - (Date.now() - lastProgress);
    if (wait <= 0) {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      sendProgress();
    } else trailing ??= setTimeout(() => {
      trailing = null;
      sendProgress();
    }, wait);
  });

  let timer: NodeJS.Timeout | null = null;
  let beat: NodeJS.Timeout | null = null;
  const watch = () => {
    if (timer || !clients.size) return;
    timer = setInterval(() => void sendSystem(), LOAD_EVERY_MS);
    beat = setInterval(() => send("ping"), PING_EVERY_MS);
  };
  const rest = () => {
    if (!timer || clients.size) return;
    clearInterval(timer);
    clearInterval(beat ?? undefined);
    timer = beat = null;
  };
  app.addHook("onClose", () => {
    clearTimeout(trailing ?? undefined);
    clearInterval(timer ?? undefined);
    clearInterval(beat ?? undefined);
    timer = beat = null;
  });

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    clients.add(reply);
    watch();
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
    // right away, so the monitor bar is there when a page opens rather than two seconds later
    void sendSystem();
    req.raw.on("close", () => {
      clients.delete(reply);
      rest();
    });
  });
}
