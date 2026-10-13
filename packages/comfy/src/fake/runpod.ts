import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeComfy } from "../testing";

/** A pod of the pretend RunPod, and the pretend ComfyUI inside it (it answers only while the pod runs). */
export interface FakePod {
  id: string;
  name: string;
  status: "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";
  /** USD an hour; the list says it only while the pod runs, as RunPod does. */
  rate: number;
  gpu: string;
  dataCenterId: string;
  ports: string[];
  diskGb: number;
  /** Its environment: AFFLATUS_TOKEN in it locks its ComfyUI from its start, as the node pack does (a fixed lock). */
  env: Record<string, string>;
  startedAt: string | null;
  comfy: FakeComfy;
  /** The image it runs (a deployed pod's), and the network volume mounted on it, by id. */
  image?: string;
  volumeId?: string | null;
}

/** A GPU of the pretend catalog: its prices (null: not on that cloud), and where it is free and how much. */
export interface FakeGpu {
  id: string;
  name: string;
  memory: number;
  price: { secure: number | null; community: number | null };
  dataCenters: Array<{ id: string; availability: "HIGH" | "MEDIUM" | "LOW" | "NONE" }>;
  /** Its hosts offer CUDA 13 (most do); without, 12.8 only. */
  cuda13?: boolean;
}

/** A network volume of the account. */
export interface FakeVolume {
  id: string;
  name: string;
  size: number;
  dataCenter: string;
}

/** What a deploy refused for want of a GPU says: RunPod's words, a 400 with no code of its own. */
export const NO_CAPACITY = "There are no longer any instances available with the requested specifications. Please refresh and try again.";

export interface FakeRunpod {
  url: string;
  /** The API key it takes; any other is refused (401). */
  key: string;
  pods: FakePod[];
  /** Every call, as "METHOD /path [action]". */
  calls: string[];
  /** The account's balance at the start: what the GraphQL says is this, less what the pods have run since. */
  balance: number;
  /** How long a started pod is STARTING before it runs. */
  bootMs: number;
  /** Misbehaving as the real one can, for a test: an action refused with this status, by pod id; the env change refused;
   * the env left out of the list; the list refused with this status, or answered in a shape of another API; actions slow. */
  failAction: Record<string, number>;
  /** What a refused action says (RunPod's own words), when one is. */
  failDetail: string | null;
  /** The account's secrets, by name (their values, which the real one never gives back); `failSecrets`: a key that may not make them. */
  secrets: Record<string, string>;
  failSecrets: boolean;
  /** How long a stopped pod still says RUNNING (stopping on RunPod's side); 0: at once. */
  stopMs: number;
  failPatch: number | null;
  hideEnv: boolean;
  failList: number | null;
  oddList: boolean;
  actionDelayMs: number;
  /** The GPUs a deploy picks from (GET /v2/catalog/gpus), and the account's network volumes. */
  gpus: FakeGpu[];
  volumes: FakeVolume[];
  /** "gpu@dataCenter" (or "gpu" for everywhere) taken between the list and the deploy: its create answers 400. */
  noCapacity: Set<string>;
  /** A create refused with this status (402: the balance), whatever is asked. */
  failCreate: number | null;
  /** A create that makes the pod, then answers this status all the same (an answer cut short). */
  createThenFail: number | null;
  /** A pod comes up with its ComfyUI not answering (a first start pulling, a container that does not start). */
  comfyStaysDown: boolean;
  /** What RunPod billed, hour by hour (GET /v2/billing/pods): set by a test, as RunPod writes it some hours late; null: refused (403). */
  bill: Array<{ podId: string; startTime: string; endTime: string; totalAmount: number }> | null;
  close(): Promise<void>;
}

const raw = (p: FakePod) => ({
  id: p.id, name: p.name, status: p.status, cost: p.status === "RUNNING" || p.status === "STARTING" || p.status === "PROVISIONING" ? p.rate : 0,
  actions: p.status === "RUNNING" ? ["stop", "restart", "terminate"] : p.status === "EXITED" || p.status === "ERROR" ? ["start", "terminate"] : ["stop", "terminate"],
  gpu: { id: p.gpu, count: 1 }, dataCenterId: p.dataCenterId, ports: p.ports, cloud: "SECURE", image: p.image ?? "runpod/comfyui:latest",
  mounts: p.volumeId ? { network: [{ volumeId: p.volumeId, path: "/workspace" }] } : { persistent: { size: p.diskGb, path: "/workspace" } },
  env: p.env,
  runtime: p.status === "RUNNING" && p.startedAt ? { uptime: Math.round((Date.now() - Date.parse(p.startedAt)) / 1000) } : null,
  startedAt: p.startedAt,
});

/** The pretend catalog's GPUs, as a test or the demo starts it with none of its own. */
export const FAKE_GPUS: FakeGpu[] = [
  { id: "NVIDIA A40", name: "A40", memory: 48, price: { secure: 0.44, community: 0.35 }, dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }, { id: "US-TX-3", availability: "LOW" }] },
  { id: "NVIDIA L4", name: "L4", memory: 24, price: { secure: 0.43, community: null }, dataCenters: [{ id: "US-TX-3", availability: "MEDIUM" }] },
  { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, price: { secure: 0.69, community: 0.34 }, dataCenters: [{ id: "EU-SE-1", availability: "NONE" }] },
  { id: "NVIDIA RTX 6000 Ada Generation", name: "RTX 6000 Ada", memory: 48, price: { secure: 0.77, community: 0.74 }, dataCenters: [{ id: "US-WA-1", availability: "MEDIUM" }, { id: "EU-RO-1", availability: "LOW" }] },
  { id: "NVIDIA H100 80GB HBM3", name: "H100 SXM", memory: 80, price: { secure: 2.69, community: null }, dataCenters: [{ id: "US-KS-2", availability: "LOW" }] },
];

const WORSE = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 } as const;

/**
 * A pretend RunPod (API v2 as runpod.ts reads it, and its GraphQL balance): the user's pods, each with a pretend ComfyUI
 * inside that answers only while the pod runs (FakeComfy.down). A started pod is STARTING for `bootMs`, then RUNNING; a
 * stopped one EXITED; a deleted one gone. Each pod's id is its ComfyUI's port, so that "http://127.0.0.1:{id}" (RUNPOD_PROXY)
 * reaches it as RunPod's proxy would. A pod is deployed (POST /v2/pods) on a GPU of `gpus`, with a pretend ComfyUI `spawn`
 * makes; it is PROVISIONING for `bootMs` (its image pulled), then RUNNING.
 */
export async function startFakeRunpod(o: { key: string; pods: Array<Omit<FakePod, "id" | "startedAt" | "status" | "env"> & { status?: FakePod["status"]; env?: Record<string, string> }>; balance?: number; bootMs?: number; gpus?: FakeGpu[]; volumes?: FakeVolume[]; spawn?: () => Promise<FakeComfy> }): Promise<FakeRunpod> {
  const pods: FakePod[] = o.pods.map((p) => {
    const status = p.status ?? "EXITED";
    p.comfy.down = status !== "RUNNING";
    return { ...p, env: p.env ?? {}, id: new URL(p.comfy.url).port, status, startedAt: status === "RUNNING" ? new Date().toISOString() : null };
  });
  const fake: Omit<FakeRunpod, "url" | "close"> = {
    key: o.key, pods, calls: [], balance: o.balance ?? 23.4, bootMs: o.bootMs ?? 1500,
    failAction: {}, failDetail: null, secrets: {}, failSecrets: false, stopMs: 0, failPatch: null, hideEnv: false, failList: null, oddList: false, actionDelayMs: 0,
    gpus: o.gpus ?? FAKE_GPUS, volumes: o.volumes ?? [], noCapacity: new Set(), failCreate: null, createThenFail: null, bill: [], comfyStaysDown: false,
  };
  const timers = new Set<NodeJS.Timeout>();
  /** What the pods have cost: the stretches that ended, and what runs now. */
  let ended = 0;
  const running = (p: FakePod) => (p.status === "RUNNING" && p.startedAt ? ((Date.now() - Date.parse(p.startedAt)) / 3_600_000) * p.rate : 0);
  const spent = () => ended + fake.pods.reduce((sum, p) => sum + running(p), 0);
  /**
   * A pod up after `bootMs`: RUNNING, its ComfyUI answering. The node pack reads AFFLATUS_TOKEN as ComfyUI starts: locked
   * from its first second, a lock the routes cannot change. A secret's reference in it is given its value at boot, as RunPod does.
   */
  const boot = (pod: FakePod) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (pod.status !== "STARTING" && pod.status !== "PROVISIONING") return;
      pod.status = "RUNNING";
      pod.startedAt = new Date().toISOString();
      const said = pod.env.AFFLATUS_TOKEN;
      const ref = said ? /^\{\{\s*RUNPOD_SECRET_(.+?)\s*\}\}$/.exec(said) : null;
      const token = ref ? fake.secrets[ref[1]!] : said;
      if (token && pod.comfy.packVersion) pod.comfy.lock = { token, local: false, fixed: true };
      pod.comfy.down = fake.comfyStaysDown;
    }, fake.bootMs);
    timers.add(t);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>) : {};
    const url = new URL(req.url ?? "/", "http://fake");
    fake.calls.push(`${req.method} ${url.pathname}${body.action ? ` ${String(body.action)}` : ""}`);
    const json = (status: number, value?: unknown) => {
      res.writeHead(status, value === undefined ? {} : { "Content-Type": "application/json" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${fake.key}`) return json(401, { title: "Unauthorized", status: 401, detail: "invalid api key" });
    // the balance goes down as the pods run, by the second, as RunPod's does
    if (req.method === "POST" && url.pathname === "/graphql") return json(200, { data: { myself: { clientBalance: fake.balance - spent(), currentSpendPerHr: fake.pods.filter((p) => p.status === "RUNNING" || p.status === "STARTING" || p.status === "PROVISIONING").reduce((sum, p) => sum + p.rate, 0) } } });
    if (req.method === "GET" && url.pathname === "/v2/billing/pods") {
      if (!fake.bill) return json(403, { title: "Forbidden", status: 403, detail: "this key cannot read billing" });
      const from = Date.parse(url.searchParams.get("startTime") ?? "") || 0;
      return json(200, { records: fake.bill.filter((r) => Date.parse(r.endTime) > from).map((r) => ({ ...r, gpuAmount: r.totalAmount, cpuAmount: 0, diskAmount: 0 })), metadata: {} });
    }
    // the GPUs a pod can be deployed on, their price on the cloud asked and how free they are, overall and by data center
    if (req.method === "GET" && url.pathname === "/v2/catalog/gpus") {
      const cloud = url.searchParams.get("cloud") === "COMMUNITY" ? "community" : "secure";
      return json(200, {
        gpus: fake.gpus.filter((g) => g.price[cloud] !== null).map((g) => ({
          id: g.id, name: g.name, memory: g.memory, manufacturer: "Nvidia", secure: g.price.secure !== null, community: g.price.community !== null,
          cudaVersions: [{ version: "12.8", available: true }, { version: "13.0", available: g.cuda13 !== false }],
          price: { secure: g.price.secure, community: g.price.community },
          availability: g.dataCenters.reduce<FakeGpu["dataCenters"][number]["availability"]>((best, d) => (WORSE[d.availability] < WORSE[best] ? d.availability : best), "NONE"),
          dataCenters: g.dataCenters.map((d) => ({ id: d.id, name: d.id, availability: d.availability })),
        })),
      });
    }
    if (req.method === "GET" && url.pathname === "/v2/network-volumes") return json(200, { networkVolumes: fake.volumes.map((v) => ({ ...v, type: "STANDARD" })) });
    // a pod deployed: one GPU type, in the first data center asked that has one free (any, when none is asked)
    if (req.method === "POST" && url.pathname === "/v2/pods") {
      if (fake.failCreate) return json(fake.failCreate, { title: "Refused", status: fake.failCreate, detail: fake.failCreate === 402 ? "insufficient balance" : "create refused" });
      const gpuAsked = (body.gpu as { id?: string } | undefined)?.id;
      const gpu = fake.gpus.find((g) => g.id === gpuAsked);
      if (!gpu || typeof body.name !== "string" || (typeof body.image !== "string" && typeof body.templateId !== "string")) return json(422, { title: "Unprocessable", status: 422, detail: "invalid request" });
      const network = (body.mounts as { network?: Array<{ volumeId: string; path: string }> } | undefined)?.network?.[0];
      const volume = network ? fake.volumes.find((v) => v.id === network.volumeId) : undefined;
      if (network && !volume) return json(400, { title: "Bad Request", status: 400, detail: "network volume not found" });
      const asked = Array.isArray(body.dataCenterIds) ? (body.dataCenterIds as string[]) : [];
      const free = gpu.dataCenters.filter((d) => d.availability !== "NONE" && !fake.noCapacity.has(gpu.id) && !fake.noCapacity.has(`${gpu.id}@${d.id}`) && (!asked.length || asked.includes(d.id)));
      const at = free.find((d) => !volume || d.id === volume.dataCenter);
      if (!at) return json(400, { title: "Bad Request", status: 400, detail: NO_CAPACITY });
      if (!o.spawn) return json(500, { title: "Error", status: 500, detail: "this pretend RunPod deploys nothing (no spawn)" });
      const comfy = await o.spawn();
      comfy.down = true;
      const made: FakePod = {
        id: new URL(comfy.url).port, name: body.name, status: "PROVISIONING", rate: (body.cloud === "COMMUNITY" ? gpu.price.community : gpu.price.secure) ?? 0,
        gpu: gpu.id, dataCenterId: at.id, ports: Array.isArray(body.ports) ? (body.ports as string[]) : [], diskGb: typeof body.disk === "number" ? body.disk : 50,
        env: body.env && typeof body.env === "object" ? { ...(body.env as Record<string, string>) } : {}, startedAt: null, comfy,
        image: typeof body.image === "string" ? body.image : undefined, volumeId: volume?.id ?? null,
      };
      fake.pods.push(made);
      boot(made);
      if (fake.createThenFail) return json(fake.createThenFail, { title: "Error", status: fake.createThenFail, detail: "upstream timed out" });
      return json(201, raw(made));
    }
    if (req.method === "GET" && url.pathname === "/v2/pods") {
      if (fake.failList) return json(fake.failList, { title: "Error", status: fake.failList, detail: fake.failList === 429 ? "rate limited" : "unavailable" });
      const listed = fake.pods.filter((p) => p.status !== "TERMINATED").map((p) => {
        const r = raw(p) as Record<string, unknown>;
        if (fake.hideEnv) delete r.env;
        return r;
      });
      // another API's shape: a bare array of pods with other names
      if (fake.oddList) return json(200, listed.map((r) => ({ id: r.id, desiredStatus: r.status, costPerHr: r.cost })));
      return json(200, { pods: listed, pagination: { nextCursor: null, hasNextPage: false } });
    }
    // the account's secrets: made, listed (names only), a value replaced, deleted
    const secretAt = /^\/v2\/account\/secrets(?:\/([^/]+))?$/.exec(url.pathname);
    if (secretAt) {
      if (fake.failSecrets) return json(403, { title: "Forbidden", status: 403, detail: "this key cannot manage secrets" });
      const id = secretAt[1] ? decodeURIComponent(secretAt[1]) : null;
      if (req.method === "GET" && !id) return json(200, { secrets: Object.keys(fake.secrets).map((name) => ({ id: `s-${name}`, name })) });
      if (req.method === "POST" && !id) {
        const name = String(body.name ?? "");
        if (name in fake.secrets) return json(409, { title: "Conflict", status: 409, detail: "a secret with this name exists" });
        fake.secrets[name] = String(body.value ?? "");
        return json(201, { id: `s-${name}`, name });
      }
      const name = id?.replace(/^s-/, "") ?? "";
      if (!(name in fake.secrets)) return json(404, { title: "Not Found", status: 404, detail: "no such secret" });
      if (req.method === "PATCH") {
        fake.secrets[name] = String(body.value ?? fake.secrets[name]);
        return json(200, { id, name });
      }
      if (req.method === "DELETE") {
        delete fake.secrets[name];
        return json(204);
      }
    }
    // one pod, read on its own
    const one = /^\/v2\/pods\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const found = fake.pods.find((p) => p.id === decodeURIComponent(one[1]!) && p.status !== "TERMINATED");
      if (!found) return json(404, { title: "Not Found", status: 404, detail: "pod not found" });
      const r = raw(found) as Record<string, unknown>;
      if (fake.hideEnv) delete r.env;
      return json(200, r);
    }
    // a pod's environment, replaced whole, for its next start
    if (req.method === "PATCH" && one) {
      if (fake.failPatch) return json(fake.failPatch, { title: "Refused", status: fake.failPatch, detail: "update refused" });
      const target = fake.pods.find((p) => p.id === decodeURIComponent(one[1]!) && p.status !== "TERMINATED");
      if (!target) return json(404, { title: "Not Found", status: 404, detail: "pod not found" });
      if (body.env && typeof body.env === "object") target.env = { ...(body.env as Record<string, string>) };
      if (Array.isArray(body.ports)) target.ports = [...(body.ports as string[])];
      return json(200, raw(target));
    }
    const act = /^\/v2\/pods\/([^/]+)\/action$/.exec(url.pathname);
    const pod = act ? fake.pods.find((p) => p.id === decodeURIComponent(act[1]!) && p.status !== "TERMINATED") : undefined;
    if (req.method === "POST" && act) {
      if (!pod) return json(404, { title: "Not Found", status: 404, detail: "pod not found" });
      if (fake.actionDelayMs) await new Promise((r) => setTimeout(r, fake.actionDelayMs));
      const failing = fake.failAction[pod.id];
      if (failing) return json(failing, { title: "Refused", status: failing, detail: fake.failDetail ?? "action refused" });
      const action = body.action;
      const allowed = raw(pod).actions;
      if (typeof action !== "string" || !allowed.includes(action)) return json(409, { title: "Conflict", status: 409, detail: `cannot ${String(action)} a ${pod.status.toLowerCase()} pod` });
      ended += running(pod);
      if (action === "terminate") {
        pod.status = "TERMINATED";
        pod.comfy.down = true;
        return json(204);
      }
      if (action === "stop") {
        // stopping takes a moment on RunPod's side: the pod still says RUNNING for `stopMs`
        const stopping = () => {
          pod.status = "EXITED";
          pod.startedAt = null;
          pod.comfy.down = true;
        };
        if (fake.stopMs) {
          const t = setTimeout(() => {
            timers.delete(t);
            stopping();
          }, fake.stopMs);
          timers.add(t);
        } else stopping();
      } else if (action === "start") {
        pod.status = "STARTING";
        boot(pod);
      }
      return json(200, raw(pod));
    }
    return json(404, { title: "Not Found", status: 404, detail: `no ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const t of timers) clearTimeout(t);
      server.close(() => resolve());
    }),
  });
}
