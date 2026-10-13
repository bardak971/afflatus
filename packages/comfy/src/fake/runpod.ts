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
  balance: number;
  /** How long a started pod is STARTING before it runs. */
  bootMs: number;
  close(): Promise<void>;
}

const raw = (p: FakePod) => ({
  id: p.id, name: p.name, status: p.status, cost: p.status === "RUNNING" || p.status === "STARTING" || p.status === "PROVISIONING" ? p.rate : 0,
  actions: p.status === "RUNNING" ? ["stop", "restart", "terminate"] : p.status === "EXITED" || p.status === "ERROR" ? ["start", "terminate"] : ["stop", "terminate"],
  gpu: { id: p.gpu, count: 1 }, dataCenterId: p.dataCenterId, ports: p.ports, cloud: "SECURE", image: "runpod/comfyui:latest",
  mounts: { persistent: { size: p.diskGb, path: "/workspace" } },
  runtime: p.status === "RUNNING" && p.startedAt ? { uptime: Math.round((Date.now() - Date.parse(p.startedAt)) / 1000) } : null,
  startedAt: p.startedAt,
});

/**
 * A pretend RunPod (API v2 as runpod.ts reads it, and its GraphQL balance): the user's pods, each with a pretend ComfyUI
 * inside that answers only while the pod runs (FakeComfy.down). A started pod is STARTING for `bootMs`, then RUNNING; a
 * stopped one EXITED; a deleted one gone. Each pod's id is its ComfyUI's port, so that "http://127.0.0.1:{id}" (RUNPOD_PROXY)
 * reaches it as RunPod's proxy would.
 */
export async function startFakeRunpod(o: { key: string; pods: Array<Omit<FakePod, "id" | "startedAt" | "status"> & { status?: FakePod["status"] }>; balance?: number; bootMs?: number }): Promise<FakeRunpod> {
  const pods: FakePod[] = o.pods.map((p) => {
    const status = p.status ?? "EXITED";
    p.comfy.down = status !== "RUNNING";
    return { ...p, id: new URL(p.comfy.url).port, status, startedAt: status === "RUNNING" ? new Date().toISOString() : null };
  });
  const fake: Omit<FakeRunpod, "url" | "close"> = { key: o.key, pods, calls: [], balance: o.balance ?? 23.4, bootMs: o.bootMs ?? 1500 };
  const timers = new Set<NodeJS.Timeout>();
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
    if (req.method === "POST" && url.pathname === "/graphql") return json(200, { data: { myself: { clientBalance: fake.balance } } });
    if (req.method === "GET" && url.pathname === "/v2/pods") return json(200, { pods: fake.pods.filter((p) => p.status !== "TERMINATED").map(raw), pagination: { nextCursor: null, hasNextPage: false } });
    const act = /^\/v2\/pods\/([^/]+)\/action$/.exec(url.pathname);
    const pod = act ? fake.pods.find((p) => p.id === decodeURIComponent(act[1]!) && p.status !== "TERMINATED") : undefined;
    if (req.method === "POST" && act) {
      if (!pod) return json(404, { title: "Not Found", status: 404, detail: "pod not found" });
      const action = body.action;
      const allowed = raw(pod).actions;
      if (typeof action !== "string" || !allowed.includes(action)) return json(409, { title: "Conflict", status: 409, detail: `cannot ${String(action)} a ${pod.status.toLowerCase()} pod` });
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
