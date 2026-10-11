import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { FakeRequest, FakeState } from "../testing";

/** Whether version `a` is `b` or newer, part by part as numbers. */
const atLeast = (a: string, b: string) => {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

/** The model files under a directory, as ComfyUI lists them: relative paths, sub-folders with the system's separator. A .part is not a model. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!name.endsWith(".part")) out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out;
}

type Job = { id: string; state: "downloading" | "done" | "error" | "stopped"; bytes: number; total: number; error?: string; path: string; stop: AbortController };

/**
 * ComfyUI's model folders on a real disk (init.folderPaths): what /internal/folder_paths says (unless
 * `hideFolderPaths`, as an older ComfyUI), the files a model folder lists besides the pretend ones, and the
 * Afflatus node pack's download (POST /afflatus/download, from 0.11.0): it fetches the address it is given
 * into the folder's first path, asking again from where it stopped when the connection is cut, as the pack does.
 */
export function fakeFolders(fake: FakeState): (r: FakeRequest) => boolean {
  const jobs = new Map<string, Job>();
  const run = async (job: Job, url: string) => {
    const part = `${job.path}.part`;
    let have = 0;
    for (let tries = 0; tries < 5 && job.state === "downloading"; tries++) {
      try {
        const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.stop.signal });
        if (!res.ok || !res.body) throw new Error(`answered ${res.status}`);
        if (res.status !== 206) have = 0;
        const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]) : Number(res.headers.get("content-length"));
        if (total) job.total = total;
        const file = await open(part, have ? "a" : "w");
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            await file.write(chunk);
            have += chunk.length;
            job.bytes = have;
          }
        } finally {
          await file.close();
        }
        if (job.total && have < job.total) throw new Error("cut");
        renameSync(part, job.path);
        job.state = "done";
        return;
      } catch (err) {
        if (job.state !== "downloading") break;
        job.error = (err as Error).message;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    rmSync(part, { force: true });
    if (job.state === "downloading") job.state = "error";
  };

  return ({ method, path, raw, json, plain }) => {
    const paths = fake.folderPaths;
    if (!paths) return false;
    if (method === "GET" && path === "/internal/folder_paths") return fake.hideFolderPaths ? json(404, {}) : json(200, paths);
    if (method === "GET" && path.startsWith("/models/")) {
      const folder = decodeURIComponent(path.slice(8));
      if (!paths[folder] && !fake.models[folder]) return false;
      return json(200, [...(fake.models[folder] ?? []), ...(paths[folder] ?? []).flatMap(filesUnder)]);
    }
    if (!path.startsWith("/afflatus/download") || !fake.packVersion || !atLeast(fake.packVersion, "0.11.0")) return false;
    if (method === "POST" && path === "/afflatus/download") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as { url?: string; folder?: string; filename?: string };
      const root = paths[body.folder ?? ""]?.[0];
      if (!root || !body.url || !body.filename || /(^|[\\/])\.\.([\\/]|$)/.test(body.filename)) return plain(400, "refused");
      const target = resolve(root, body.filename);
      mkdirSync(dirname(target), { recursive: true });
      const job: Job = { id: randomUUID(), state: "downloading", bytes: 0, total: 0, path: target, stop: new AbortController() };
      jobs.set(job.id, job);
      void run(job, body.url);
      return json(200, { id: job.id, path: target });
    }
    const job = jobs.get(decodeURIComponent(path.slice("/afflatus/download/".length)));
    if (!job) return json(404, {});
    if (method === "GET") return json(200, { state: job.state, bytes: job.bytes, total: job.total, error: job.state === "error" ? job.error : undefined });
    if (method === "DELETE") {
      job.state = "stopped";
      job.stop.abort();
      return json(200, { ok: true });
    }
    return false;
  };
}
