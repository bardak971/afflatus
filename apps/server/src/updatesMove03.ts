import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compareVersions } from "@afflatus/core";
import { now } from "./db";
import { httpError } from "./errors";
import { type LibrarySummary, type OldLibrary, renameSoon } from "./updatesModel";
import { bareVersion } from "./updatesCheck";
import { UpdatesGoBack } from "./updatesGoBack";

/** A 0.3 bundle's folder, as its archive unpacked: afflatus-v0.3.0-win-x64, afflatus-0.3.1. */
const OLD_BUNDLE = /^afflatus-v?(0\.3\.\d+)(?:-[\w.]+)*$/i;

/** The size of the files under a folder, its subfolders included; links are not followed (a linked folder is not the library's). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(path);
    else if (e.isFile()) total += await stat(path).then((s) => s.size, () => 0);
  }
  return total;
}

/**
 * What a library (a data folder) holds: its items (not in the bin), timelines and drafts, counted in its database opened
 * read-only, and the size of its files folder. A database that cannot be read (another program holds it, a version whose
 * tables are named otherwise) gives no counts, only the size: the move is still offered, the dialog says less.
 */
export async function librarySummary(dataDir: string): Promise<LibrarySummary> {
  const counts: Pick<LibrarySummary, "items" | "timelines" | "drafts"> = { items: null, timelines: null, drafts: null };
  try {
    const db = new DatabaseSync(join(dataDir, "afflatus.db"), { readOnly: true });
    try {
      const count = (query: string) => {
        try {
          return Number((db.prepare(query).get() as { n: number | bigint } | undefined)?.n ?? 0);
        } catch {
          return null;
        }
      };
      counts.items = count("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL");
      counts.timelines = count("SELECT COUNT(*) AS n FROM timelines");
      counts.drafts = count("SELECT COUNT(*) AS n FROM drafts");
    } finally {
      db.close();
    }
  } catch {
    // not a database this can open: the counts stay unknown
  }
  return { ...counts, bytes: await folderBytes(join(dataDir, "files")) };
}

// ---------------------------------------------------------------- what the web reads

/**
 * The move of a 0.3 library into a fresh 0.4 bundle beside it (updates.ts): looked for at each start, offered while
 * the library here is empty, and moved on the user's word.
 */
export class UpdatesMove03 extends UpdatesGoBack {
  /** The library had something in it once: the move is never offered again in this run. */
  private filled = false;

  /** A 0.3 bundle's library beside this one (../afflatus-v0.3.*-<platform>/data), the newest when there are several. */
  protected async findOldLibrary(): Promise<OldLibrary | null> {
    if (this.install !== "bundle" || !this.root || this.o.services.dbKind !== "sqlite") return null;
    // only the data folder the launcher set: one set by hand is the user's choice, and is left as it is
    const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!same(resolve(this.o.dataDir), join(this.root, "data"))) return null;
    // where an archive lands: unzipped in place, this bundle's Afflatus folder sits beside the 0.3 folder; with Windows'
    // Extract All, each archive gets a folder of its own name first (…\afflatus-v0.3.0-win-x64\afflatus-v0.3.0-win-x64\data
    // beside …\afflatus-v0.4.0-win-x64\Afflatus), so the folder above this one's is looked in too, and one level inside each
    const parents = [dirname(this.root), dirname(dirname(this.root))].filter((p, i, all) => all.indexOf(p) === i);
    let found: OldLibrary | null = null;
    for (const parent of parents) {
      for (const e of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
        const m = OLD_BUNDLE.exec(e.name);
        if (!m || !e.isDirectory() || same(join(parent, e.name), this.root)) continue;
        const data = [join(parent, e.name, "data"), join(parent, e.name, e.name, "data")].find((d) => existsSync(join(d, "afflatus.db")));
        if (!data) continue;
        if (!found || (compareVersions(m[1]!, found.version) ?? 0) > 0) found = { from: data, version: m[1]! };
      }
    }
    return found;
  }

  /** The move is offered while this library is still empty: no item, draft or timeline. */
  protected async moveOffer(): Promise<boolean> {
    if (!this.moveFrom || this.filled) return false;
    if (!existsSync(this.moveFrom.from)) return false;
    const one = async (table: "assets" | "drafts" | "timelines") => Boolean(await this.db.selectFrom(table).select("id").limit(1).executeTakeFirst());
    if ((await one("assets")) || (await one("drafts")) || (await one("timelines"))) this.filled = true;
    return !this.filled;
  }

  /** Bring the 0.3 library in: the services closed, the empty data folder renamed aside, the old one renamed in (no copy), a restart. */
  async moveIn(): Promise<void> {
    if (this.flow && this.flow.phase !== "failed") throw httpError("An update is under way: stop it first.", 409);
    if (!(await this.moveOffer())) throw httpError("There is no 0.3 library to bring over, or this one is no longer empty.", 409);
    const { from, version } = this.moveFrom!;
    const data = resolve(this.o.dataDir);
    // a rename moves a folder only on its own disk: across disks it would be a copy of the whole library, which is not done here
    const [a, b] = await Promise.all([stat(dirname(from)), stat(dirname(data))]);
    if (a.dev !== b.dev) throw httpError(`The 0.3 library (${from}) is on another disk: move its data folder here by hand, with Afflatus stopped.`, 409);
    const at = now();
    const aside = `${data}-empty-${at.slice(0, 19).replace(/[:T]/g, "-")}`;
    this.goingAway = true;
    this.flow = { phase: "restarting", version: this.version, bytes: 0, total: 0, left: 0, error: null };
    this.emit(true);
    console.log(`[updates] bringing the ${version} library in from ${from}: restarting`);
    setTimeout(() => void this.o.restart(async () => {
      await renameSoon(data, aside);
      try {
        await renameSoon(from, data);
      } catch (err) {
        await renameSoon(aside, data).catch(() => {});
        await this.note({ kind: "failed", from: version, to: bareVersion(this.version), at, error: `The 0.3 library was not brought over: ${(err as Error).message}` });
        throw err;
      }
      await this.note({ kind: "moved", from: version, to: bareVersion(this.version), at }, data);
    }), 200);
  }
}
