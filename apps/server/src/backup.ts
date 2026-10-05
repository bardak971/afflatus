import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { Services } from "./services";
import { ZipStream } from "./zipStream";

/**
 * One zip of everything Afflatus keeps: the database (a consistent copy made by SQLite while the app runs,
 * so nothing has to stop) and every file in the data folder (the library's pictures, videos and sounds,
 * the thumbnails, the side files of a render). Streamed as it is made: a library of many gigabytes does
 * not sit in memory. Restoring is unpacking the zip into an empty data folder with Afflatus stopped.
 *
 * Not in it: the files of linked folders (they are the user's own, on their disk, and Afflatus only
 * points at them), ComfyUI's models, and a Postgres database (that one is backed up with Postgres's tools).
 */

export interface BackupPlaces {
  /** Where the SQLite database file lives (DATA_DIR). */
  dataDir: string;
  /** Where the files live (DATA_DIR/files on a PC; the storage's own folder in a test). */
  filesDir: string;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function* walk(dir: string, base = dir): AsyncGenerator<{ path: string; rel: string; mtime: Date }> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base);
    else if (e.isFile()) yield { path: p, rel: relative(base, p).replace(/\\/g, "/"), mtime: (await stat(p)).mtime };
  }
}

export function registerBackup(app: FastifyInstance, s: Services, places: BackupPlaces | undefined): void {
  /** What a backup would hold: how many files, how many bytes, and whether the database comes with it. */
  app.get("/api/backup", async () => {
    if (!places) return { available: false, files: 0, bytes: 0, database: false };
    let files = 0;
    let bytes = 0;
    for await (const f of walk(places.filesDir)) {
      files++;
      bytes += (await stat(f.path)).size;
    }
    const db = s.dbKind === "sqlite" ? await stat(join(places.dataDir, "afflatus.db")).then((x) => x.size).catch(() => 0) : 0;
    return { available: true, files, bytes: bytes + db, database: s.dbKind === "sqlite" };
  });

  /** The backup itself, as a download. */
  app.get("/api/backup.zip", async (req, reply) => {
    if (!places) throw Object.assign(new Error("This server was started without a data folder to back up."), { statusCode: 404 });
    const zip = new ZipStream();
    const name = `afflatus-backup-${stamp()}.zip`;
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${name}"`).header("Cache-Control", "no-store");
    // what is written is a promise that runs beside the reply; the reply takes the stream now
    void (async () => {
      let tmp: string | null = null;
      try {
        const readme = [
          `Afflatus backup, made ${new Date().toISOString()} by Afflatus ${process.env.AFFLATUS_VERSION?.trim() || "dev"}.`,
          "",
          "What is in it: afflatus.db (the database: library, settings, timelines, presets; a consistent copy made while the app ran)",
          "and files/ (every picture, video, sound, thumbnail and side file the library holds).",
          "Not in it: the files of linked folders (they stay where they are on your disk), and ComfyUI's models.",
          "",
          "To restore: stop Afflatus, empty its data folder (or point DATA_DIR at a new one), unpack this zip into it so that",
          "afflatus.db and files/ sit at its top, and start Afflatus again. Settings, the library and the timelines come back as they were;",
          "linked folders are found again at their paths when they still exist there.",
          "",
        ].join("\n");
        await zip.add("README.txt", Readable.from([Buffer.from(readme, "utf8")]));
        if (s.dbKind === "sqlite") {
          // SQLite's own consistent copy: a complete database file as of now, with the app running
          tmp = await mkdtemp(join(tmpdir(), "afflatus-backup-"));
          const copy = join(tmp, "afflatus.db");
          await sql`VACUUM INTO ${copy}`.execute(s.db);
          await zip.add("afflatus.db", createReadStream(copy), new Date());
        }
        for await (const f of walk(places.filesDir)) {
          if (req.raw.destroyed) break;
          await zip.add(`files/${f.rel}`, createReadStream(f.path), f.mtime);
        }
        await zip.finish();
      } catch (err) {
        zip.abort(err as Error);
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return reply.send(zip.out);
  });
}
