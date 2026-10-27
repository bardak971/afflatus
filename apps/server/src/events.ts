import type { FastifyInstance, FastifyReply } from "fastify";
import type { SystemLoad } from "@afflatus/comfy";
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
/**
 * "notice": what the user is told of (notify.ts), which an open page shows as a browser notification where it is ticked.
 * "draft": a draft an MCP token changed (mcpDrafts.ts DraftEdit), which a page with it open shows at once.
 */
const RELAYED = ["queue", "library", "models", "timeline", "entities", "downloads", "setup", "updates", "notice", "draft"] as const;
/**
 * How much may wait unsent to one page before it is let go: a page that stops reading (a laptop asleep, a stalled proxy)
 * would otherwise have every event kept for it in memory, about 10 MB a day. A page let go reconnects and reads everything again.
 */
export const MAX_UNSENT_BYTES = 1024 * 1024;

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

/**
 * What a "system" frame says after the first: the machines whose load changed since the last frame (a load's `at`, the
 * moment it was read, aside), and the ids of every machine, which a page goes by to drop one gone and keep the others'
 * loads as they were (the web's liveState.ts systemAfter). No frame when nothing changed and no machine came or went.
 * `now`: what was sent, for the next frame to be told against.
 */
export function systemFrame(before: ReadonlyMap<string, string>, read: Array<{ id: string; load: SystemLoad | null }>): { data: { machines: string[]; loads: Record<string, SystemLoad | null> } | null; now: Map<string, string> } {
  const now = new Map(read.map((r) => [r.id, JSON.stringify(r.load && { ...r.load, at: 0 })]));
  const changed = read.filter((r) => before.get(r.id) !== now.get(r.id));
  const same = !changed.length && before.size === now.size && [...before.keys()].every((id, i) => id === read[i]?.id);
  return { data: same ? null : { machines: read.map((r) => r.id), loads: Object.fromEntries(changed.map((r) => [r.id, r.load])) }, now };
}

export function registerEvents(app: FastifyInstance, s: Services, version: string): void {
  const clients = new Set<FastifyReply>();
  const frameOf = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const send = (event: string, data: unknown = {}) => {
    const frame = frameOf(event, data);
    for (const reply of clients) {
      if (reply.raw.writableLength > MAX_UNSENT_BYTES) {
        clients.delete(reply);
        reply.raw.destroy();
        continue;
      }
      reply.raw.write(frame);
    }
    rest();
  };
  // what it finds of the ComfyUIs goes to the queue too: an idle queue asks them nothing, and kept saying they were online.
  // A page gets every machine's load as it opens (`load` the first machine's, for the screens that show one; `loads` every
  // machine's by id); after that only the machines whose load changed go out, with the ids of all of them, and nothing when
  // none did (systemFrame): sent whole every 2 s it was 3.3 KB with ten machines, ~140 MB a day per open page, mostly the
  // same. `shown`: what every open page was sent last, which a page opening is sent whole; none while no page is open
  let shown: { read: Array<{ id: string; load: SystemLoad | null }>; keys: Map<string, string> } | null = null;
  const whole = (read: Array<{ id: string; load: SystemLoad | null }>) => ({ load: read[0]?.load ?? null, loads: Object.fromEntries(read.map((r) => [r.id, r.load])) });
  const sendSystem = async () => {
    const all = await s.machines();
    const read = await Promise.all(all.map(async ({ machine, comfy }) => ({ id: machine.id, load: await comfy.load().catch(() => null), answered: comfy.answered })));
    const heard = read.filter((r) => r.answered !== null);
    // whether a ComfyUI is away is said of those expected to answer: the user's own, and pods meant to be up. A stopped pod
    // is off, not away; with none expected at all (rented only, no pod up; no machine yet) nothing is away
    const expected = heard.filter((r) => !s.queue.unavailable(r.id));
    if (expected.length) s.queue.noteReachable(expected.some((r) => r.answered), new Map(heard.map((r) => [r.id, r.answered!])));
    else if (!all.some(({ machine }) => !machine.rented)) s.queue.noteReachable(true, new Map(heard.map((r) => [r.id, r.answered!])));
    // and whether a ComfyUI runs work from outside Afflatus (its own page): a change its socket said that was missed is caught here
    void s.queue.lookOutside().catch(() => {});
    if (!clients.size) return;
    const frame = systemFrame(shown?.keys ?? new Map(), read);
    const first = !shown;
    shown = { read, keys: frame.now };
    if (first) send("system", whole(read));
    else if (frame.data) send("system", frame.data);
  };

  // every connection used to add its own listeners: the limit that warns about a leak does not apply to a fan-out
  s.queue.events.setMaxListeners(0);
  // an update's flow goes out as it is (updates.ts emit): the page moves its bar without asking; and a notice, with its words
  for (const name of RELAYED) s.queue.events.on(name, (said?: unknown) => send(name, name === "library" ? libraryFrame(said) : name === "updates" || name === "notice" || name === "draft" ? (said ?? {}) : {}));
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
    shown = null;
    clearInterval(timer);
    clearInterval(beat ?? undefined);
    timer = beat = null;
  };
  // the open streams are ended before the server closes: it waits for every connection to end, and a page's stream never
  // does, so a restart asked by an update (start.ts) would hang there. The pages reconnect to the next server
  app.addHook("preClose", (done) => {
    for (const reply of clients) reply.raw.end();
    clients.clear();
    done();
  });
  app.addHook("onClose", () => {
    clearTimeout(trailing ?? undefined);
    clearInterval(timer ?? undefined);
    clearInterval(beat ?? undefined);
    timer = beat = null;
  });

  // who opened each stream, for the lock (access.ts): a stream outlives the request the lock looked at, so a session ended
  // since, a password set since or "From this computer" turned off ends the streams no longer allowed (the page then meets
  // the 401 on its next try and shows the sign-in)
  const who = new WeakMap<FastifyReply, { session: string | null; local: boolean }>();
  s.access.on("changed", () => {
    for (const reply of clients) {
      const w = who.get(reply);
      if (!w) continue;
      void s.access.allows({ session: w.session, bypass: false }, w.local).then((ok) => {
        if (ok) return;
        clients.delete(reply);
        reply.raw.end();
      }, () => {});
    }
  });

  app.get("/api/events", (req, reply) => {
    who.set(reply, { session: req.access?.session ?? null, local: req.access?.local ?? false });
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    clients.add(reply);
    watch();
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
    // right away, so the monitor bar is there when a page opens rather than two seconds later: what the open pages were
    // sent, to this one alone, the next frames being told against it; read now when no page was open
    if (shown) reply.raw.write(frameOf("system", whole(shown.read)));
    else void sendSystem();
    req.raw.on("close", () => {
      clients.delete(reply);
      rest();
    });
  });
}
