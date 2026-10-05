import { randomUUID } from "node:crypto";
import type { Comfy } from "./comfy";
import { httpError } from "./errors";

/**
 * Node packs a workflow uses that this ComfyUI lacks, installed through ComfyUI-Manager's task
 * queue: the same path as Manager's own "Install missing custom nodes". Which pack a node type comes
 * from is taken from the workflow when it says (the cnr_id its author's ComfyUI wrote), else from
 * Manager's own map of node types to packs. Manager clones the pack into custom_nodes and runs its pip
 * requirements; ComfyUI only reads that folder at start, so nothing works until it is restarted.
 */

/** Manager keeps a history per client: ours, so that the status read is not mixed with its own UI's tasks. */
const CLIENT = "afflatus";
const NO_MANAGER = "This ComfyUI has no ComfyUI-Manager, which does the installing. Turn it on in ComfyUI, then try again (Settings → Models → Missing models says how).";

export interface PackJob { pack: string; id: string }
export interface PacksStarted {
  jobs: PackJob[];
  /** Node types no pack is known for: neither the workflow nor Manager says where they come from. */
  unknown: string[];
  /** Packs Manager's queue cannot install (a single file or a gist, in its map): to be fetched by hand. */
  skipped: string[];
}
export interface PackState { id: string; state: "pending" | "done" | "failed"; message?: string }

type Mapping = Record<string, [string[], { title_aux?: string }]>;

/** What Manager installs for a pack's name: a registry id at its latest version, or a GitHub repository's nightly. Null for what its queue has no way to install. */
function target(pack: string) {
  const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s.]+)/i.exec(pack);
  if (github) return { id: github[1]!, version: "nightly", selected_version: "nightly", repository: pack.replace(/\.git$/, "").replace(/\/+$/, "") };
  if (/^https?:\/\//i.test(pack)) return null;
  return { id: pack, version: "latest", selected_version: "latest" };
}

const call = (comfy: Comfy, path: string, body?: unknown) =>
  fetch(comfy.client.baseUrl + path, body === undefined
    ? { signal: AbortSignal.timeout(15_000) }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });

/** Manager's map of node types to packs, when it has one; a registry id is preferred to a repository when both offer the type. */
async function mapping(comfy: Comfy): Promise<Mapping> {
  try {
    const res = await call(comfy, "/v2/customnode/getmappings?mode=cache");
    return res.ok ? ((await res.json()) as Mapping) : {};
  } catch {
    return {};
  }
}

/** Queue the install of every pack the missing node types come from, then start Manager's queue. */
export async function installPacks(comfy: Comfy, classes: string[], known: Record<string, string>): Promise<PacksStarted> {
  const packOf: Record<string, string> = {};
  const unresolved = classes.filter((c) => !known[c]);
  const map = unresolved.length ? await mapping(comfy) : {};
  const keys = Object.keys(map).sort((a, b) => Number(/^https?:/i.test(a)) - Number(/^https?:/i.test(b)));
  for (const c of classes) {
    const pack = known[c] ?? keys.find((k) => map[k]?.[0]?.includes(c));
    if (pack) packOf[c] = pack;
  }
  const unknown = classes.filter((c) => !packOf[c]);
  const jobs: PackJob[] = [];
  const skipped: string[] = [];
  for (const pack of [...new Set(Object.values(packOf))]) {
    const t = target(pack);
    if (!t) {
      skipped.push(pack);
      continue;
    }
    const id = randomUUID();
    let res: Response;
    try {
      res = await call(comfy, "/v2/manager/queue/task", { ui_id: id, client_id: CLIENT, kind: "install", params: { ...t, mode: "cache", channel: "default" } });
    } catch {
      throw httpError("ComfyUI is not answering.", 503);
    }
    if (res.status === 404) throw httpError(NO_MANAGER);
    if (!res.ok) throw httpError(`ComfyUI-Manager refused the install of ${pack} (${res.status}: ${(await res.text()).slice(0, 160)})`);
    jobs.push({ pack, id });
  }
  if (jobs.length) await call(comfy, "/v2/manager/queue/start", {}).catch(() => undefined);
  return { jobs, unknown, skipped };
}

/**
 * Where each queued install stands, from Manager's history of our tasks: not there yet is pending. With
 * it, how many packs were installed since ComfyUI started: Manager's history lives in ComfyUI's process,
 * so it is exactly what a restart would load (the page may have been reloaded since the installs).
 */
export async function packStatus(comfy: Comfy, ids: string[]): Promise<{ items: PackState[]; installed: number }> {
  let history: Record<string, { result?: string; status?: { status_str?: string } }> = {};
  try {
    const res = await call(comfy, `/v2/manager/queue/history?client_id=${CLIENT}`);
    if (res.status === 404) throw httpError(NO_MANAGER);
    if (res.ok) history = ((await res.json()) as { history?: typeof history }).history ?? {};
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
  }
  const okOf = (h: { result?: string; status?: { status_str?: string } }) => h.result === "success" || h.status?.status_str === "success";
  const installed = Object.values(history).filter((h) => (h as { kind?: string }).kind === "install" && okOf(h)).length;
  const items = ids.map((id): PackState => {
    const h = history[id];
    if (!h) return { id, state: "pending" };
    if (okOf(h)) return { id, state: "done" };
    // Manager's own refusal comes back as a bare "failed": its security level is the usual reason
    const message = !h.result || h.result === "failed"
      ? "ComfyUI-Manager did not install it. Its security_level (in user/__manager/config.ini) has to be normal or weaker for installs from Afflatus; check ComfyUI's log."
      : h.result.slice(0, 300);
    return { id, state: "failed", message };
  });
  return { items, installed };
}
