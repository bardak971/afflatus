import { envSaid } from "./config";

/**
 * RunPod, as Afflatus talks to it for a rented machine (rented.ts): the user's pods read with their API key, and a pod
 * started, stopped or deleted when the user asks (or its idle time, its cap or Delete says so). Nothing is ever made here.
 * API v2 (https://api.runpod.io/v2), the account's balance through its GraphQL. RUNPOD_API_URL points it at a pretend
 * RunPod (the demo, the tests); RUNPOD_PROXY says how a pod's ComfyUI is reached.
 */

export type PodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";
export type PodAction = "start" | "stop" | "restart" | "terminate";

/** A pod as Afflatus keeps it: what the list says of it that matters here. */
export interface Pod {
  id: string;
  name: string;
  status: PodStatus;
  /** USD an hour while it runs (RunPod says 0 while stopped: the rate is kept from when it ran). */
  cost: number;
  gpu: string | null;
  gpuCount: number;
  dataCenter: string | null;
  /** The exposed ports, as "8188/http". */
  ports: string[];
  /** Its own disk in GB (kept while stopped, billed then); 0 without one. */
  diskGb: number;
  /** A network volume is mounted: what is on it outlives the pod. */
  networkVolume: boolean;
  /** Seconds since it started, while it runs. */
  uptime: number | null;
  startedAt: string | null;
  actions: PodAction[];
}

/** RunPod answered with an error: its words when it said some. */
export class RunpodError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The ComfyUI port a pod must expose over HTTP for Afflatus to reach it. */
export const COMFY_PORT = 8188;
/** What a stopped pod's own disk costs, USD per GB and month (RunPod's price for the volume disk of a stopped pod). */
export const STOPPED_DISK_PER_GB_MONTH = 0.2;

const apiBase = () => (envSaid.runpodApi()?.trim() || "https://api.runpod.io").replace(/\/+$/, "");

/** The address a pod's ComfyUI answers at: RunPod's proxy, unless RUNPOD_PROXY says another ({id}, {port}). */
export function podUrl(id: string, port = COMFY_PORT): string {
  const shape = envSaid.runpodProxy()?.trim() || "https://{id}-{port}.proxy.runpod.net";
  return shape.replaceAll("{id}", id).replaceAll("{port}", String(port));
}

/** Whether a pod exposes ComfyUI's port over HTTP. */
export const exposesComfy = (pod: Pick<Pod, "ports">) => pod.ports.some((p) => p === `${COMFY_PORT}/http`);

type RawPod = {
  id: string; name?: string; status?: string; cost?: number; actions?: string[];
  gpu?: { id?: string; count?: number } | null; dataCenterId?: string | null; ports?: string[];
  mounts?: { persistent?: { size?: number } | null; network?: unknown[] | null } | null;
  runtime?: { uptime?: number } | null; startedAt?: string | null;
};

const podOf = (p: RawPod): Pod => ({
  id: p.id,
  name: p.name ?? p.id,
  status: (p.status ?? "ERROR") as PodStatus,
  cost: typeof p.cost === "number" ? p.cost : 0,
  gpu: p.gpu?.id ?? null,
  gpuCount: p.gpu?.count ?? (p.gpu ? 1 : 0),
  dataCenter: p.dataCenterId ?? null,
  ports: Array.isArray(p.ports) ? p.ports : [],
  diskGb: p.mounts?.persistent?.size ?? 0,
  networkVolume: Boolean(p.mounts?.network?.length),
  uptime: p.runtime?.uptime ?? null,
  startedAt: p.startedAt ?? null,
  actions: (p.actions ?? []).filter((a): a is PodAction => ["start", "stop", "restart", "terminate"].includes(a)),
});

export class Runpod {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetcher(`${apiBase()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(20_000),
    }).catch((err: Error) => {
      throw new RunpodError(`RunPod did not answer: ${err.message}`, 0);
    });
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
    if (!res.ok) {
      const said = res.status === 401 ? "RunPod refused the API key: check it in Settings › ComfyUI." : res.status === 409 ? "RunPod says the pod cannot do that now." : body?.detail ?? body?.title ?? `RunPod answered ${res.status}`;
      throw new RunpodError(said, res.status);
    }
    return body as T;
  }

  /** Every pod of the account, page after page. */
  async pods(): Promise<Pod[]> {
    const all: Pod[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const got: { pods?: RawPod[]; pagination?: { nextCursor?: string | null; hasNextPage?: boolean } } = await this.call(`/v2/pods?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...(got.pods ?? []).map(podOf));
      if (!got.pagination?.hasNextPage || !got.pagination.nextCursor) break;
      cursor = got.pagination.nextCursor;
    }
    return all;
  }

  /** Start, stop or delete (terminate) a pod. The pod as it is after, but for a delete. */
  async act(id: string, action: Exclude<PodAction, "restart">): Promise<Pod | null> {
    const got = await this.call<RawPod | undefined>(`/v2/pods/${encodeURIComponent(id)}/action`, { method: "POST", body: JSON.stringify({ action }) });
    return got ? podOf(got) : null;
  }

  /** The account's balance in USD, from RunPod's GraphQL; null when it does not say. */
  async balance(): Promise<number | null> {
    const res = await this.fetcher(`${apiBase()}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { data?: { myself?: { clientBalance?: number } } } | null) : null;
    const value = body?.data?.myself?.clientBalance;
    return typeof value === "number" ? value : null;
  }
}
