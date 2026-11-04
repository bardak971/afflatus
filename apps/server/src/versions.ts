import type { Kysely } from "kysely";
import type { AssetLookup } from "./assets-api";
import { capName, shownNames } from "./autoName";
import { now, type Tables } from "./db";
import { httpError } from "./errors";
import { isLinked } from "./linked";
import { assetView } from "./media";
import type { Services } from "./services";

/**
 * Versions of a picture (card #274): what a fix painted on the Stage, a face or hand refine, an edit make of a picture comes
 * back under it as a version (`assets.version_of`), out of the library, instead of as new items. The picture is the stack's
 * head (version 0); its versions wait under it, counting down as any result nobody kept, until one is kept:
 *  - Keep version k: k takes the head's place (its folder, its name) and is kept; the old head and the other versions become
 *    k's versions, counting down from now (the sweep bins them a day on, an uploaded original too, unless something uses it);
 *  - Keep all: every version becomes a picture of its own, kept, beside the head.
 * A stack is flat: its versions all name the root head, never another version (a fix of a version joins the same stack, as
 * its job is filed: queueStore.ts). A version binned leaves its stack (assetsBin.ts, sweep.ts): it is a plain picture from
 * then on, in the Bin and back from it. The head erased lets its versions go as plain items (the column's `set null`).
 */

/** How far up a chain of `version_of` is followed at most: a stack is flat, so two steps are the most a stack ever has. */
const DEPTH = 16;

type Head = Pick<Tables["assets"], "id" | "version_of" | "deleted_at">;

/** The root head of the stack an item is in (itself when it is in none), binned or not; null when there is no such item. */
async function headOf(db: Kysely<Tables>, id: string): Promise<Head | null> {
  let at: Head | undefined;
  let next: string | null = id;
  for (let i = 0; next && i < DEPTH; i++) {
    at = await db.selectFrom("assets").select(["id", "version_of", "deleted_at"]).where("id", "=", next).executeTakeFirst();
    if (!at) return null;
    next = at.version_of ?? null;
  }
  return at ?? null;
}

/**
 * The head that what a job makes for `id` joins as versions: the root of its stack, followed from the picture the job was
 * sent for (a version kept meanwhile has become the root). Null when the stack has no head any more (erased, or in the
 * bin): what it makes is then a plain item, which the user sees rather than a version hidden under a picture they threw out.
 */
export async function stackRoot(db: Kysely<Tables>, id: string): Promise<string | null> {
  const head = await headOf(db, id);
  return head && !head.deleted_at ? head.id : null;
}

/** A stack as the Stage's strip reads it: its head, and its versions in the order they were made (the head not among them). */
export async function versionsOf(s: Services, id: string) {
  const head = await headOf(s.db, id);
  if (!head) throw httpError("there is no such picture", 404);
  const rows = await s.db.selectFrom("assets").selectAll().where((eb) => eb.or([eb("id", "=", head.id), eb.and([eb("version_of", "=", head.id), eb("deleted_at", "is", null)])]))
    .orderBy("created_at").orderBy("id").execute();
  const shown = await shownNames(s.db, rows, (r) => s.registry.recipe(r)?.title);
  const view = (r: Tables["assets"]) => ({ ...assetView(r), ...(shown.has(r.id) ? { shownName: shown.get(r.id)! } : {}) });
  const top = rows.find((r) => r.id === head.id)!;
  return { head: view(top), versions: rows.filter((r) => r.id !== head.id).map(view) };
}

/**
 * Keep one version of a stack (POST /api/assets/:id/versions/keep): `version` is a version's id, or the head's own (keep the
 * original: it is kept, and its versions count down from now). A version kept takes the head's folder and name and becomes
 * the root; the old head and the other versions become its versions, unkept, their day starting now; the jobs still to
 * run for the stack follow it, and so does what they make (filed under the new root). A file of a linked folder stays kept
 * as such files always are (it is the user's own file, never binned by the sweep), but leaves the library as a version.
 * Returns the stack as it is after.
 */
export async function keepVersion(s: Services, { fileInLinked }: AssetLookup, id: string, version: string) {
  const head = await headOf(s.db, id);
  if (!head) throw httpError("there is no such picture", 404);
  const at = now();
  if (version === head.id) {
    await s.db.transaction().execute(async (tx) => {
      await tx.updateTable("assets").set({ kept_at: at }).where("id", "=", head.id).where("kept_at", "is", null).execute();
      await tx.updateTable("assets").set({ countdown_from: at }).where("version_of", "=", head.id).where("deleted_at", "is", null).execute();
    });
    await fileInLinked(head.id);
  } else {
    await s.db.transaction().execute(async (tx) => {
      const [top, kept] = await Promise.all([
        tx.selectFrom("assets").select(["id", "name", "folder_id", "file_key"]).where("id", "=", head.id).executeTakeFirstOrThrow(),
        tx.selectFrom("assets").select(["id", "name", "version_of", "deleted_at"]).where("id", "=", version).executeTakeFirst(),
      ]);
      if (!kept || kept.version_of !== head.id || kept.deleted_at) throw httpError("this is not a version of this picture", 404);
      // the head's place: its folder, and its name when it has one (a nameless one is called after how it was made, as the version is)
      await tx.updateTable("assets").set({ version_of: null, folder_id: top.folder_id, name: top.name.trim() ? top.name : kept.name, kept_at: at, countdown_from: null }).where("id", "=", kept.id).execute();
      await tx.updateTable("assets").set({ version_of: kept.id, kept_at: null, countdown_from: at }).where("version_of", "=", head.id).where("deleted_at", "is", null).execute();
      // the old head: one in the bin stays there as it is (back from it, it is a plain picture again)
      if (!head.deleted_at) await tx.updateTable("assets").set(isLinked(top.file_key) ? { version_of: kept.id } : { version_of: kept.id, kept_at: null, countdown_from: at }).where("id", "=", head.id).execute();
      await tx.updateTable("jobs").set({ version_of: kept.id, updated_at: at }).where("version_of", "=", head.id).where("status", "in", ["queued", "running"]).execute();
    });
    // kept in a linked folder: written there as a file, as any item kept there
    await fileInLinked(version);
  }
  s.queue.events.emit("library", {});
  return versionsOf(s, version);
}

/**
 * Keep every version of a stack as a picture of its own (POST /api/assets/:id/versions/keep-all): each leaves the stack,
 * kept, in the head's folder; the head stays as it is. One whose name another picture of the stack already has (the old
 * head, after a Keep gave its name to the kept version) is numbered on, "<name> · 2", so that no two come out alike.
 * Returns the stack after: the head with no versions, unless jobs for it still run (what they make comes back under it).
 */
export async function keepAllVersions(s: Services, { fileInLinked }: AssetLookup, id: string) {
  const head = await headOf(s.db, id);
  if (!head) throw httpError("there is no such picture", 404);
  const top = await s.db.selectFrom("assets").select(["folder_id", "name"]).where("id", "=", head.id).executeTakeFirstOrThrow();
  const at = now();
  const kept = await s.db.transaction().execute(async (tx) => {
    const rows = await tx.selectFrom("assets").select(["id", "name"]).where("version_of", "=", head.id).where("deleted_at", "is", null).orderBy("created_at").orderBy("id").execute();
    // a nameless one is called after how it was made (shownNames), which tells it apart already
    const key = (name: string) => name.trim().toLowerCase();
    const taken = new Set([top.name, ...rows.map((r) => r.name)].map(key).filter(Boolean));
    const seen = new Set([key(top.name)].filter(Boolean));
    for (const r of rows) {
      let name = r.name;
      if (key(name) && seen.has(key(name))) {
        let n = 2;
        while (taken.has(key(capName(`${r.name} · ${n}`)))) n++;
        name = capName(`${r.name} · ${n}`);
        taken.add(key(name));
      }
      seen.add(key(name));
      await tx.updateTable("assets").set({ version_of: null, folder_id: top.folder_id, kept_at: at, countdown_from: null, name }).where("id", "=", r.id).execute();
    }
    return rows;
  });
  for (const k of kept) await fileInLinked(k.id);
  s.queue.events.emit("library", {});
  return versionsOf(s, head.id);
}

/** How many versions wait under each of these items (the listings' "3 versions"): only the heads that have some are in it. */
export async function versionCounts(db: Kysely<Tables>, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.selectFrom("assets").select((eb) => ["version_of", eb.fn.countAll().as("n")])
      .where("version_of", "in", ids.slice(i, i + 500)).where("deleted_at", "is", null).groupBy("version_of").execute();
    for (const r of rows) if (r.version_of) out.set(r.version_of, Number(r.n));
  }
  return out;
}
