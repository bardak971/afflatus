import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ModelInfo } from "@afflatus/core";
import { civitaiGet } from "./civitai";
import { now, type Db } from "./db";
import { modelDirs, readLocalHeader } from "./modelFiles";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Whether Civitai has a newer version of a model file than the one on this ComfyUI. Civitai knows a
 * file by its hash: the fingerprint kohya's trainer writes in a LoRA's header, or the SHA-256 of the whole
 * file, computed once here for files on this disk (a few seconds per gigabyte, so a handful per check).
 * One request per model page, not per file. Nothing is asked unless Civitai lookups are on; a check runs
 * on request, and once a day when the user asked for that. Nothing is fetched or replaced by itself.
 */

/** The folders worth checking: the ones that hold models with versions. */
export const UPDATE_FOLDERS = ["checkpoints", "diffusion_models", "loras"] as const;
/** How many files are hashed in one check: a 6 GB checkpoint takes a while. The rest wait for the next check. */
const HASHES_PER_CHECK = 6;

export interface UpdateRow {
  folder: string;
  /** The file as ComfyUI lists it. */
  file: string;
  modelId: number;
  modelName: string;
  /** The version this file is. */
  versionId: number;
  versionName: string;
  /** The newest version on Civitai, when it is not this one. */
  newer: { id: number; name: string; publishedAt: string | null; file: string | null; page: string } | null;
  checkedAt: string;
}

export interface UpdateReport {
  items: UpdateRow[];
  /** Files that could not be matched to a Civitai version: not read yet, not on this disk, or not on Civitai. */
  unmatched: number;
  /** Files whose hash is still to be computed (more checks will get to them). */
  hashesLeft: number;
  checkedAt: string | null;
  lookups: boolean;
}

type ApiVersionBrief = { id: number; name?: string; modelId?: number; createdAt?: string; publishedAt?: string; model?: { name?: string }; files?: Array<{ name?: string; primary?: boolean }> };
type ApiModelBrief = { id: number; name: string; modelVersions?: ApiVersionBrief[] };

const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();

/** The SHA-256 of a file, streamed. */
export function sha256Of(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (d) => hash.update(d)).on("end", () => done(hash.digest("hex").toUpperCase())).on("error", fail);
  });
}

export class Updates {
  /** The last full check, in memory: the table has the rows, this has the counts. */
  last: UpdateReport | null = null;
  private running: Promise<UpdateReport> | null = null;

  constructor(private readonly s: Services) {}

  async report(): Promise<UpdateReport> {
    const rows = await this.s.db.selectFrom("model_updates").selectAll().execute();
    const settings = await readSettings(this.s.db);
    return {
      items: rows.map(rowView),
      unmatched: this.last?.unmatched ?? 0,
      hashesLeft: this.last?.hashesLeft ?? 0,
      checkedAt: rows.map((r) => r.checked_at).sort().at(-1) ?? null,
      lookups: settings.civitaiLookups,
    };
  }

  /** One check; a second ask while one runs gets the same one. */
  check(): Promise<UpdateReport> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** The daily check, when the user asked for it and the last one is older than a day. */
  async daily(): Promise<void> {
    const settings = await readSettings(this.s.db);
    if (!settings.civitaiLookups || !settings.updateChecks) return;
    const last = (await this.s.db.selectFrom("model_updates").select("checked_at").orderBy("checked_at", "desc").limit(1).executeTakeFirst())?.checked_at;
    if (last && Date.now() - Date.parse(last) < 24 * 60 * 60_000) return;
    await this.check().catch((err) => console.warn("[updates]", (err as Error).message));
  }

  private async run(): Promise<UpdateReport> {
    const db = this.s.db;
    const settings = await readSettings(db);
    if (!settings.civitaiLookups) return { items: [], unmatched: 0, hashesLeft: 0, checkedAt: null, lookups: false };
    const comfy = await this.s.comfy();
    const key = settings.civitaiKey;
    const at = now();
    let unmatched = 0;
    let hashesLeft = 0;
    let hashed = 0;
    /** version id → the files that are it */
    const byVersion = new Map<number, Array<{ folder: string; file: string }>>();

    for (const folder of UPDATE_FOLDERS) {
      const files = (await comfy.client.models(folder).catch(() => [] as string[])).filter((f) => /\.safetensors$/i.test(f));
      if (!files.length) continue;
      const infoRows = await db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
      const known = await db.selectFrom("model_updates").select(["name", "version_id"]).where("folder", "=", folder).execute();
      const pages = await db.selectFrom("model_pages").select(["name", "url"]).where("folder", "=", folder).execute();
      const dirs = await modelDirs(settings.comfyDir, folder);
      for (const file of files) {
        const name = nameOf(file);
        // already matched once: its version does not change
        const was = known.find((k) => k.name === name);
        if (was) {
          byVersion.set(was.version_id, [...(byVersion.get(was.version_id) ?? []), { folder, file }]);
          continue;
        }
        const infoRow = infoRows.find((r) => r.file === file) ?? infoRows.find((r) => nameOf(r.file) === name);
        const info: ModelInfo & { sha256?: string } = infoRow ? JSON.parse(infoRow.info) : {};
        // the page the user or a lookup already tied to the file names the version
        const page = pages.find((p) => p.name === name);
        const fromPage = page ? /modelVersionId=(\d+)/.exec(page.url)?.[1] : undefined;
        let version: ApiVersionBrief | null = null;
        if (fromPage) version = await civitaiGet<ApiVersionBrief>(`/api/v1/model-versions/${fromPage}`, key).catch(() => null);
        // the file's own hash: the trainer's fingerprint, else the SHA-256 of the file, computed once for a file on this disk
        let hash = info.fingerprint ?? info.sha256;
        if (!version && !hash && dirs.length) {
          if (hashed < HASHES_PER_CHECK) {
            const header = await readLocalHeader(dirs, file);
            if (header) {
              const path = await whereIs(dirs, file);
              if (path) {
                hashed++;
                hash = await sha256Of(path).catch(() => undefined);
                if (hash && infoRow) {
                  await db.updateTable("model_info").set({ info: JSON.stringify({ ...info, sha256: hash }) }).where("folder", "=", folder).where("file", "=", infoRow.file).execute();
                }
              }
            }
          } else hashesLeft++;
        }
        if (!version && hash) version = await civitaiGet<ApiVersionBrief>(`/api/v1/model-versions/by-hash/${hash}`, key).catch(() => null);
        if (!version?.modelId) {
          unmatched++;
          continue;
        }
        await db
          .insertInto("model_updates")
          .values({
            folder, name, file, model_id: version.modelId, model_name: version.model?.name ?? "", version_id: version.id, version_name: version.name ?? "",
            latest_id: null, latest_name: null, latest_at: null, latest_file: null, checked_at: at,
          })
          .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ file, model_id: version!.modelId!, version_id: version!.id, version_name: version!.name ?? "", checked_at: at }))
          .execute();
        byVersion.set(version.id, [...(byVersion.get(version.id) ?? []), { folder, file }]);
      }
    }

    // one model page per model: its newest version against each file's
    const rows = await db.selectFrom("model_updates").selectAll().execute();
    const models = [...new Set(rows.map((r) => r.model_id))];
    for (const modelId of models) {
      const m = await civitaiGet<ApiModelBrief>(`/api/v1/models/${modelId}`, key).catch(() => null);
      if (!m?.modelVersions?.length) continue;
      // Civitai lists versions newest first
      const versions = [...m.modelVersions].sort((a, b) => Date.parse(b.publishedAt ?? b.createdAt ?? "0") - Date.parse(a.publishedAt ?? a.createdAt ?? "0"));
      const latest = versions[0]!;
      for (const r of rows.filter((x) => x.model_id === modelId)) {
        const mine = versions.findIndex((v) => v.id === r.version_id);
        const newer = latest.id !== r.version_id && (mine < 0 || mine > 0);
        const primary = latest.files?.find((f) => f.primary) ?? latest.files?.[0];
        await db
          .updateTable("model_updates")
          .set({
            model_name: m.name, checked_at: at,
            latest_id: newer ? latest.id : null, latest_name: newer ? (latest.name ?? "") : null,
            latest_at: newer ? (latest.publishedAt ?? latest.createdAt ?? null) : null, latest_file: newer ? (primary?.name ?? null) : null,
          })
          .where("folder", "=", r.folder).where("name", "=", r.name)
          .execute();
      }
    }
    const report = await this.report();
    this.last = { ...report, unmatched, hashesLeft };
    return this.last;
  }
}

const rowView = (r: { folder: string; file: string; model_id: number; model_name: string; version_id: number; version_name: string; latest_id: number | null; latest_name: string | null; latest_at: string | null; latest_file: string | null; checked_at: string }): UpdateRow => ({
  folder: r.folder, file: r.file, modelId: r.model_id, modelName: r.model_name, versionId: r.version_id, versionName: r.version_name,
  newer: r.latest_id ? { id: r.latest_id, name: r.latest_name ?? "", publishedAt: r.latest_at, file: r.latest_file, page: `https://civitai.com/models/${r.model_id}?modelVersionId=${r.latest_id}` } : null,
  checkedAt: r.checked_at,
});

async function whereIs(dirs: string[], file: string): Promise<string | null> {
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const rel = file.replace(/\\/g, "/");
  for (const d of dirs) {
    const p = join(d, rel);
    try {
      await access(p);
      return p;
    } catch {
      // next directory
    }
  }
  return null;
}

export function registerModelUpdates(app: FastifyInstance, s: Services, updates: Updates): void {
  /** What is known: each matched file, its version, and the newer one when there is one. */
  app.get("/api/models/updates", async () => updates.report());
  /** Check now. Hashes a few more files each time; asks Civitai once per model. */
  app.post("/api/models/updates/check", async () => updates.check());
  /** A file's row forgotten: it is matched again at the next check (after the user replaced it, say). */
  app.delete<{ Params: { folder: string }; Querystring: { file: string } }>("/api/models/updates/:folder", async (req) => {
    await s.db.deleteFrom("model_updates").where("folder", "=", req.params.folder).where("name", "=", nameOf(req.query.file)).execute();
    return { ok: true };
  });
}

export type { Db };
