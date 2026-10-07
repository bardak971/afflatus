import type { FastifyInstance, FastifyReply } from "fastify";
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
const RELAYED = ["queue", "library", "models", "timeline", "entities", "downloads", "setup"] as const;

export function registerEvents(app: FastifyInstance, s: Services, version: string): void {
  const clients = new Set<FastifyReply>();
  const send = (event: string, data: unknown = {}) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const reply of clients) reply.raw.write(frame);
  };
  const sendSystem = async () => send("system", { load: await (await s.comfy()).load().catch(() => null) });

  // every connection used to add its own listeners: the limit that warns about a leak does not apply to a fan-out
  s.queue.events.setMaxListeners(0);
  for (const name of RELAYED) s.queue.events.on(name, () => send(name));
  let lastProgress = 0;
  s.queue.events.on("progress", () => {
    if (Date.now() - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = Date.now();
    // with the running job's figures: the page changes its queue in place and asks for nothing (live.ts)
    void s.queue
      .status()
      .then((st) => {
        const r = st.running;
        send("progress", r ? { id: r.id, progress: r.progress, eta: r.eta, phase: r.phase, step: r.step, steps: r.steps, previewSeq: r.previewSeq, stages: r.stages, previewMime: r.previewMime ?? null, spilling: r.spilling } : undefined);
      })
      .catch(() => send("progress"));
  });

  let timer: NodeJS.Timeout | null = null;
  const watch = () => {
    if (timer || !clients.size) return;
    timer = setInterval(() => void sendSystem(), LOAD_EVERY_MS);
  };
  const rest = () => {
    if (!timer || clients.size) return;
    clearInterval(timer);
    timer = null;
  };
  app.addHook("onClose", () => {
    clearInterval(timer ?? undefined);
    timer = null;
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
