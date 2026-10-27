import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssetLookup } from "./assets-api";
import { now, type Db } from "./db";
import { foldersOf, type LibraryChange } from "./events";
import { httpError } from "./errors";
import { isLinked } from "./linked";
import { assetView, resetCountdown } from "./media";
import type { Services } from "./services";
import { inUse, withUseHeld } from "./sweep";

/**
 * Kept or not, to the bin and back, one item or several. What something still needs (a take on a timeline,
 * a clip's still or sound, the music, a person's picture, a job's input: see inUse) is neither unkept nor
 * binned: the sweep would erase it in the end and leave that pointing at nothing.
 */

/** A 409 naming what still uses the item, when something does. `db`: the transaction the change it guards is made in. */
async function refuseUsed(db: Db, id: string, then: string): Promise<void> {
  const what = (await inUse(db)).get(id);
  if (what) throw httpError(`This is still used by ${what}: ${then}.`, 409);
}

/**
 * A change to items that must not touch what something uses, made in the same transaction as the check, with what names
 * an item held still (withUseHeld): an item picked into a draft or put on a timeline between the two was unkept or binned
 * all the same.
 */
const unlessUsed = <T>(s: Services, work: (tx: Db) => Promise<T>) => withUseHeld(s.db, work);

/** Kept or not (POST /api/assets/:id/keep, MCP's keep and unkeep): what something still uses stays kept, refused with what uses it. */
export async function keepItem(s: Services, { asset, fileInLinked }: AssetLookup, id: string, kept: boolean) {
  const a = await asset(id);
  // a file of a linked folder is the user's own file: it is kept, whatever is asked
  if (isLinked(a.file_key)) return assetView(a);
  await unlessUsed(s, async (tx) => {
    if (!kept) await refuseUsed(tx, a.id, "it stays kept while it is");
    await tx.updateTable("assets").set({ kept_at: kept ? now() : null }).where("id", "=", id).execute();
  });
  // kept while it sits in a linked folder: it is written there as a file
  if (kept) await fileInLinked(a.id);
  // unkept: its day starts now, not the day it was made
  else await resetCountdown(s.db, [a.id]);
  // the other tabs: the flag is written in place there, the disk use's split and the expiring count read again
  s.queue.events.emit("library", { change: "kept", items: [a.id], kept } satisfies LibraryChange);
  return assetView(await asset(id));
}

/** To the bin (DELETE /api/assets/:id, MCP's bin). Nothing is erased here: the bin is emptied later, and until then it comes back. */
export async function binItem(s: Services, { asset }: AssetLookup, id: string): Promise<void> {
  const a = await asset(id);
  // a file of a linked folder leaves its directory, and waits in the bin like the rest (moved on the disk: checked first, not with the move)
  if (isLinked(a.file_key)) {
    await refuseUsed(s.db, a.id, "take it out of there first");
    await s.linked.toBin(a);
  } else {
    await unlessUsed(s, async (tx) => {
      await refuseUsed(tx, a.id, "take it out of there first");
      await tx.updateTable("assets").set({ deleted_at: now() }).where("id", "=", id).execute();
    });
  }
  s.queue.events.emit("library", { change: "binned", items: [a.id], folders: [a.folder_id] } satisfies LibraryChange);
}

/** Back from the bin (POST /api/assets/:id/restore, MCP's restore): unkept, its day starting now. */
export async function restoreItem(s: Services, { asset }: AssetLookup, id: string) {
  const a = await asset(id);
  // a file that was taken out of a linked folder goes back into its directory
  if (a.linked_path) await s.linked.restore(a);
  else await s.db.updateTable("assets").set({ deleted_at: null }).where("id", "=", id).execute();
  // back in the library unkept: its day starts now
  await resetCountdown(s.db, [a.id]);
  s.queue.events.emit("library", { change: "binned", items: [a.id], folders: [a.folder_id] } satisfies LibraryChange);
  return assetView(await asset(id));
}

/** What a change of several items did: how many changed, and how many were left as they were because something still uses them. */
export type BulkDone = { changed: number; inUse?: number };

/**
 * Several items kept or not, to the bin, or back from it (POST /api/assets/bulk, MCP's tools given several): what
 * something still needs is left as it is, and counted.
 */
export async function bulkItems(s: Services, { fileInLinked }: AssetLookup, asked: { ids: string[]; action: "keep" | "unkeep" | "bin" | "restore" }): Promise<BulkDone> {
  const b = { ...asked, ids: [...asked.ids] };
  // what something still needs is left as it is (and counted, for saying so)
  let spared = 0;
  if (b.action === "unkeep" || b.action === "bin") {
    const used = await inUse(s.db);
    const free = b.ids.filter((id) => !used.has(id));
    spared = b.ids.length - free.length;
    b.ids = free;
  }
  const said = (changed: number): BulkDone => ({ changed, ...(spared ? { inUse: spared } : {}) });
  // the files of linked folders among them: to the bin and back they move on the disk; they are never "not kept"
  const rows = b.ids.length ? await s.db.selectFrom("assets").selectAll().where("id", "in", b.ids).where("origin", "!=", "mask").execute() : [];
  const change: LibraryChange = {
    ...(b.action === "keep" || b.action === "unkeep" ? { change: "kept", kept: b.action === "keep" } : { change: "binned" }),
    items: rows.map((a) => a.id),
    folders: foldersOf(rows),
  };
  const onDisk = rows.filter((a) => isLinked(a.file_key));
  const back = rows.filter((a) => a.linked_path && a.deleted_at);
  let special = 0;
  if (b.action === "bin") for (const a of onDisk) { await s.linked.toBin(a); special++; }
  if (b.action === "restore") for (const a of back) { await s.linked.restore(a); special++; }
  const handled = new Set([...(b.action === "bin" || b.action === "unkeep" || b.action === "keep" ? onDisk : []), ...(b.action === "restore" ? back : [])].map((a) => a.id));
  b.ids = b.ids.filter((id) => !handled.has(id));
  if (!b.ids.length) {
    s.queue.events.emit("library", change);
    return said(special);
  }
  const set = b.action === "keep" ? { kept_at: now() } : b.action === "unkeep" ? { kept_at: null } : b.action === "bin" ? { deleted_at: now() } : { deleted_at: null };
  const done = await unlessUsed(s, async (tx) => {
    // what something took up since the first look (a linked file moved on the disk in between) is spared too
    if (b.action === "unkeep" || b.action === "bin") {
      const used = await inUse(tx);
      const free = b.ids.filter((id) => !used.has(id));
      spared += b.ids.length - free.length;
      b.ids = free;
      if (!free.length) return { numUpdatedRows: 0n };
    }
    let query = tx.updateTable("assets").set(set).where("id", "in", b.ids).where("origin", "!=", "mask");
    // what is kept already keeps the day it was kept
    if (b.action === "keep") query = query.where("kept_at", "is", null);
    return query.executeTakeFirst();
  });
  if (b.action === "keep") for (const id of b.ids) await fileInLinked(id);
  // unkept, or back from the bin: the day before the bin starts now
  if (b.action === "unkeep" || b.action === "restore") await resetCountdown(s.db, b.ids);
  s.queue.events.emit("library", change);
  return said(Number(done.numUpdatedRows) + special);
}

export function registerAssetsBin(app: FastifyInstance, s: Services, lookup: AssetLookup): void {
  app.post<{ Params: { id: string } }>("/api/assets/:id/keep", async (req) => {
    const { kept } = z.strictObject({ kept: z.boolean() }).parse(req.body);
    return keepItem(s, lookup, req.params.id, kept);
  });

  /** To the bin. Nothing is erased here: the bin is emptied later. */
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    await binItem(s, lookup, req.params.id);
    return { ok: true };
  });

  /** The same for several items at once: kept or not, to the bin, or back from it. */
  app.post("/api/assets/bulk", async (req) => {
    const b = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(500), action: z.enum(["keep", "unkeep", "bin", "restore"]) }).parse(req.body);
    return bulkItems(s, lookup, b);
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/restore", async (req) => restoreItem(s, lookup, req.params.id));
}
