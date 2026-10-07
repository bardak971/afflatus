import type { FastifyInstance } from "fastify";
import { now } from "./db";
import type { Services } from "./services";

/**
 * Where the space goes, and the two ways to get some back: move the takes that never play to the bin,
 * and empty the bin now instead of waiting a week.
 */
export function registerUsage(app: FastifyInstance, s: Services): void {
  /** Takes that are not the one that plays in their clip, whose video plays nowhere else either. */
  const idleTakes = async () => {
    const takes = await s.db.selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").select(["takes.id", "takes.asset_id", "clips.take_id as playing"]).execute();
    const plays = new Set(takes.filter((t) => t.id === t.playing).map((t) => t.asset_id));
    return takes.filter((t) => t.id !== t.playing && !plays.has(t.asset_id));
  };

  app.get("/api/storage", async () => {
    const assets = await s.db.selectFrom("assets").select(["id", "kind", "bytes", "deleted_at", "kept_at", "origin"]).execute();
    const idle = new Set((await idleTakes()).map((t) => t.asset_id));
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

  /** The takes that never play go to the bin (a week to change your mind); their clips forget them. */
  app.post("/api/storage/bin-idle-takes", async () => {
    const idle = await idleTakes();
    if (idle.length) {
      await s.db.updateTable("assets").set({ deleted_at: now() }).where("id", "in", idle.map((t) => t.asset_id)).where("deleted_at", "is", null).execute();
      await s.db.deleteFrom("takes").where("id", "in", idle.map((t) => t.id)).execute();
    }
    s.queue.events.emit("library");
    s.queue.events.emit("timeline");
    return { moved: new Set(idle.map((t) => t.asset_id)).size };
  });

  /** Everything in the bin is erased now, files and all. This cannot be undone. */
  app.post("/api/storage/empty-bin", async () => {
    const old = await s.db.selectFrom("assets").select(["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key"]).where("deleted_at", "is not", null).execute();
    for (const a of old) {
      await s.storage.delete(a.file_key).catch(() => {});
      if (a.thumb_key) await s.storage.delete(a.thumb_key).catch(() => {});
      if (a.raw_key) await s.storage.delete(a.raw_key).catch(() => {});
      if (a.latent_key) await s.storage.delete(a.latent_key).catch(() => {});
      if (a.fine_latent_key) await s.storage.delete(a.fine_latent_key).catch(() => {});
      await s.db.deleteFrom("assets").where("id", "=", a.id).execute();
    }
    s.queue.events.emit("library");
    s.queue.events.emit("timeline");
    return { erased: old.length };
  });
}
