import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { now, type Tables } from "./db";
import type { Services } from "./services";
import { ERASED, eraseAsset, inUse } from "./sweep";
import { unusedTakes } from "./timelineUnused";

/** The unused takes of every timeline (see timelineUnused), as the storage card counts and bins them. */
export async function idleTakes(db: Kysely<Tables>): Promise<Array<{ id: string; asset_id: string }>> {
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
    s.queue.events.emit("library");
    s.queue.events.emit("timeline");
    return { moved };
  });

  /** Everything in the bin is erased now, files and all. This cannot be undone. What something still uses stays in the bin (`inUse`). */
  app.post("/api/storage/empty-bin", async () => {
    const used = await inUse(s.db);
    const old = await s.db.selectFrom("assets").select(ERASED).where("deleted_at", "is not", null).execute();
    const gone = old.filter((a) => !used.has(a.id));
    for (const a of gone) await eraseAsset(s.db, s.storage, a);
    s.queue.events.emit("library");
    s.queue.events.emit("timeline");
    return { erased: gone.length, inUse: old.length - gone.length };
  });
}
