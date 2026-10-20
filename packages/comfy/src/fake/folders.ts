import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

type Job = { id: string; state: "downloading" | "done" | "error" | "stopped"; bytes: number; total: number; error?: string; path: string; stop: AbortController; url: string; expired: boolean; folder: string; filename: string };

/** The loader node and input that pick a model folder's file: a file come into the folder is among its choices, as ComfyUI's node list has it. */
const LOADERS: Record<string, [string, string]> = { checkpoints: ["CheckpointLoaderSimple", "ckpt_name"], diffusion_models: ["UNETLoader", "unet_name"], loras: ["LoraLoader", "lora_name"], vae: ["VAELoader", "vae_name"], text_encoders: ["CLIPLoader", "clip_name"] };

/** A file the pack brought, offered by its folder's loader from now on (ComfyUI lists its folders afresh on /object_info). */
function offered(fake: FakeState, folder: string, file: string): void {
  const loader = LOADERS[folder];
  const spec = loader && (fake.catalog[loader[0]]?.input.required?.[loader[1]] as unknown[] | undefined);
  const list = Array.isArray(spec?.[0]) ? (spec![0] as string[]) : (spec?.[1] as { options?: string[] } | undefined)?.options;
  if (list && !list.includes(file)) list.push(file);
}
type Upload = { id: string; state: "uploading" | "done" | "error" | "stopped"; bytes: number; total: number; error?: string; path: string };

/**
 * ComfyUI's model folders on a real disk (init.folderPaths): what /internal/folder_paths says (unless
 * `hideFolderPaths`, as an older ComfyUI), the files a model folder lists besides the pretend ones, and the
 * Afflatus node pack's download (POST /afflatus/download, from 0.11.0): it fetches the address it is given
 * into the folder's first path, asking again from where it stopped when the connection is cut, as the pack does.
 * A source's own link (not Afflatus's one-time address) refused half way has expired: the download waits for a
 * fresh one (POST /afflatus/download/<id>/url, 0.12.0) and carries on from where it was. And the pack's upload (0.14.0):
 * a file sent a piece at a time (PUT /afflatus/upload/<id>?offset=), at the byte the upload is at, named once whole.
 */
export function fakeFolders(fake: FakeState): (r: FakeRequest) => boolean {
  const jobs = new Map<string, Job>();
  const uploads = new Map<string, Upload>();
  const relay = (url: string) => /\/api\/downloads\/fetch\//.test(url);
  const run = async (job: Job) => {
    const part = `${job.path}.part`;
    let have = 0;
    for (let tries = 0; tries < 5 && job.state === "downloading"; tries++) {
      try {
        const url = job.url;
        fake.packFetched.push(url);
        const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.stop.signal });
        if (res.status === 403 && !relay(url)) {
          await res.body?.cancel();
          job.expired = true;
          for (let waited = 0; job.url === url && waited < 5000 && job.state === "downloading"; waited += 20) await new Promise((r) => setTimeout(r, 20));
          job.expired = false;
          if (job.url === url) throw new Error("the download link expired, and no fresh one came");
          tries--;
          continue;
        }
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
        offered(fake, job.folder, job.filename);
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

  return ({ method, path, url, raw, json, plain }) => {
    const paths = fake.folderPaths;
    if (!paths) return false;
    if (method === "GET" && path === "/internal/folder_paths") return fake.hideFolderPaths ? json(404, {}) : json(200, paths);
    if (method === "GET" && path.startsWith("/models/")) {
      const folder = decodeURIComponent(path.slice(8));
      if (!paths[folder] && !fake.models[folder]) return false;
      return json(200, [...(fake.models[folder] ?? []), ...(paths[folder] ?? []).flatMap(filesUnder)]);
    }
    if (path.startsWith("/afflatus/upload") && fake.packVersion && atLeast(fake.packVersion, "0.14.0")) {
      if (method === "POST" && path === "/afflatus/upload") {
        const body = JSON.parse(raw.toString("utf8") || "{}") as { folder?: string; filename?: string; total?: number };
        const root = paths[body.folder ?? ""]?.[0];
        if (!root || !body.filename || /(^|[\/])\.\.([\/]|$)/.test(body.filename) || !(typeof body.total === "number" && body.total > 0)) return plain(400, "refused");
        const target = resolve(root, body.filename);
        if (existsSync(target) || [...uploads.values()].some((u) => u.path === target && u.state === "uploading")) return plain(409, "that file is there already, or being uploaded");
        if (fake.diskFree !== undefined && fake.diskFree < body.total) return plain(507, `the disk has ${fake.diskFree} bytes free, the file is ${body.total}`);
        mkdirSync(dirname(target), { recursive: true });
        const u: Upload = { id: randomUUID(), state: "uploading", bytes: 0, total: body.total, path: target };
        uploads.set(u.id, u);
        return json(200, { id: u.id, path: target });
      }
      const u = uploads.get(decodeURIComponent(path.slice("/afflatus/upload/".length)));
      if (!u) return json(404, {});
      const part = `${u.path}.${u.id.slice(0, 8)}.part`;
      if (method === "GET") return json(200, { state: u.state, bytes: u.bytes, total: u.total, error: u.error ?? null });
      if (method === "DELETE") {
        if (u.state === "uploading") u.state = "stopped";
        rmSync(part, { force: true });
        return json(200, { ok: true });
      }
      if (method === "PUT") {
        if (u.state !== "uploading") return plain(409, `the upload is ${u.state}`);
        const offset = Number(url.searchParams.get("offset"));
        if (offset !== u.bytes || offset + raw.length > u.total) return plain(409, `the upload is at byte ${u.bytes} of ${u.total}`);
        fake.packUploaded.push({ file: u.path, offset, bytes: raw.length });
        if (fake.uploadCut) {
          // a piece cut on its way: nothing of it is kept
          fake.uploadCut--;
          return plain(400, "the piece came short");
        }
        appendFileSync(part, raw);
        u.bytes += raw.length;
        if (u.bytes === u.total) {
          renameSync(part, u.path);
          u.state = "done";
        }
        return json(200, { state: u.state, bytes: u.bytes, total: u.total, error: null });
      }
      return false;
    }
    if (fake.packVersion && atLeast(fake.packVersion, "0.19.0")) {
      if (method === "GET" && path === "/afflatus/disk") {
        const free = fake.diskFree ?? 1e13;
        return json(200, { free, total: fake.diskTotal ?? 2 * free, downloading: 0 });
      }
      if (method === "POST" && path === "/afflatus/models/remove") {
        const body = JSON.parse(raw.toString("utf8") || "{}") as { folder?: string; filename?: string };
        if (!body.filename || /(^|[\\/])\.\.([\\/]|$)/.test(body.filename)) return plain(400, "refused");
        const found = (paths[body.folder ?? ""] ?? []).map((root) => resolve(root, body.filename!)).find((p) => existsSync(p));
        if (!found) return plain(404, "no such file");
        const size = statSync(found).size;
        rmSync(found);
        fake.removed.push(`${body.folder}/${body.filename}`);
        if (fake.diskFree !== undefined) fake.diskFree += size;
        return json(200, { removed: size });
      }
    }
    if (fake.packVersion && atLeast(fake.packVersion, "0.21.0") && method === "GET" && path === "/afflatus/models/list") {
      // each folder's files, its own directory's name as the path's first part, as the pack names them under models/
      const files = Object.entries(paths).flatMap(([folder, roots]) => (roots[0] ? filesUnder(roots[0]).map((name) => {
        const st = statSync(join(roots[0]!, name));
        return { folder, path: `${folder}/${name.split(/[\/]/).join("/")}`, name: name.split(/[\/]/).join("/"), bytes: st.size, modified: st.mtimeMs / 1000 };
      }) : []));
      return json(200, { files });
    }
    if (!path.startsWith("/afflatus/download") || !fake.packVersion || !atLeast(fake.packVersion, "0.11.0")) return false;
    if (method === "POST" && path === "/afflatus/download") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as { url?: string; folder?: string; filename?: string; total?: number };
      const root = paths[body.folder ?? ""]?.[0];
      if (!root || !body.url || !body.filename || /(^|[\\/])\.\.([\\/]|$)/.test(body.filename)) return plain(400, "refused");
      if (fake.diskFree !== undefined && body.total && fake.diskFree < body.total) return plain(507, `the disk has ${fake.diskFree} bytes free, the file is ${body.total}`);
      const target = resolve(root, body.filename);
      mkdirSync(dirname(target), { recursive: true });
      const job: Job = { id: randomUUID(), state: "downloading", bytes: 0, total: 0, path: target, stop: new AbortController(), url: body.url, expired: false, folder: body.folder ?? "", filename: body.filename };
      jobs.set(job.id, job);
      void run(job);
      return json(200, { id: job.id, path: target });
    }
    const renew = /^\/afflatus\/download\/([^/]+)\/url$/.exec(path);
    if (renew && method === "POST") {
      const job = jobs.get(decodeURIComponent(renew[1]!));
      if (!job) return json(404, {});
      job.url = (JSON.parse(raw.toString("utf8") || "{}") as { url: string }).url;
      return json(200, { ok: true });
    }
    const job = jobs.get(decodeURIComponent(path.slice("/afflatus/download/".length)));
    if (!job) return json(404, {});
    if (method === "GET") return json(200, { state: job.state, bytes: job.bytes, total: job.total, error: job.state === "error" ? job.error : undefined, expired: job.expired });
    if (method === "DELETE") {
      job.state = "stopped";
      job.stop.abort();
      return json(200, { ok: true });
    }
    return false;
  };
}
