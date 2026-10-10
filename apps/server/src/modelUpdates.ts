import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelInfo } from "@afflatus/core";
import { civitaiGet } from "./civitai";
import { now } from "./db";
import { fileName } from "./media";
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
const UPDATE_FOLDERS = ["checkpoints", "diffusion_models", "loras"] as const;
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
  /** Why the last check did not finish (ComfyUI away, the database): null once one has. */
  error: string | null;
}

type ApiVersionBrief = { id: number; name?: string; modelId?: number; createdAt?: string; publishedAt?: string; model?: { name?: string }; files?: Array<{ name?: string; primary?: boolean }> };
type ApiModelBrief = { id: number; name: string; modelVersions?: ApiVersionBrief[] };


/** The words of a version's name that say its precision or packing, not its content: int8, fp8, bf16, Q4_K_M, gguf, nf4, scaled, convrot. */
const PRECISION = /^(int\d+|fp\d+(e\dm\d(fn)?)?|bf16|nf4|gguf|q\d(k)?(m|s|l)?|scaled|convrot|pruned)$/i;
const tokensOf = (name: string) => name.toLowerCase().replace(/_/g, "").split(/[^a-z0-9.]+/).filter(Boolean);
/** A version's name with its precision words taken out: what it is. */
export const sansPrecision = (name: string) => tokensOf(name).filter((t) => !PRECISION.test(t)).join(" ");
/** A version's precision words alone, sorted: which variant it is. */
export const precisionOf = (name: string) => tokensOf(name).filter((t) => PRECISION.test(t)).sort().join(" ");

/** The SHA-256 of a file, streamed. */
function sha256Of(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (d) => hash.update(d)).on("end", () => done(hash.digest("hex").toUpperCase())).on("error", fail);
  });
}

export class Updates {
  /** The last full check, in memory: the table has the rows, this has the counts. */
  last: UpdateReport | null = null;
  /** Why the last check did not finish, for the report; null once one has. */
  private failed: string | null = null;
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
      error: this.failed,
    };
  }

  /** One check; a second ask while one runs gets the same one. Its failure is kept for the report as well as thrown. */
  check(): Promise<UpdateReport> {
    if (!this.running) {
      this.running = this.run()
        .then((r) => {
          this.failed = null;
          return { ...r, error: null };
        }, (err: Error) => {
          this.failed = err.message.slice(0, 300);
          throw err;
        })
        .finally(() => {
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
    // logged here, and said on the report (`error`) until a check goes through
    await this.check().catch((err) => console.warn("[updates] the daily check failed:", (err as Error).message));
  }

  /** A check: each file matched to its Civitai version, then the newest version of each model fetched and written beside its files. */
  private async run(): Promise<UpdateReport> {
    const db = this.s.db;
    const settings = await readSettings(db);
    if (!settings.civitaiLookups) return { items: [], unmatched: 0, hashesLeft: 0, checkedAt: null, lookups: false, error: null };
    const at = now();
    const { unmatched, hashesLeft } = await this.match(settings, at);
    // one model page per model: its newest version against each file's
    const rows = await db.selectFrom("model_updates").selectAll().execute();
    for (const modelId of new Set(rows.map((r) => r.model_id))) {
      const m = await civitaiGet<ApiModelBrief>(`/api/v1/models/${modelId}`, settings.civitaiKey).catch(() => null);
      if (m?.modelVersions?.length) await this.writeNewest(m, rows.filter((x) => x.model_id === modelId), at);
    }
    const report = await this.report();
    this.last = { ...report, unmatched, hashesLeft };
    return this.last;
  }

  /**
   * Each model file of this ComfyUI matched to the Civitai version it is, once: by the page tied to it, else by its
   * hash (the trainer's fingerprint, else the SHA-256 of the file, computed for a few files on this disk per check).
   */
  private async match(settings: Awaited<ReturnType<typeof readSettings>>, at: string): Promise<{ unmatched: number; hashesLeft: number }> {
    const db = this.s.db;
    const comfy = await this.s.comfy();
    const key = settings.civitaiKey;
    let unmatched = 0;
    let hashesLeft = 0;
    let hashed = 0;
    for (const folder of UPDATE_FOLDERS) {
      const files = (await comfy.client.models(folder).catch(() => [] as string[])).filter((f) => /\.safetensors$/i.test(f));
      if (!files.length) continue;
      const infoRows = await db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
      const known = await db.selectFrom("model_updates").select(["name"]).where("folder", "=", folder).execute();
      const pages = await db.selectFrom("model_pages").select(["name", "url"]).where("folder", "=", folder).execute();
      const dirs = await modelDirs(settings.comfyDir, folder);
      for (const file of files) {
        const name = fileName(file);
        // already matched once: its version does not change
        if (known.some((k) => k.name === name)) continue;
        const infoRow = infoRows.find((r) => r.file === file) ?? infoRows.find((r) => fileName(r.file) === name);
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
                  // what was read off the files changed: whoever keeps it reads it again
                  this.s.queue.events.emit("models");
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
      }
    }
    return { unmatched, hashesLeft };
  }

  /** A model's newest version, written on each of its files' rows when it is newer than the file (and not only another precision of it). */
  private async writeNewest(m: ApiModelBrief, rows: Array<{ folder: string; name: string; version_id: number; version_name: string }>, at: string): Promise<void> {
    // Civitai lists versions newest first
    const versions = [...(m.modelVersions ?? [])].sort((a, b) => Date.parse(b.publishedAt ?? b.createdAt ?? "0") - Date.parse(a.publishedAt ?? a.createdAt ?? "0"));
    for (const r of rows) {
      const mine = versions.findIndex((v) => v.id === r.version_id);
      // the versions published after the one here; among them, the one of the same precision when there is one (an
      // int8 file is told about the next int8, not about an int4 sibling); a sibling that only differs by precision is no update
      const after = versions.slice(0, mine < 0 ? versions.length : mine).filter((v) => v.id !== r.version_id);
      const latest = after.find((v) => precisionOf(v.name ?? "") === precisionOf(r.version_name)) ?? after[0];
      const newer = Boolean(latest) && sansPrecision(latest!.name ?? "") !== sansPrecision(r.version_name);
      const primary = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0];
      await this.s.db
        .updateTable("model_updates")
        .set({
          model_name: m.name, checked_at: at,
          latest_id: newer ? latest!.id : null, latest_name: newer ? (latest!.name ?? "") : null,
          latest_at: newer ? (latest!.publishedAt ?? latest!.createdAt ?? null) : null, latest_file: newer ? (primary?.name ?? null) : null,
        })
        .where("folder", "=", r.folder).where("name", "=", r.name)
        .execute();
    }
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
  app.delete("/api/models/updates/:folder", async (req) => {
    const { folder } = z.object({ folder: z.enum(UPDATE_FOLDERS) }).parse(req.params);
    const { file } = z.object({ file: z.string().min(1).max(400) }).parse(req.query);
    await s.db.deleteFrom("model_updates").where("folder", "=", folder).where("name", "=", fileName(file)).execute();
    return { ok: true };
  });
}
