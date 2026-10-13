import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { FakeState } from "../testing";

/** Messages about the prompt running that carry no prompt id: they go to its client, as previews do. */
const PREVIEWS = new Set(["kj_preview_override"]);

/**
 * ComfyUI's websocket: who is connected under which client id, and who hears a message. ComfyUI sends what
 * a prompt does only to the client id it was queued with (to everyone when it was queued without one); a
 * load snapshot or a status goes to everyone.
 */
export function fakeSockets(server: Server, fake: FakeState, letIn: (req: IncomingMessage) => boolean = () => true) {
  // a locked ComfyUI (the node pack's lock) refuses the socket of a caller without its token, before it opens
  const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }: { req: IncomingMessage }) => letIn(req) });
  const idOf = new Map<WebSocket, string>();
  wss.on("connection", (socket, req) => {
    const id = new URL(req.url ?? "/", "http://fake").searchParams.get("clientId") ?? "";
    idOf.set(socket, id);
    fake.sockets.push(id);
    socket.on("close", () => idOf.delete(socket));
  });
  /** The client id each prompt was queued with (null: none, so everyone hears it). */
  const owners = new Map<string, string | null>();
  /** The client of the prompt running: what carries no prompt id is about it. */
  let current: string | null = null;
  /** null: every client. */
  const deliver = (to: string | null, payload: string | Uint8Array) => {
    for (const c of wss.clients) if (to === null || idOf.get(c) === to) c.send(payload);
  };
  return {
    own(promptId: string, clientId: string | null) {
      owners.set(promptId, clientId);
    },
    send(type: string, data: unknown, to?: string) {
      const promptId = (data as { prompt_id?: unknown } | null)?.prompt_id;
      let target: string | null = to ?? null;
      if (to === undefined && typeof promptId === "string") {
        target = owners.get(promptId) ?? null;
        current = target;
      } else if (to === undefined && PREVIEWS.has(type)) target = current;
      deliver(target, JSON.stringify({ type, data }));
    },
    sendBinary(bytes: Uint8Array) {
      deliver(current, bytes);
    },
    drop() {
      for (const c of wss.clients) c.terminate();
    },
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
