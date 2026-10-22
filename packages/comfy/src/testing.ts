import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Graph, NodeCatalog } from "@afflatus/core";
import type { HistoryEntry } from "./client";
import { fakeFolders } from "./fake/folders";
import { fakeLock } from "./fake/lock";
import { fakeManager } from "./fake/manager";
import { fakeRoutes } from "./fake/routes";
import { fakeSimulate } from "./fake/simulate";
import { fakeSockets } from "./fake/sockets";

export { makePng } from "./fake/png";
export { FAKE_GPUS, FAKE_LAYERS, NO_CAPACITY, startFakeRunpod, type FakeGpu, type FakePod, type FakeRunpod, type FakeVolume } from "./fake/runpod";
export { startFakeS3, type FakeS3, type FakeS3File } from "./fake/s3";

/**
 * A stand-in for ComfyUI's HTTP API, for tests: enough of it to exercise the client, the capabilities
 * scan and the queue without a GPU. It records what it was asked so tests can assert on it.
 */
export interface FakeComfy {
  url: string;
  /** Every request as "METHOD /path". */
  calls: string[];
  /** Graphs received on POST /prompt, by prompt id. */
  prompts: Map<string, Graph>;
  catalog: NodeCatalog;
  models: Record<string, string[]>;
  history: Record<string, HistoryEntry>;
  running: string[];
  pending: string[];
  /** Files served by GET /view, by filename. */
  files: Record<string, Uint8Array>;
  /** When set, POST /prompt answers 400 with this body. */
  rejectWith: unknown | null;
  /** Bodies POST /prompt answers 400 with, one per prompt, before it takes prompts again (a file it no longer has, then sent). */
  rejectNext: unknown[];
  uploads: string[];
  /** How long an upload waits before it is answered: a render's Stop pressed while its files go up. */
  uploadDelayMs: number;
  /** The bytes of each uploaded file, by the name it was uploaded under. */
  uploaded: Record<string, Uint8Array>;
  /** The bodies of the node pack's cleanups asked for (POST /afflatus/clean-input): the input folder's, or with `folder: "output"` the output folder's. */
  cleaned: unknown[];
  /** What model files say about themselves, by "<folder>/<file>". A file not listed has no header. */
  metadata: Record<string, Record<string, unknown>>;
  /** Whole headers (metadata and tensors) by "<folder>/<file>", served by the node pack's route when the pack is pretended to be there (`headers` set at all). */
  headers: Record<string, Record<string, unknown>> | null;
  /** The version the pretend Afflatus node pack answers on GET /afflatus/version; null: no pack loaded (404). */
  packVersion: string | null;
  /**
   * The GPU's power the pretend node pack reads (GET /afflatus/power, 0.18.0 and newer): watts, or null for a machine
   * without NVML or nvidia-smi. Undefined: the route is not there (404), as with an older pack.
   */
  watts?: number | null;
  /** Client ids of the websockets that connected, in order. */
  sockets: string[];
  /** What the pretend ComfyUI-Manager downloaded: where it put it and how large it was. */
  installed: Array<{ folder: string; file: string; bytes: number }>;
  /** What the pretend ComfyUI-Manager was asked to download: the address and where to. */
  installAsked: Array<{ url: string; filename: string; save_path: string; type: string }>;
  /** Model folders on a real disk, by folder (init.folderPaths): said on /internal/folder_paths, and their files listed. Null: none. */
  folderPaths: Record<string, string[]> | null;
  /** Say no /internal/folder_paths, as a ComfyUI too old to have it. */
  hideFolderPaths: boolean;
  /** The node packs Manager was asked to install, as its queue got them. */
  packs: Array<{ id: string; version: string; repository?: string }>;
  /** How many times Manager was asked to restart ComfyUI. */
  reboots: number;
  /** Files written into ComfyUI's user data, by path ("workflows/afflatus/x.json"). */
  userdata: Record<string, unknown>;
  /** The node pack's lock (0.12.0 and newer): its token, and whether calls from this machine get in without it. Null: not locked. */
  lock: { token: string; local: boolean; fixed?: boolean; /** Afflatus's page, let in by "from this PC" (lock.py). */ origin?: string } | null;
  /** The calls the lock refused, as "METHOD /path". */
  refused: string[];
  /** What the pretend ComfyUI-Manager says its version is (GET /v2/manager/version). */
  managerVersion: string;
  /** An older ComfyUI whose page answers every address: a POST to a route it does not have is refused 405, not 404. */
  oldPage: boolean;
  /** Down, as the ComfyUI of a stopped pod (fake/runpod.ts): every call answered 502 by the provider's proxy, no socket. */
  down: boolean;
  /** The Afflatus pod image on a host whose GPU does not work (deploy/runpod/broken.py): GET /afflatus/pod says this error, all else 503. */
  podBroken: string | null;
  /**
   * The Afflatus pod image whose ComfyUI died after its start (deploy/runpod/died.py, broken.py --died): GET /afflatus/pod says
   * "comfy_died" with this line and report, all else 503, as a pod with nothing on ComfyUI's port but broken.py.
   */
  podDied: { error: string; report: Record<string, unknown> | null } | null;
  /** The RAM its /system_stats says, in bytes (ComfyUI 0.41: a container's limit and what is left); null: not said, as before. */
  ram: { total: number; free: number } | null;
  /**
   * The Afflatus pod image's boot log (deploy/runpod/bootlog.py), served here at ComfyUI's address (the demo's and the tests'
   * proxy has one address per pod): GET /afflatus/boot with this token as a Bearer, whether ComfyUI is up or not; null: no
   * boot log (RunPod's image, an older Afflatus image, or no container yet).
   */
  bootLog: { token: string; lines: Array<{ t: string; m: string }> } | null;
  /** The node pack's watchdog (0.13.0): each "still here" it heard, with the minutes it was given. */
  alive: Array<{ at: number; minutes: number }>;
  /** Every address the pretend node pack fetched a download from, in order (a fresh link after one expired among them). */
  packFetched: string[];
  /** The pieces the pack's upload took (0.14.0): into which file, at which byte, how many bytes. */
  packUploaded: Array<{ file: string; offset: number; bytes: number }>;
  /** Pieces of an upload cut on their way (each answered 400, nothing kept), counted down. */
  uploadCut: number;
  /** The bytes free on the model folders' disk, as an upload and a download are told and GET /afflatus/disk says (0.19.0 on); left out: room enough. */
  diskFree?: number;
  /** The disk's size, as GET /afflatus/disk says it; left out: twice what is free. */
  diskTotal?: number;
  /** The model files taken off to make room (POST /afflatus/models/remove, 0.19.0 on), as folder/file. */
  removed: string[];
  /**
   * Send a websocket message as ComfyUI does: one about a prompt goes only to the client that queued it (every
   * client when it was queued without a client id, or is not known here); a preview without a prompt id goes to
   * the client of the prompt running; anything else (a load snapshot, a status) to everyone. `to` sends it to that client id alone.
   */
  send(type: string, data: unknown, to?: string): void;
  /** A binary frame (a live preview): to the client of the prompt running, as ComfyUI does. */
  sendBinary(bytes: Uint8Array): void;
  /** Cut every websocket, as a ComfyUI restart or a network blip does; the clients may connect again. */
  dropSockets(): void;
  close(): Promise<void>;
}

/** What the parts of the fake share: everything but its address and its own methods. */
export type FakeState = Omit<FakeComfy, "url" | "close" | "send" | "sendBinary" | "dropSockets">;

/** One request as the fake's parts see it: a part answers it and says true, or leaves it to the next. */
export interface FakeRequest {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage["headers"];
  /** The body, read whole. */
  raw: Buffer;
  /** Answer it (true: the request is answered), with headers of its own when given. */
  json(status: number, value: unknown, headers?: Record<string, string>): true;
  /** A plain answer: a status and an optional text. */
  plain(status: number, text?: string | Uint8Array, type?: string, headers?: Record<string, string>): true;
}

export interface FakeInit extends Partial<Pick<FakeComfy, "catalog" | "models" | "folderPaths" | "hideFolderPaths">> {
  /**
   * Pretend to have ComfyUI-Manager: a model install fetches the address it is given, reads all of it
   * (as the real one does) and lists the file in its folder. "refuses": it accepts the request and
   * never fetches, as a Manager that is not allowed to download does.
   */
  manager?: boolean | "refuses";
  /** Manager's map of node types to packs (getmappings), for pretending to know where a node type comes from. */
  mappings?: Record<string, [string[], { title_aux?: string }]>;
  /** Pack ids whose install "fails", with this message in the history. */
  packsFail?: string[];
  /** Packs its pretend Manager does not find the first so many times it is asked (its list still loading). */
  packsLate?: Record<string, number>;
  /** Node types that appear in the catalog once ComfyUI "restarts" after a pack install (what the pack brings). */
  afterReboot?: NodeCatalog;
  /**
   * Pretend to render: every prompt reports progress step by step, streams previews, and finishes with a
   * picture of the size that was asked for. A load snapshot is broadcast every second, as a monitor
   * extension would. For running the real app without a GPU.
   */
  simulate?: {
    stepMs: number;
    /** What a video workflow "renders": an MP4, or a function that makes one for the graph it was sent. Without it, video prompts fail. */
    video?: Uint8Array | ((graph: Graph, seed: number) => Uint8Array | undefined);
  };
}

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

export async function startFakeComfy(init: FakeInit = {}): Promise<FakeComfy> {
  const fake: FakeState = {
    calls: [], prompts: new Map(), history: {}, running: [], pending: [], files: {}, rejectWith: null, rejectNext: [], uploads: [], uploadDelayMs: 0, uploaded: {}, cleaned: [], metadata: {}, headers: null, packVersion: null, sockets: [], installed: [], installAsked: [], packs: [], reboots: 0, userdata: {}, lock: null, refused: [], packFetched: [], packUploaded: [], removed: [], uploadCut: 0, managerVersion: "V4.2.1", oldPage: false, down: false, podBroken: null, podDied: null, ram: null, bootLog: null, alive: [],
    folderPaths: init.folderPaths ?? null, hideFolderPaths: init.hideFolderPaths ?? false,
    catalog: init.catalog ?? {},
    models: init.models ?? {},
  };
  // the parts answer in turn: Manager's routes, the model folders on disk, then ComfyUI's own and the node pack's
  let simulate: ReturnType<typeof fakeSimulate> | null = null;
  const lock = fakeLock(fake);
  const parts = [
    // the node pack's lock first, in front of everything, as lock.py puts itself first of ComfyUI's middlewares
    (r: FakeRequest) => lock.route(r),
    fakeManager(fake, init),
    fakeFolders(fake),
    fakeRoutes(fake, { queued: (id, clientId) => { sockets.own(id, clientId); sockets.status(); simulate?.start(id); } }),
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    fake.calls.push(`${method} ${url.pathname}`);
    const r: FakeRequest = {
      method, path: url.pathname, url, headers: req.headers, raw: await body(req),
      json: (status, value, headers) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(value));
        return true;
      },
      plain: (status, text, type, headers) => {
        res.writeHead(status, { ...(type ? { "Content-Type": type } : {}), ...headers });
        res.end(text);
        return true;
      },
    };
    // the pod's boot log answers on its own port, ComfyUI up or not: only to its token, GET only
    if (url.pathname === "/afflatus/boot" && fake.bootLog) {
      if (req.headers.authorization !== `Bearer ${fake.bootLog.token}`) return r.json(401, { error: "the pod's token is needed" });
      if (method !== "GET") return r.json(405, { error: "GET only" });
      return r.json(200, { lines: fake.bootLog.lines.slice(-300) });
    }
    // a stopped pod's ComfyUI: the provider's proxy answers for it, and says it is not there
    if (fake.down) return r.plain(502, "Bad Gateway: the pod is not running", "text/plain");
    if (fake.podBroken !== null) return url.pathname === "/afflatus/pod" ? r.json(200, { afflatus_pod: "gpu_failed", error: fake.podBroken }) : r.json(503, { afflatus_pod: "gpu_failed", error: fake.podBroken });
    if (fake.podDied !== null) {
      const said = { afflatus_pod: "comfy_died", error: fake.podDied.error, ...(fake.podDied.report ? { report: fake.podDied.report } : {}) };
      return r.json(url.pathname === "/afflatus/pod" ? 200 : 503, said);
    }
    if (url.pathname === "/upload/image" && fake.uploadDelayMs) await new Promise((resolve) => setTimeout(resolve, fake.uploadDelayMs));
    for (const part of parts) if (await part(r)) return;
    r.json(404, { error: `fake ComfyUI has no ${method} ${url.pathname}` });
  });
  const sockets = fakeSockets(server, fake, (req) => !fake.down && lock.letIn(req.headers, new URL(req.url ?? "/", "http://fake")));
  // the queue as ComfyUI says it on each change (its "status" broadcast): whenever it is set anew, by a test's hand or the
  // fake's own (a prompt taken off, started, ended); a prompt queued says it through `queued`
  for (const key of ["running", "pending"] as const) {
    let list = fake[key];
    Object.defineProperty(fake, key, {
      enumerable: true,
      get: () => list,
      set: (next: string[]) => {
        list = next;
        sockets.status();
      },
    });
  }
  if (init.simulate) simulate = fakeSimulate(fake, init.simulate, sockets);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    send: sockets.send,
    sendBinary: sockets.sendBinary,
    dropSockets: sockets.drop,
    close: () =>
      new Promise<void>((resolve, reject) => {
        simulate?.stop();
        sockets.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  });
}
