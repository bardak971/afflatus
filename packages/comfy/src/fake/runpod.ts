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
}

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
  failPatch: number | null;
  hideEnv: boolean;
  failList: number | null;
  oddList: boolean;
  actionDelayMs: number;
  close(): Promise<void>;
}

const raw = (p: FakePod) => ({
  id: p.id, name: p.name, status: p.status, cost: p.status === "RUNNING" || p.status === "STARTING" || p.status === "PROVISIONING" ? p.rate : 0,
  actions: p.status === "RUNNING" ? ["stop", "restart", "terminate"] : p.status === "EXITED" || p.status === "ERROR" ? ["start", "terminate"] : ["stop", "terminate"],
  gpu: { id: p.gpu, count: 1 }, dataCenterId: p.dataCenterId, ports: p.ports, cloud: "SECURE", image: "runpod/comfyui:latest",
  mounts: { persistent: { size: p.diskGb, path: "/workspace" } },
  env: p.env,
  runtime: p.status === "RUNNING" && p.startedAt ? { uptime: Math.round((Date.now() - Date.parse(p.startedAt)) / 1000) } : null,
  startedAt: p.startedAt,
});

/**
 * A pretend RunPod (API v2 as runpod.ts reads it, and its GraphQL balance): the user's pods, each with a pretend ComfyUI
 * inside that answers only while the pod runs (FakeComfy.down). A started pod is STARTING for `bootMs`, then RUNNING; a
 * stopped one EXITED; a deleted one gone. Each pod's id is its ComfyUI's port, so that "http://127.0.0.1:{id}" (RUNPOD_PROXY)
 * reaches it as RunPod's proxy would.
 */
export async function startFakeRunpod(o: { key: string; pods: Array<Omit<FakePod, "id" | "startedAt" | "status" | "env"> & { status?: FakePod["status"]; env?: Record<string, string> }>; balance?: number; bootMs?: number }): Promise<FakeRunpod> {
  const pods: FakePod[] = o.pods.map((p) => {
    const status = p.status ?? "EXITED";
    p.comfy.down = status !== "RUNNING";
    return { ...p, env: p.env ?? {}, id: new URL(p.comfy.url).port, status, startedAt: status === "RUNNING" ? new Date().toISOString() : null };
  });
  const fake: Omit<FakeRunpod, "url" | "close"> = {
    key: o.key, pods, calls: [], balance: o.balance ?? 23.4, bootMs: o.bootMs ?? 1500,
    failAction: {}, failDetail: null, secrets: {}, failSecrets: false, failPatch: null, hideEnv: false, failList: null, oddList: false, actionDelayMs: 0,
  };
  const timers = new Set<NodeJS.Timeout>();
  /** What the pods have cost: the stretches that ended, and what runs now. */
  let ended = 0;
  const running = (p: FakePod) => (p.status === "RUNNING" && p.startedAt ? ((Date.now() - Date.parse(p.startedAt)) / 3_600_000) * p.rate : 0);
  const spent = () => ended + fake.pods.reduce((sum, p) => sum + running(p), 0);
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
    if (req.method === "POST" && url.pathname === "/graphql") return json(200, { data: { myself: { clientBalance: fake.balance - spent() } } });
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
    // a pod's environment, replaced whole, for its next start
    const one = /^\/v2\/pods\/([^/]+)$/.exec(url.pathname);
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
        pod.status = "EXITED";
        pod.startedAt = null;
        pod.comfy.down = true;
      } else if (action === "start") {
        pod.status = "STARTING";
        const t = setTimeout(() => {
          timers.delete(t);
          if (pod.status !== "STARTING") return;
          pod.status = "RUNNING";
          pod.startedAt = new Date().toISOString();
          // the node pack reads AFFLATUS_TOKEN as ComfyUI starts: locked from its first second, a lock the routes cannot change.
          // A secret's reference in it is given its value at boot, as RunPod does
          const said = pod.env.AFFLATUS_TOKEN;
          const ref = said ? /^\{\{\s*RUNPOD_SECRET_(.+?)\s*\}\}$/.exec(said) : null;
          const token = ref ? fake.secrets[ref[1]!] : said;
          if (token && pod.comfy.packVersion) pod.comfy.lock = { token, local: false, fixed: true };
          pod.comfy.down = false;
        }, fake.bootMs);
        timers.add(t);
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
