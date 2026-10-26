import { existsSync } from "node:fs";
import { copyFile, link, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasRentedScreen } from "@afflatus/core";
import { now } from "./db";
import { httpError } from "./errors";
import { readSettings } from "./settings";
import { LocalStorage } from "./storage";
import { type Named, namedIn, unnamedFiles } from "./sweep";
import { renameSoon, type UpdatesView, writeAtomic } from "./updatesModel";
import { bareVersion } from "./updatesCheck";
import { readVersion, UpdatesInstall } from "./updatesInstall";

/**
 * A copy of the library put in place of its database (Go back): the copy written beside it under a temporary name and
 * flushed first, the database kept under its name aside too (a second link to the same file, or a copy where the disk
 * has no links), its -wal set aside (it must not be replayed into the copy), then the copy renamed over the database.
 * There is never a moment with no database, which a start would take for an empty library: a stop at any point leaves
 * one database or the other in place, and a rename that keeps failing (a virus scanner on the copy) leaves the database
 * as it was, its -wal put back.
 */
export async function restoreDatabase(db: string, copy: string, aside: string): Promise<void> {
  const tmp = `${db}.tmp`;
  await copyFile(copy, tmp);
  const file = await open(tmp, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const had = existsSync(db);
  if (had) {
    await mkdir(dirname(aside), { recursive: true });
    await link(db, aside).catch(() => copyFile(db, aside));
  }
  const wal = existsSync(`${db}-wal`);
  try {
    if (wal) await renameSoon(`${db}-wal`, `${aside}-wal`);
    await rm(`${db}-shm`, { force: true });
    await renameSoon(tmp, db);
  } catch (err) {
    if (wal && existsSync(`${aside}-wal`)) await renameSoon(`${aside}-wal`, `${db}-wal`).catch(() => {});
    if (had) await rm(aside, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Files moved by setAsideUnnamed: each from where it was to where it went. */
export type Moves = Array<[from: string, to: string]>;

/**
 * The files of the library (data/files) that the library copy a Go back restores does not name, moved into `to` under
 * the same paths: what was made since the update. Left in place, the previous version's orphan sweep would erase them a
 * day later, as files no item of its library names; and the versions already released run their own sweep, whatever
 * this one does. Out of the folders any sweep reads, they wait beside the library set aside with them. A move that fails
 * puts back the ones done and throws: going back is then not done.
 */
export async function setAsideUnnamed(files: string, named: Named, to: string): Promise<Moves> {
  const keys: string[] = [];
  // the ".part" of a write that stopped is no one's file: the sweep takes it either way
  for await (const f of unnamedFiles(new LocalStorage(files), named)) if (!f.part) keys.push(f.key);
  const moves: Moves = [];
  try {
    for (const key of keys) {
      const from = join(files, key);
      const there = join(to, key);
      await mkdir(dirname(there), { recursive: true });
      await renameSoon(from, there);
      moves.push([from, there]);
    }
  } catch (err) {
    await putBack(moves);
    throw err;
  }
  return moves;
}

/** Files set aside by setAsideUnnamed put back where they were, when going back did not go through after all. */
export async function putBack(moves: Moves): Promise<void> {
  for (const [from, there] of [...moves].reverse()) {
    await renameSoon(there, from).catch((err: Error) => console.warn(`[updates] ${there} not put back in ${from}: ${err.message}`));
  }
}

/**
 * Going back to the previous version (updates.ts): its database copy restored, refused while a rented GPU it would not
 * follow runs (goBackCheck).
 */
export class UpdatesGoBack extends UpdatesInstall {
  /** The version installed before the running one, which Go back starts again. */
  protected async previous(): Promise<UpdatesView["previous"]> {
    if (this.install !== "bundle" || !this.versionsDir || !this.running) return null;
    const p = await readVersion(join(this.versionsDir, "previous"));
    if (!p || p === this.running || !existsSync(join(this.versionsDir, p))) return null;
    return { version: p, restoresLibrary: this.o.services.dbKind === "sqlite" && existsSync(this.backupOf(this.running)) };
  }

  /**
   * What Go back would leave on RunPod, asked before its question: refused (`refused` says why) while a rented GPU runs,
   * RunPod cannot be read to know it, or a GPU hunt or a deploy is on, as a version before 0.5.0 has no Rented GPUs screen,
   * no idle stop and no spending cap to stop them; else what keeps billing stopped (`billing`: disks, volumes), named in
   * the question. Back to a version with that screen, it sees its pods itself, but only those its library knows: the copy
   * restored was taken at the update, and a pod deployed or added since has no machine there. Such a pod is weighed as for
   * a version without the screen (refused while it runs, its disk named while stopped).
   */
  async goBackCheck(): Promise<{ refused: string | null; billing: string[]; unknown: boolean }> {
    const prev = await this.previous();
    const before = prev?.version;
    const screen = Boolean(before && hasRentedScreen(before));
    const name = before ?? "the previous version";
    // no copy to restore: Go back is refused for that, nothing here to weigh
    if (screen && !prev!.restoresLibrary) return { refused: null, billing: [], unknown: false };
    const known = screen ? await this.podsKnownTo(this.backupOf(this.running!)) : undefined;
    const rented = this.o.services.rented;
    const left = await rented.goingBack(known);
    const hunt = this.o.services.hunt.view().hunt;
    const unseen = screen ? `the library of ${name} (as it was at the update) does not know it, so ${name} would not follow it: no idle stop, no spending cap` : `${name} has no Rented GPUs screen, idle stop or spending cap`;
    const refused = left.running.length
      ? `A rented GPU runs: ${left.running.join(", ")}. Stop or terminate it first: ${unseen}, and it would bill unseen.`
      : left.unreadable ? `RunPod could not be read: ${left.unreadable}. Whether a rented GPU runs is not known, and ${screen ? `the library of ${name} does not know every pod of this one` : `${name} has no Rented GPUs screen`}: try again once RunPod answers.`
      : hunt ? `A GPU hunt is on: cancel it first. ${screen ? `The library of ${name} would not know a pod it deploys` : `${name} has no Rented GPUs screen`}: it would bill unseen.`
      : rented.busy ? `A deploy is under way: wait for it to end. ${screen ? `The library of ${name} would not know its pod` : `${name} has no Rented GPUs screen`}: it would bill unseen.` : null;
    return { refused, billing: left.billing, unknown: left.unknown };
  }

  /**
   * The pods the library copy taken at the update has machines for, read from that copy (read-only), when it has the same
   * RunPod key as now; none when it has another key or none (it would see none of this account's pods), or cannot be read.
   */
  private async podsKnownTo(copy: string): Promise<Set<string>> {
    const known = new Set<string>();
    const key = (await readSettings(this.db)).runpodKey;
    try {
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        const value = (k: string): unknown => {
          const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined;
          return row ? JSON.parse(row.value) : undefined;
        };
        if (!key || value("runpodKey") !== key) return known;
        const machines = value("machines");
        for (const m of Array.isArray(machines) ? machines : []) {
          const pod = (m as { rented?: { pod?: unknown } } | null)?.rented?.pod;
          if (typeof pod === "string") known.add(pod);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[updates] the library copy's pods not read (${(err as Error).message}): every pod counts as unknown to it`);
    }
    return known;
  }

  /** Back to the previous version, with the library as it was at the update: the database copy restored, then a restart. */
  async goBack(): Promise<void> {
    if (this.flow && this.flow.phase !== "failed") throw httpError("An update is under way: stop it first.", 409);
    const prev = await this.previous();
    if (!prev) throw httpError("There is no previous version to go back to.", 409);
    if (!prev.restoresLibrary) throw httpError(`The copy of the library taken at the update to ${this.running} is not there: going back is not done.`, 409);
    const running = await this.db.selectFrom("jobs").select("id").where("status", "=", "running").executeTakeFirst();
    if (running) throw httpError("A job is running: go back once it is done, or stop it.", 409);
    const refused = (await this.goBackCheck()).refused;
    if (refused) throw httpError(refused, 409);
    const versions = this.versionsDir!;
    const from = this.running!;
    const db = join(this.o.dataDir, "afflatus.db");
    const backup = this.backupOf(from);
    this.goingAway = true;
    this.flow = { phase: "restarting", version: prev.version, bytes: 0, total: 0, left: 0, error: null };
    this.emit(true);
    console.log(`[updates] going back to ${prev.version}: restarting`);
    const at = now();
    // after the reply has gone out: the page hears that it restarts before the server closes
    setTimeout(() => void this.o.restart(async () => {
      // the database as it is now is set aside, not deleted, and the files only it names with it (set-aside/<its name>):
      // what was made since stays on disk, out of the previous version's sweep
      const name = `after-${from}-${at.replace(/[:.]/g, "-")}`;
      const aside = join(this.o.dataDir, "backups", `${name}.db`);
      let moved: Moves = [];
      try {
        moved = await setAsideUnnamed(join(this.o.dataDir, "files"), namedIn(backup), join(this.o.dataDir, "set-aside", name, "files"));
        await restoreDatabase(db, backup, aside);
        if (moved.length) console.log(`[updates] ${moved.length} files made since the update set aside in set-aside/${name}`);
      } catch (err) {
        await putBack(moved);
        await this.note({ kind: "failed", from, to: prev.version, at, error: `Going back did not go through: ${(err as Error).message}` });
        throw err;
      }
      await writeAtomic(join(versions, "current"), prev.version);
      await rm(join(versions, "previous"), { force: true });
      await rm(join(versions, "trial"), { force: true });
      await this.note({ kind: "went-back", from: bareVersion(from), to: bareVersion(prev.version), at });
    }), 200);
  }
}
