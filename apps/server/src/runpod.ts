import { envSaid } from "./config";

/**
 * RunPod, as Afflatus talks to it for a rented machine (rented.ts): the user's pods read with their API key, a pod started,
 * stopped or deleted when the user asks (or its idle time, its cap or Terminate says so), and one deployed when the user
 * presses Deploy, never otherwise. API v2 (https://api.runpod.io/v2), the account's balance through its GraphQL.
 * RUNPOD_API_URL points it at a pretend RunPod (the demo, the tests); RUNPOD_PROXY says how a pod's ComfyUI is reached.
 */

export type PodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED";
export type PodAction = "start" | "stop" | "restart" | "terminate";

/** A pod as Afflatus keeps it: what the list says of it that matters here. */
export interface Pod {
  id: string;
  name: string;
  status: PodStatus;
  /**
   * USD an hour while it runs, as RunPod bills it: its GPU's price and its own disks (the container disk and a pod volume,
   * billed while it runs: `runningRate`). 0 while it is stopped, as RunPod says its price then: the rate is kept from when it
   * ran. A network volume is billed apart, every month.
   */
  cost: number;
  /** Of it, the GPU's price alone (RunPod's `cost`). */
  gpuCost: number;
  /** Its container disk in GB: billed while it runs, erased at a stop. */
  containerGb: number;
  gpu: string | null;
  gpuCount: number;
  dataCenter: string | null;
  /** The exposed ports, as "8188/http". */
  ports: string[];
  /** Its own disk in GB (kept while stopped, billed then); 0 without one. */
  diskGb: number;
  /** A network volume is mounted: what is on it outlives the pod. */
  networkVolume: boolean;
  /** Which one, by id: one running pod per volume (two writing on one would spoil what it holds). */
  volumeId: string | null;
  /**
   * Its environment, as set on RunPod: AFFLATUS_TOKEN among it locks its ComfyUI from boot (LOCK_ENV). Null when RunPod did not
   * say it: then it is never written, as writing it replaces the whole of it and would wipe what is there.
   */
  env: Record<string, string> | null;
  /** The CUDA its host's driver offers ("13.2"), as RunPod says it once the pod is on a host; null before, or not said. */
  hostCuda: string | null;
  /** The image it runs, as RunPod says it. */
  image: string | null;
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
/**
 * What the watchdog does when this PC goes silent (watchdog.py): "terminate" for a pod that keeps nothing when stopped (no
 * volume: its container disk is erased, its GPU may be taken), so that nothing is left of it on the account; "stop" otherwise.
 */
export const WATCHDOG_ACTION_ENV = "AFFLATUS_WATCHDOG_ACTION";

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

/** A pod's machine id: "rp-" and its id, as a machine id may be written (lower-case letters, digits, dashes; 24 at most). */
export const podMachineId = (pod: string) => `rp-${pod.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 21)}`;

/** The ComfyUI port a pod must expose over HTTP for Afflatus to reach it. */
export const COMFY_PORT = 8188;
/**
 * The port the Afflatus image (0.1.12 on) serves its boot log on, to the pod's token only (deploy/runpod/bootlog.py):
 * exposed on a pod deployed with that image. An older one has nothing there, and nothing is said of it (podBoot.ts).
 */
export const BOOT_PORT = 8189;
/** What a running pod's own disk costs, USD per GB and month (RunPod's price for the volume disk of a running pod). */
export const RUNNING_DISK_PER_GB_MONTH = 0.1;
/** What a stopped pod's own disk costs, USD per GB and month (RunPod's price for the volume disk of a stopped pod). */
export const STOPPED_DISK_PER_GB_MONTH = 0.2;
/** The hours of a month RunPod's monthly prices of storage are billed over, by the hour (365 × 24 / 12). */
export const HOURS_A_MONTH = 730;

/**
 * What a running pod costs an hour: its GPU's price (RunPod's `cost`, the GPU alone) and its disks while it runs, the
 * container disk and its pod volume at RUNNING_DISK_PER_GB_MONTH (a 120 GB container disk adds $0.0164 to an A40's $0.59:
 * RunPod's console says $0.61). 0 when RunPod says no price (a pod stopped).
 */
export const runningRate = (gpuCost: number, containerGb: number, diskGb: number): number =>
  gpuCost > 0 ? gpuCost + ((Math.max(0, containerGb) + Math.max(0, diskGb)) * RUNNING_DISK_PER_GB_MONTH) / HOURS_A_MONTH : 0;

/**
 * What a GPU deployed from Afflatus runs. "afflatus": ComfyUI, its Manager and the node pack (deploy/runpod), locked from
 * its first second; "runpod": RunPod's own ComfyUI image, without the node pack (so without the lock and the watchdog).
 * Each pinned to one version, so that a deploy runs what Afflatus was tested with.
 */
export const POD_IMAGES = {
  afflatus: () => envSaid.podImage()?.trim() || "ghcr.io/bardak971/afflatus-pod:0.1.34",
  runpod: () => "runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8",
} as const;
/** The first Afflatus pod image whose ComfyUI's death is always reported, as "comfy_died" (died.py, broken.py). */
const REPORTS_DEATH_FROM = [0, 1, 19];
/**
 * Whether a pod's image reports its ComfyUI's death (0.1.19 and later): a render merely gone from it (its prompt cleared from
 * ComfyUI's own page) is then no death. Not known (a pod added by hand, an image of one's own): false.
 */
export function reportsDeath(image: string): boolean {
  const v = /\/afflatus-pod:(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(image)?.slice(1).map(Number);
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== REPORTS_DEATH_FROM[i]) return v[i]! > REPORTS_DEATH_FROM[i]!;
  return true;
}

/**
 * The Afflatus image comes in two builds of the same PyTorch (2.10): for CUDA 13.0, the default (as most ComfyUIs at home run
 * it now, and faster on recent cards), and for CUDA 12.8 ("-cu128"), for a GPU whose hosts do not offer 13. A host runs an
 * image whose CUDA is not newer than its driver's.
 */
export const imageFor = (template: keyof typeof POD_IMAGES, cuda13: boolean): { image: string; minCuda: string } =>
  template === "afflatus" ? (cuda13 ? { image: POD_IMAGES.afflatus(), minCuda: "13.0" } : { image: `${POD_IMAGES.afflatus()}-cu128`, minCuda: MIN_CUDA }) : { image: POD_IMAGES.runpod(), minCuda: MIN_CUDA };
/** The oldest CUDA a pod's host may have for either image (12.8): the list of GPUs is read for it. */
export const MIN_CUDA = "12.8";

/** How free a GPU is, as RunPod says it: overall and by data center. */
export type Availability = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** A GPU a pod can be deployed on: its price an hour on the cloud asked, and where it is free. */
export interface GpuOffer {
  id: string;
  name: string;
  /** Its memory, GB. */
  memory: number;
  price: number;
  availability: Availability;
  dataCenters: Array<{ id: string; availability: Availability }>;
  /** Its hosts offer CUDA 13 (the Afflatus image's default build); without, the CUDA 12.8 build runs there. */
  cuda13: boolean;
}

/** What RunPod billed one pod for an hour (GET /v2/billing/pods): its GPU, its disk, in USD. */
export interface BillRecord {
  pod: string;
  /** The hour it covers (ms). */
  start: number;
  end: number;
  amount: number;
  /** Of it, its own disk's: what a stopped pod still costs. */
  disk: number;
}

/** What RunPod billed one network volume for a stretch (GET /v2/billing/network-volumes), in USD. */
export interface VolumeBill {
  volume: string;
  start: number;
  end: number;
  amount: number;
}

/** A network volume of the account: what is on it outlives any pod, and a pod using it runs in its data center. */
export interface NetworkVolume {
  id: string;
  name: string;
  size: number;
  dataCenter: string;
}

/** What a pod is deployed with (POST /v2/pods). */
export interface PodSpec {
  name: string;
  image: string;
  gpu: string;
  cloud: "SECURE" | "COMMUNITY";
  dataCenter: string | null;
  /** Its container disk, GB: erased when it stops or is terminated. */
  disk: number;
  /** The oldest CUDA its host may have: the image's (imageFor). */
  minCuda: string;
  volume: string | null;
  ports: string[];
  env: Record<string, string>;
}

const AVAILABILITY = new Set<Availability>(["HIGH", "MEDIUM", "LOW", "NONE"]);
const availabilityOf = (v: unknown): Availability => (typeof v === "string" && AVAILABILITY.has(v.toUpperCase() as Availability) ? (v.toUpperCase() as Availability) : "NONE");

/**
 * Whether RunPod refused a deploy for want of a GPU: a 400 with words only (it has no code of its own), the GPU taken
 * between the list and the deploy. Read loosely, as the words are not documented.
 */
export const noCapacity = (err: unknown) => err instanceof RunpodError && err.status === 400 && /no longer any instances|not enough free|no (gpus? |instances? )?(are )?available|insufficient (gpu )?capacity|out of stock/i.test(err.message);

/** The demo and the tests ask no site on the internet (AFFLATUS_PRETEND_SITES): RunPod's own only when its env says a pretend one. */
const NOT_ASKED = "not sent: no site on the internet is asked here";

const apiBase = () => {
  const said = envSaid.runpodApi()?.trim();
  if (!said && envSaid.pretendSites()) throw new Error(`${NOT_ASKED} (RUNPOD_API_URL is not set)`);
  return (said || "https://api.runpod.io").replace(/\/+$/, "");
};

/** The address a pod's ComfyUI answers at: RunPod's proxy, unless RUNPOD_PROXY says another ({id}, {port}). */
export function podUrl(id: string, port = COMFY_PORT): string {
  const said = envSaid.runpodProxy()?.trim();
  if (!said && envSaid.pretendSites()) throw new Error(`${NOT_ASKED} (RUNPOD_PROXY is not set)`);
  const shape = said || "https://{id}-{port}.proxy.runpod.net";
  return shape.replaceAll("{id}", id).replaceAll("{port}", String(port));
}

/** Whether a pod exposes ComfyUI's port over HTTP. */
export const exposesComfy = (pod: Pick<Pod, "ports">) => pod.ports.some((p) => p === `${COMFY_PORT}/http`);

type RawPod = {
  id: string; name?: string; status?: string; cost?: number; disk?: number; actions?: string[];
  gpu?: { id?: string; count?: number } | null; dataCenterId?: string | null; ports?: string[];
  mounts?: { persistent?: { size?: number } | null; network?: Array<{ volumeId?: unknown } | null> | null } | null;
  env?: Record<string, string> | null;
  runtime?: { uptime?: number } | null; startedAt?: string | null;
  cudaVersion?: string | null; image?: string | null;
};

const podOf = (p: RawPod): Pod => ({
  id: p.id,
  name: p.name ?? p.id,
  status: (p.status ?? "ERROR") as PodStatus,
  cost: runningRate(typeof p.cost === "number" ? p.cost : 0, typeof p.disk === "number" ? p.disk : 0, p.mounts?.persistent?.size ?? 0),
  gpuCost: typeof p.cost === "number" ? p.cost : 0,
  containerGb: typeof p.disk === "number" ? p.disk : 0,
  gpu: p.gpu?.id ?? null,
  gpuCount: p.gpu?.count ?? (p.gpu ? 1 : 0),
  dataCenter: p.dataCenterId ?? null,
  ports: Array.isArray(p.ports) ? p.ports : [],
  diskGb: p.mounts?.persistent?.size ?? 0,
  networkVolume: Boolean(p.mounts?.network?.length),
  volumeId: typeof p.mounts?.network?.[0]?.volumeId === "string" ? (p.mounts.network[0].volumeId as string) : null,
  env: p.env && typeof p.env === "object" && !Array.isArray(p.env) ? { ...p.env } : null,
  hostCuda: typeof p.cudaVersion === "string" && p.cudaVersion ? p.cudaVersion : null,
  image: typeof p.image === "string" && p.image ? p.image : null,
  uptime: p.runtime?.uptime ?? null,
  startedAt: podTime(p.startedAt) === null ? null : new Date(podTime(p.startedAt)!).toISOString(),
  actions: (p.actions ?? []).filter((a): a is PodAction => ["start", "stop", "restart", "terminate"].includes(a)),
});

export class Runpod {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
    const res = await this.fetcher(`${apiBase()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: Error) => {
      throw new RunpodError(`RunPod did not answer: ${err.message}`, 0);
    });
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
    if (!res.ok) {
      const said = res.status === 429 ? "RunPod asks to slow down (too many requests): Afflatus asks it less often for a while." : res.status === 401 ? "RunPod refused the API key: check it in Settings › Rented GPUs." : res.status === 402 ? "RunPod refused: the balance is too low (it asks for at least an hour of the GPU). Add credit on RunPod, then deploy again." : res.status === 409 ? "RunPod says the pod cannot do that now." : body?.detail ?? body?.title ?? `RunPod answered ${res.status}`;
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

  /**
   * A pod's system log as RunPod keeps it (its host's side: the image's pull layer by layer, the container's create and
   * start), since `since` (RFC 3339) or its last 5000 lines: RunPod streams it (server-sent events) and holds the stream
   * open, so what came within `waitMs` is taken. Gone once the pod is terminated (404): read while it boots. Null when
   * RunPod did not answer, or does not have it.
   */
  async systemLog(id: string, since: string | null = null, waitMs = 2500): Promise<Array<{ ts: string; line: string }> | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), waitMs);
    const out: Array<{ ts: string; line: string }> = [];
    let rest = "";
    const take = (chunk: string) => {
      rest += chunk;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.startsWith("data:")) continue;
        const e = (() => { try { return JSON.parse(l.slice(5)) as { ts?: unknown; line?: unknown }; } catch { return null; } })();
        if (e && typeof e.ts === "string" && typeof e.line === "string") out.push({ ts: e.ts, line: e.line });
      }
    };
    try {
      const res = await this.fetcher(`${apiBase()}/v2/pods/${encodeURIComponent(id)}/logs?source=system&${since ? `since=${encodeURIComponent(since)}` : "tail=5000"}`, { headers: { Authorization: `Bearer ${this.key}`, Accept: "text/event-stream" }, signal: ac.signal });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const dec = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) take(dec.decode(chunk, { stream: true }));
      take("\n");
      return out;
    } catch {
      // the stream held open until the wait ended: what came is the answer; nothing came and no answer is null
      take("\n");
      return ac.signal.aborted ? out : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One pod, read on its own: the whole of its environment (the list may leave out what has no value), for writing it back.
   * Null when there is no such pod; from the list when RunPod does not answer for one pod.
   */
  async pod(id: string): Promise<Pod | null> {
    try {
      const got = await this.call<RawPod>(`/v2/pods/${encodeURIComponent(id)}`);
      if (!got || typeof got.id !== "string" || typeof got.status !== "string") throw new RunpodShape("RunPod answered one pod in a shape Afflatus does not know");
      return got.status === "TERMINATED" ? null : podOf(got);
    } catch (err) {
      if ((err as RunpodError).status === 404) return null;
      return (await this.pods()).find((p) => p.id === id && p.status !== "TERMINATED") ?? null;
    }
  }

  /**
   * Whether a pod is still on the account, asked of RunPod for that pod alone: false only when RunPod says there is no such
   * pod (or it is terminated); null when it does not answer. Before a pod missing from the list is taken for gone.
   */
  async exists(id: string): Promise<boolean | null> {
    try {
      const got = await this.call<RawPod>(`/v2/pods/${encodeURIComponent(id)}`);
      return Boolean(got && got.status !== "TERMINATED");
    } catch (err) {
      return (err as RunpodError).status === 404 ? false : null;
    }
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

  /**
   * The GPUs a pod can be deployed on now, on that cloud: those able to run CUDA 12.8 (MIN_CUDA), with their price an hour
   * and how free they are, overall and by data center.
   */
  async gpus(cloud: PodSpec["cloud"]): Promise<GpuOffer[]> {
    const got = await this.call<{ gpus?: unknown }>(`/v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=${cloud}&minCudaVersion=${MIN_CUDA}`);
    if (!got || !Array.isArray(got.gpus)) throw new RunpodShape("RunPod answered its list of GPUs in a shape Afflatus does not know.");
    const key = cloud === "COMMUNITY" ? "community" : "secure";
    return (got.gpus as Array<Record<string, unknown>>).flatMap((g) => {
      const price = (g.price as Record<string, unknown> | undefined)?.[key];
      if (typeof g.id !== "string" || typeof price !== "number" || price <= 0) return [];
      const dataCenters = Array.isArray(g.dataCenters) ? (g.dataCenters as Array<Record<string, unknown>>).filter((d) => typeof d.id === "string").map((d) => ({ id: d.id as string, availability: availabilityOf(d.availability) })) : [];
      // a GPU that is not NVIDIA's (RunPod lists AMD's too) runs neither image
      if (typeof g.manufacturer === "string" && g.manufacturer && !/nvidia/i.test(g.manufacturer)) return [];
      const cuda13 = Array.isArray(g.cudaVersions) && (g.cudaVersions as Array<{ version?: unknown; available?: unknown }>).some((c) => c.available !== false && typeof c.version === "string" && Number.parseFloat(c.version) >= 13);
      return [{ id: g.id, name: typeof g.name === "string" && g.name ? g.name : g.id, memory: typeof g.memory === "number" ? g.memory : 0, price, availability: availabilityOf(g.availability), dataCenters, cuda13 }];
    });
  }

  /** The account's network volumes. */
  async volumes(): Promise<NetworkVolume[]> {
    const got = await this.call<{ networkVolumes?: unknown }>("/v2/network-volumes");
    const list = Array.isArray(got?.networkVolumes) ? (got.networkVolumes as Array<Record<string, unknown>>) : [];
    return list.flatMap((v) => (typeof v.id === "string" && typeof v.dataCenter === "string" ? [{ id: v.id, name: typeof v.name === "string" ? v.name : v.id, size: typeof v.size === "number" ? v.size : 0, dataCenter: v.dataCenter }] : []));
  }

  /** A network volume made in a data center: billed every month from now, pod or not, until it is deleted. */
  async createVolume(name: string, size: number, dataCenter: string): Promise<NetworkVolume> {
    const got = await this.call<Record<string, unknown>>("/v2/network-volumes", { method: "POST", body: JSON.stringify({ name, size, dataCenter }) });
    if (!got || typeof got.id !== "string") throw new RunpodShape("RunPod made the volume but answered in a shape Afflatus does not know: look for it on RunPod.");
    return { id: got.id, name: typeof got.name === "string" ? got.name : name, size: typeof got.size === "number" ? got.size : size, dataCenter: typeof got.dataCenter === "string" ? got.dataCenter : dataCenter };
  }

  /** The data centers that take a standard network volume (not every one does), by id. */
  async volumeDataCenters(): Promise<string[]> {
    const got = await this.call<{ dataCenters?: unknown }>("/v2/catalog/datacenters?networkVolumeTypes=STANDARD");
    if (!got || !Array.isArray(got.dataCenters)) throw new RunpodShape("RunPod answered its list of data centers in a shape Afflatus does not know.");
    return (got.dataCenters as Array<Record<string, unknown>>).filter((d) => typeof d.id === "string" && Array.isArray(d.networkVolumeTypes) && d.networkVolumeTypes.includes("STANDARD")).map((d) => d.id as string);
  }

  /** A network volume made larger (RunPod never makes one smaller). */
  async growVolume(id: string, size: number): Promise<void> {
    await this.call(`/v2/network-volumes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ size }) });
  }

  /** A network volume deleted, with all it holds: its billing ends. */
  async deleteVolume(id: string): Promise<void> {
    await this.call(`/v2/network-volumes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** What RunPod billed each network volume, day by day, since `from` (ms); as the pods' bill, the last hours may be missing. */
  async volumeBilling(from: number, to = Date.now()): Promise<VolumeBill[]> {
    const got = await this.call<{ records?: unknown }>(`/v2/billing/network-volumes?bucketSize=day&startTime=${encodeURIComponent(new Date(from).toISOString())}&endTime=${encodeURIComponent(new Date(to).toISOString())}`);
    if (!got || !Array.isArray(got.records)) throw new RunpodShape("RunPod answered its billing of volumes in a shape Afflatus does not know.");
    return (got.records as Array<Record<string, unknown>>).flatMap((r) => {
      const start = typeof r.startTime === "string" ? Date.parse(r.startTime) : Number.NaN;
      const end = typeof r.endTime === "string" ? Date.parse(r.endTime) : Number.NaN;
      if (typeof r.networkVolumeId !== "string" || typeof r.totalAmount !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return [];
      return [{ volume: r.networkVolumeId, start, end, amount: r.totalAmount }];
    });
  }

  /** A pod deployed: one GPU type, in that data center (any RunPod picks when null). Billed from now. */
  async create(spec: PodSpec): Promise<Pod> {
    const body = {
      name: spec.name,
      image: spec.image,
      gpu: { id: spec.gpu, count: 1, minCudaVersion: spec.minCuda },
      cloud: spec.cloud,
      ...(spec.dataCenter ? { dataCenterIds: [spec.dataCenter] } : {}),
      disk: spec.disk,
      ...(spec.volume ? { mounts: { network: [{ volumeId: spec.volume, path: "/workspace" }] } } : {}),
      ports: spec.ports,
      env: spec.env,
    };
    // given longer than a read: an answer cut short may leave a pod made all the same (rented.ts deploy looks for it by name)
    const got = await this.call<RawPod>("/v2/pods", { method: "POST", body: JSON.stringify(body) }, 90_000);
    if (!got || typeof got.id !== "string") throw new RunpodShape("RunPod made the pod but answered in a shape Afflatus does not know: look for it on RunPod, and terminate it there if it is not added here.");
    return podOf(got);
  }

  /**
   * A pod's container uptime (s) from RunPod's GraphQL: its REST list says none of a booting pod, so this tells its image
   * pulled (no container yet: null) from its container started. Null too where RunPod does not answer or says nothing.
   */
  async uptime(id: string): Promise<number | null> {
    const res = await this.fetcher(`${apiBase()}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { pod(input: { podId: ${JSON.stringify(id)} }) { id runtime { uptimeInSeconds } } }` }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { data?: { pod?: { runtime?: { uptimeInSeconds?: unknown } | null } | null } } | null) : null;
    if (!res?.ok) await res?.body?.cancel().catch(() => {});
    const up = body?.data?.pod?.runtime?.uptimeInSeconds;
    return typeof up === "number" && Number.isFinite(up) && up >= 0 ? up : null;
  }

  /**
   * The account's balance in USD and what it spends an hour now (every pod and volume of the account), from RunPod's
   * GraphQL; null where it does not say. At zero RunPod stops every pod, and terminates those without a volume.
   */
  async balance(): Promise<{ balance: number | null; spendPerHr: number | null }> {
    const res = await this.fetcher(`${apiBase()}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { myself { clientBalance currentSpendPerHr } }" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number } } } | null) : null;
    const me = body?.data?.myself;
    return { balance: typeof me?.clientBalance === "number" ? me.clientBalance : null, spendPerHr: typeof me?.currentSpendPerHr === "number" ? me.currentSpendPerHr : null };
  }

  /**
   * What the S3 API needs that the API key can tell, from RunPod's GraphQL: the account's user id (an S3 API key's access
   * key) and the data centers whose volumes the S3 API serves (`dataCenters`' `s3apiEnabled`: asked and answered on
   * 2026-10-16, though RunPod's published spec does not list that query). Null where RunPod does not say.
   */
  async s3Facts(): Promise<{ user: string | null; dataCenters: string[] | null }> {
    const res = await this.fetcher(`${apiBase()}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { myself { id } dataCenters { id s3apiEnabled } }" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { data?: { myself?: { id?: unknown }; dataCenters?: unknown } } | null) : null;
    if (!res?.ok) await res?.body?.cancel().catch(() => {});
    const me = body?.data?.myself;
    // an empty list is not "none has it": RunPod said nothing then
    const list = Array.isArray(body?.data?.dataCenters) && body.data.dataCenters.length ? (body.data.dataCenters as Array<{ id?: unknown; s3apiEnabled?: unknown }>) : null;
    return {
      user: typeof me?.id === "string" && me.id ? me.id : null,
      dataCenters: list ? list.flatMap((d) => (typeof d.id === "string" && d.s3apiEnabled === true ? [d.id] : [])) : null,
    };
  }

  /**
   * What RunPod billed each pod, hour by hour, since `from` (ms): the reference for what the rented GPUs cost (its GPU and its
   * disk, every pod of the account). RunPod writes these some hours after the fact: the latest hours may be missing yet.
   */
  async billing(from: number, to = Date.now()): Promise<BillRecord[]> {
    // RunPod takes both ends or neither; the end is snapped up to its hour
    const got = await this.call<{ records?: unknown }>(`/v2/billing/pods?bucketSize=hour&startTime=${encodeURIComponent(new Date(from).toISOString())}&endTime=${encodeURIComponent(new Date(to).toISOString())}`);
    if (!got || !Array.isArray(got.records)) throw new RunpodShape("RunPod answered its billing in a shape Afflatus does not know.");
    return (got.records as Array<Record<string, unknown>>).flatMap((r) => {
      const start = typeof r.startTime === "string" ? Date.parse(r.startTime) : Number.NaN;
      const end = typeof r.endTime === "string" ? Date.parse(r.endTime) : Number.NaN;
      if (typeof r.podId !== "string" || typeof r.totalAmount !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return [];
      return [{ pod: r.podId, start, end, amount: r.totalAmount, disk: typeof r.diskAmount === "number" ? r.diskAmount : 0 }];
    });
  }
}
