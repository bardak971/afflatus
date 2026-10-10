import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { now, type Tables } from "./db";
import { foldersOf, type LibraryChange } from "./events";
import type { Services } from "./services";
import { resetCountdown } from "./media";
import { ERASED, eraseUnused } from "./sweep";
import { unusedTakes } from "./timelineUnused";

/** The unused takes of every timeline (see timelineUnused), as the storage card counts and bins them. */
async function idleTakes(db: Kysely<Tables>): Promise<Array<{ id: string; asset_id: string }>> {
  return [...(await unusedTakes(db)).values()].flatMap((u) => [...u.videoOf].map(([id, asset_id]) => ({ id, asset_id })));
}

/**
 * Where the space goes, and the two ways to get some back: move the takes that never play to the bin,
 * and empty the bin now instead of waiting a week.
 */
export function registerUsage(app: FastifyInstance, s: Services): void {
  app.get("/api/storage", async () => {
    const assets = await s.db.selectFrom("assets").select(["id", "kind", "bytes", "deleted_at", "kept_at", "origin"]).execute();
    const idle = new Set((await idleTakes(s.db)).map((t) => t.asset_id));
    const sum = (rows: typeof assets) => rows.reduce((n, a) => n + a.bytes, 0);
    const live = assets.filter((a) => !a.deleted_at);
    const bin = assets.filter((a) => a.deleted_at);
    const unused = live.filter((a) => idle.has(a.id));
    return {
      total: sum(assets),
      pictures: sum(live.filter((a) => a.kind === "image")),
      videos: sum(live.filter((a) => a.kind === "video" && !idle.has(a.id))),
      sounds: sum(live.filter((a) => a.kind === "audio")),
      /** Takes that never play: videos kept only because a clip once rendered them. */
      idleTakes: { count: unused.length, bytes: sum(unused) },
      bin: { count: bin.length, bytes: sum(bin) },
      /** Results nobody kept: they go to the bin a day after they were made. */
      unkept: { count: live.filter((a) => !a.kept_at && a.origin === "generated").length, bytes: sum(live.filter((a) => !a.kept_at && a.origin === "generated")) },
    };
  });

  /** The takes that never play go to the bin (a week to change your mind); their clips forget them. Found and moved in one transaction. */
  app.post("/api/storage/bin-idle-takes", async () => {
    const moved = await s.db.transaction().execute(async (tx) => {
      const idle = await idleTakes(tx);
      if (idle.length) {
        await tx.updateTable("assets").set({ deleted_at: now() }).where("id", "in", idle.map((t) => t.asset_id)).where("deleted_at", "is", null).execute();
        await tx.deleteFrom("takes").where("id", "in", idle.map((t) => t.id)).execute();
      }
      return new Set(idle.map((t) => t.asset_id)).size;
    });
    s.queue.events.emit("library", { change: "binned" } satisfies LibraryChange);
    s.queue.events.emit("timeline");
    return { moved };
  });

  /**
   * Everything in the bin is erased now, files and all, or only the items named (`ids`: the bin's Delete now). This
   * cannot be undone. What something still uses stays in the bin (`inUse`); an item named that is not in the bin is
   * left alone.
   */
  app.post("/api/storage/empty-bin", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(500).optional() }).parse(req.body ?? {});
    // what is in use, what is in the bin and the erasing read and done at once: an item put back meanwhile stays
    const { picked, erased: gone } = await eraseUnused(s.db, s.storage, (tx) => {
      let query = tx.selectFrom("assets").select(ERASED).where("deleted_at", "is not", null);
      if (ids) query = query.where("id", "in", ids);
      return query.execute();
    });
    s.queue.events.emit("library", { change: "erased", items: gone.map((a) => a.id) } satisfies LibraryChange);
    s.queue.events.emit("timeline");
    return { erased: gone.length, inUse: picked - gone.length };
  });

  /**
   * Everything in the bin back where it was (the bin's Put all back): files of linked folders back into their
   * directories, the rest back in the library, each unkept with its day starting now, as a single put back does.
   */
  app.post("/api/storage/restore-bin", async () => {
    const binned = await s.db.selectFrom("assets").selectAll().where("deleted_at", "is not", null).where("origin", "!=", "mask").execute();
    for (const a of binned.filter((x) => x.linked_path)) await s.linked.restore(a);
    const rest = binned.filter((x) => !x.linked_path).map((a) => a.id);
    // in slices: SQLite takes a limited number of values in one statement
    for (let i = 0; i < rest.length; i += 500) await s.db.updateTable("assets").set({ deleted_at: null }).where("id", "in", rest.slice(i, i + 500)).execute();
    for (let i = 0; i < binned.length; i += 500) await resetCountdown(s.db, binned.slice(i, i + 500).map((a) => a.id));
    s.queue.events.emit("library", { change: "binned", items: binned.map((a) => a.id), folders: foldersOf(binned) } satisfies LibraryChange);
    return { restored: binned.length };
  });
}
