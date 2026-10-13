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
  /**
   * Its environment, as set on RunPod: AFFLATUS_TOKEN among it locks its ComfyUI from boot (LOCK_ENV). Null when RunPod did not
   * say it: then it is never written, as writing it replaces the whole of it and would wipe what is there.
   */
  env: Record<string, string> | null;
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

/** The variable of a pod's environment the node pack locks its ComfyUI with from its start (lock.py AFFLATUS_TOKEN). */
export const LOCK_ENV = "AFFLATUS_TOKEN";
/** And the one its watchdog arms itself with from its start, before Afflatus has said anything (watchdog.py). */
export const WATCHDOG_ENV = "AFFLATUS_WATCHDOG_MINUTES";

/** The secret of the account a pod's token is kept in (encrypted at RunPod, given to the pod at boot), and its reference. */
export const tokenSecret = (pod: string) => `afflatus-${pod.toLowerCase().replace(/[^a-z0-9_.-]/g, "")}`;
export const secretRef = (name: string) => `{{ RUNPOD_SECRET_${name} }}`;

/** RunPod answered in a shape Afflatus does not read: said as it is, never taken for "no pods". */
export class RunpodShape extends Error {}

/**
 * A date as RunPod gives it, as ms: ISO, or Go's way ("2026-10-13 10:00:00.000 +0000 UTC"). Null when it does not read: a
 * date taken as NaN would make a run cost nothing, and a cap would never be reached.
 */
export function podTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const go = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{4})?/.exec(value.trim());
  if (!go) return null;
  const zone = go[3] ? `${go[3].slice(0, 3)}:${go[3].slice(3)}` : "Z";
  const parsed = Date.parse(`${go[1]}T${go[2]}${zone}`);
  return Number.isNaN(parsed) ? null : parsed;
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
  env?: Record<string, string> | null;
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
  env: p.env && typeof p.env === "object" && !Array.isArray(p.env) ? { ...p.env } : null,
  uptime: p.runtime?.uptime ?? null,
  startedAt: podTime(p.startedAt) === null ? null : new Date(podTime(p.startedAt)!).toISOString(),
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
      const said = res.status === 429 ? "RunPod asks to slow down (too many requests): Afflatus asks it less often for a while." : res.status === 401 ? "RunPod refused the API key: check it in Settings › ComfyUI." : res.status === 409 ? "RunPod says the pod cannot do that now." : body?.detail ?? body?.title ?? `RunPod answered ${res.status}`;
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
      // a shape not read here is said, never taken for "no pods" (which would make every pod look deleted, its cost nothing)
      if (!got || !Array.isArray(got.pods)) throw new RunpodShape("RunPod answered the list of pods in a shape Afflatus does not know: nothing is stopped or counted until it is read again. Tell us if it lasts.");
      for (const p of got.pods) if (!p || typeof p.id !== "string" || typeof p.status !== "string") throw new RunpodShape("RunPod listed a pod without its id or its status: Afflatus does not know this answer's shape.");
      all.push(...got.pods.map(podOf));
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

  /**
   * A pod's environment and exposed ports set, for its next start: each one given replaces the whole of it (what is not in
   * it goes), what is not given stays as it is.
   */
  async update(id: string, change: { env?: Record<string, string>; ports?: string[] }): Promise<void> {
    await this.call(`/v2/pods/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) });
  }

  /** The account's secrets, by name: id only (RunPod never gives a secret's value back). */
  private async secrets(): Promise<Array<{ id: string; name: string }>> {
    const got = await this.call<unknown>("/v2/account/secrets");
    const list = Array.isArray(got) ? got : Array.isArray((got as { secrets?: unknown })?.secrets) ? (got as { secrets: unknown[] }).secrets : [];
    return list.filter((x): x is { id: string; name: string } => Boolean(x && typeof (x as { id?: unknown }).id === "string" && typeof (x as { name?: unknown }).name === "string"));
  }

  /** A secret of the account set to `value`: made, or its value replaced when it is there already. */
  async putSecret(name: string, value: string, description: string): Promise<void> {
    try {
      await this.call("/v2/account/secrets", { method: "POST", body: JSON.stringify({ name, value, description }) });
    } catch (err) {
      if ((err as RunpodError).status !== 409) throw err;
      const found = (await this.secrets()).find((x) => x.name === name);
      if (!found) throw err;
      await this.call(`/v2/account/secrets/${encodeURIComponent(found.id)}`, { method: "PATCH", body: JSON.stringify({ value }) });
    }
  }

  /** A secret of the account deleted; nothing when there is none by that name. */
  async deleteSecret(name: string): Promise<void> {
    const found = (await this.secrets()).find((x) => x.name === name);
    if (found) await this.call(`/v2/account/secrets/${encodeURIComponent(found.id)}`, { method: "DELETE" });
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
