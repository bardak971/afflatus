import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { VERSION } from "./config";
import { httpError } from "./errors";
import { fromThisComputer } from "./hostCheck";
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
 * Nor, unless asked for from this computer, the keys and tokens of the settings: a zip is a file that travels
 * (another disk, a cloud folder, a message), and the RunPod key alone spends the user's money.
 */

/**
 * The settings that hold a key or a token, blanked in the copy of a backup without them: each one is what lets
 * someone else act as this Afflatus somewhere (spend on RunPod, call a locked ComfyUI, write in a Telegram chat or a
 * Discord channel, download as the user). The password stays: it is scrypt's hash, and a restored Afflatus keeps
 * asking for it. The sessions are kept as hashes too (access.ts).
 */
const SECRET_SETTINGS: Record<string, (value: unknown) => unknown> = {
  civitaiKey: () => "",
  huggingFaceToken: () => "",
  runpodKey: () => "",
  // the one model from before there was a list ("llm"), and the list
  llm: (v) => (v && typeof v === "object" ? { ...v, apiKey: "" } : v),
  llms: (v) => (Array.isArray(v) ? v.map((l) => (l && typeof l === "object" ? { ...l, apiKey: "" } : l)) : v),
  machines: (v) => (Array.isArray(v) ? v.map((m) => (m && typeof m === "object" ? { ...m, token: "" } : m)) : v),
  notify: (v) => (v && typeof v === "object" ? { ...v, telegramToken: "", discordWebhook: "" } : v),
};

/**
 * The keys and tokens of a copy of the database blanked (SECRET_SETTINGS). With secure_delete, SQLite writes zeros over
 * what a row held before instead of leaving its bytes in the page until the room is used again: the file holds no trace
 * of them, without a second VACUUM of the whole copy.
 */
function blankSecrets(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA secure_delete = ON");
    const read = db.prepare("SELECT value FROM settings WHERE key = ?");
    const write = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    for (const [key, blank] of Object.entries(SECRET_SETTINGS)) {
      const row = read.get(key) as { value: string } | undefined;
      if (!row) continue;
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        // not JSON: the app reads it as its default (settings.ts), and it may still hold the secret as text
        value = null;
      }
      write.run(JSON.stringify(blank(value)), key);
    }
  } finally {
    db.close();
  }
}

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

async function* walk(dir: string, base = dir): AsyncGenerator<{ path: string; rel: string; mtime: Date; size: number }> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base);
    else if (e.isFile()) {
      // gone since the folder was read (the sweep erased it meanwhile): not part of the backup
      const info = await stat(p).catch(() => null);
      if (info) yield { path: p, rel: relative(base, p).replace(/\\/g, "/"), mtime: info.mtime, size: info.size };
    }
  }
}

/** How long the count of the files a backup would hold is reused: Settings asks again after every change to the library. */
const PLAN_FOR_MS = 60_000;

export function registerBackup(app: FastifyInstance, s: Services, places: BackupPlaces | undefined): void {
  // the files counted once a minute at most, and by one walk at a time: a walk of a large library takes seconds
  let counted: { at: number; files: number; bytes: number } | null = null;
  let counting: Promise<{ files: number; bytes: number }> | null = null;
  const count = async (dir: string) => {
    if (counted && Date.now() - counted.at < PLAN_FOR_MS) return counted;
    counting ??= (async () => {
      let files = 0;
      let bytes = 0;
      for await (const f of walk(dir)) {
        files++;
        bytes += f.size;
      }
      counted = { at: Date.now(), files, bytes };
      return counted;
    })().finally(() => {
      counting = null;
    });
    return counting;
  };

  /**
   * What a backup would hold: how many files, how many bytes, whether the database comes with it, and whether one with
   * the keys and tokens may be asked for from where the page is (`withSecrets`: from this computer, with the database).
   */
  app.get("/api/backup", async (req) => {
    if (!places) return { available: false, files: 0, bytes: 0, database: false, withSecrets: false };
    const { files, bytes } = await count(places.filesDir);
    const db = s.dbKind === "sqlite" ? await stat(join(places.dataDir, "afflatus.db")).then((x) => x.size).catch(() => 0) : 0;
    return { available: true, files, bytes: bytes + db, database: s.dbKind === "sqlite", withSecrets: s.dbKind === "sqlite" && fromThisComputer(req) };
  });

  /**
   * The backup itself, as a download: without the keys and tokens, or with them (`?secrets=1`) to a page on this
   * computer only, as Copy token is (lock-api.ts): Afflatus reached from another one does not hand them out.
   */
  app.get("/api/backup.zip", async (req, reply) => {
    if (!places) throw httpError("This server was started without a data folder to back up.", 404);
    const secrets = (req.query as { secrets?: string }).secrets === "1";
    if (secrets && !fromThisComputer(req)) throw httpError("A backup with the keys and tokens is made on the computer Afflatus runs on, not from another one.", 403);
    const zip = new ZipStream();
    const name = `afflatus-backup-${stamp()}${secrets ? "-with-keys" : ""}.zip`;
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${name}"`).header("Cache-Control", "no-store");
    // what is written is a promise that runs beside the reply; the reply takes the stream now. A write
    // fails once the browser has gone (zipStream.ts), which ends the loop: the finally below always runs
    // no file of Afflatus's storage is deleted from the copy of the database to the last file zipped: the copy names files
    // the zip must hold. Those erased meanwhile (the hourly sweep, Empty the bin) are deleted once it is done
    const release = s.storage.hold?.();
    void (async () => {
      let tmp: string | null = null;
      try {
        const readme = [
          `Afflatus backup, made ${new Date().toISOString()} by Afflatus ${VERSION}.`,
          "",
          "What is in it: afflatus.db (the database: library, settings, timelines, presets; a consistent copy made while the app ran)",
          "and files/ (every picture, video, sound, thumbnail and side file the library holds).",
          "Not in it: the files of linked folders (they stay where they are on your disk), and ComfyUI's models.",
          "",
          ...(secrets
            ? [
                "This backup HOLDS THE KEYS AND TOKENS of the settings: the RunPod key, the Civitai and Hugging Face tokens, the",
                "language models' API keys, the lock tokens of the ComfyUIs, the Telegram bot token and the Discord webhook.",
                "Anyone who has this file can spend on your RunPod account and use the others: keep it where only you can reach it.",
              ]
            : [
                "The keys and tokens of the settings are NOT in it (they were blanked in this copy of the database): the RunPod key,",
                "the Civitai and Hugging Face tokens, the language models' API keys, the lock tokens of the ComfyUIs, the Telegram",
                "bot token and the Discord webhook. After a restore, enter them again in Settings (a locked ComfyUI: paste its token",
                "or lock it again). A backup with them is made from the computer Afflatus runs on (Settings › Storage).",
              ]),
          "",
          "To restore: stop Afflatus, empty its data folder (or point DATA_DIR at a new one), unpack this zip into it so that",
          "afflatus.db and files/ sit at its top, and start Afflatus again. Settings, the library and the timelines come back as they were;",
          "linked folders are found again at their paths when they still exist there.",
          "",
        ].join("\n");
        const readmeBytes = Buffer.from(readme, "utf8");
        await zip.add("README.txt", Readable.from([readmeBytes]), new Date(), readmeBytes.length);
        if (s.dbKind === "sqlite") {
          // SQLite's own consistent copy: a complete database file as of now, with the app running
          tmp = await mkdtemp(join(tmpdir(), "afflatus-backup-"));
          const copy = join(tmp, "afflatus.db");
          await sql`VACUUM INTO ${copy}`.execute(s.db);
          if (!secrets) blankSecrets(copy);
          await zip.add("afflatus.db", createReadStream(copy), new Date(), (await stat(copy)).size);
        }
        for await (const f of walk(places.filesDir)) {
          if (req.raw.destroyed) break;
          // opened before its entry is begun: a file erased since it was listed is left out, not a backup given up half way
          const file = await open(f.path).catch(() => null);
          if (!file) continue;
          await zip.add(`files/${f.rel}`, file.createReadStream(), f.mtime, (await file.stat()).size);
        }
        await zip.finish();
      } catch (err) {
        // the browser going away is the usual way out and no news; anything else is said, since the user only sees a download that stopped
        if (!req.raw.destroyed) console.warn(`[backup] given up: ${(err as Error).message}`);
        zip.abort(err as Error);
      } finally {
        await release?.();
        if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return reply.send(zip.out);
  });
}

/**
 * A backup unpacked into an empty data folder (Afflatus stopped): afflatus.db and files/ at its top, as the
 * zip holds them. Read through the zip's central directory a file at a time, so that a backup of many
 * gigabytes is never in memory. Refuses a folder that holds anything, and an entry that would land outside
 * it. Returns how many files were written.
 */
export async function restoreBackup(zipPath: string, dataDir: string): Promise<number> {
  const target = resolve(dataDir);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length) throw new Error(`${target} is not empty: a backup is restored into an empty data folder`);
  const zip = await open(zipPath);
  try {
    let written = 0;
    for (const e of await centralOf(zip)) {
      if (e.name.endsWith("/")) continue;
      const to = resolve(target, e.name);
      if (!to.startsWith(target + sep)) throw new Error(`the backup names a file outside the data folder: ${e.name}`);
      if (e.method !== 0) throw new Error(`${e.name} is compressed: this is not a backup Afflatus made`);
      // the local header has name and extra lengths of its own: the bytes start after them
      const local = Buffer.alloc(30);
      await zip.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`the backup is damaged at ${e.name}`);
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await mkdir(dirname(to), { recursive: true });
      if (e.size) await pipeline(zip.createReadStream({ start, end: start + e.size - 1, autoClose: false }), createWriteStream(to));
      else await (await open(to, "w")).close();
      written++;
    }
    return written;
  } finally {
    await zip.close();
  }
}

interface CentralEntry { name: string; method: number; size: number; offset: number }

/** The entries a zip's central directory lists, zip64 included (zipStream.ts writes it past 4 GB): name, method, size and where each starts. */
async function centralOf(zip: FileHandle): Promise<CentralEntry[]> {
  const { size } = await zip.stat();
  const tailLength = Math.min(size, 22 + 0xffff + 20);
  const tail = Buffer.alloc(tailLength);
  await zip.read(tail, 0, tailLength, size - tailLength);
  const endAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("this is not a zip file");
  let count = tail.readUInt16LE(endAt + 10);
  let dirSize = tail.readUInt32LE(endAt + 12);
  let dirAt = tail.readUInt32LE(endAt + 16);
  // a zip64 locator sits just before the end record; the zip64 end record it names has the real figures
  const locatorAt = endAt - 20;
  if (locatorAt >= 0 && tail.readUInt32LE(locatorAt) === 0x07064b50) {
    const z64 = Buffer.alloc(56);
    await zip.read(z64, 0, 56, Number(tail.readBigUInt64LE(locatorAt + 8)));
    if (z64.readUInt32LE(0) === 0x06064b50) {
      count = Number(z64.readBigUInt64LE(32));
      dirSize = Number(z64.readBigUInt64LE(40));
      dirAt = Number(z64.readBigUInt64LE(48));
    }
  }
  const dir = Buffer.alloc(dirSize);
  await zip.read(dir, 0, dirSize, dirAt);
  const out: CentralEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (dir.readUInt32LE(at) !== 0x02014b50) throw new Error("the zip's directory is damaged");
    const nameLen = dir.readUInt16LE(at + 28);
    const extraLen = dir.readUInt16LE(at + 30);
    const packed = dir.readUInt32LE(at + 20);
    let entrySize = dir.readUInt32LE(at + 24);
    let offset = dir.readUInt32LE(at + 42);
    // the zip64 extra holds, in this order, the sizes and the offset that did not fit their 4 bytes
    const extra = dir.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    for (let x = 0; x + 4 <= extra.length; x += 4 + extra.readUInt16LE(x + 2)) {
      if (extra.readUInt16LE(x) !== 0x0001) continue;
      let f = x + 4;
      if (entrySize === 0xffffffff) {
        entrySize = Number(extra.readBigUInt64LE(f));
        f += 8;
      }
      if (packed === 0xffffffff) f += 8;
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(f));
    }
    out.push({ name: dir.subarray(at + 46, at + 46 + nameLen).toString("utf8"), method: dir.readUInt16LE(at + 10), size: entrySize, offset });
    at += 46 + nameLen + extraLen + dir.readUInt16LE(at + 32);
  }
  return out;
}
