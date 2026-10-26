import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { now, type Tables } from "./db";
import { foldersOf, type LibraryChange } from "./events";
import type { Services } from "./services";
import { resetCountdown, SPACE } from "./media";
import { ERASED, eraseUnused } from "./sweep";
import { inUseShown, unusedTakes } from "./timelineUnused";

/** The unused takes of every timeline (see timelineUnused), as the storage card counts and bins them. */
async function idleTakes(db: Kysely<Tables>, used?: Promise<Map<string, string>>): Promise<Array<{ id: string; asset_id: string }>> {
  return [...(await unusedTakes(db, undefined, used)).values()].flatMap((u) => [...u.videoOf].map(([id, asset_id]) => ({ id, asset_id })));
}

/**
 * Where the space goes, and the two ways to get some back: move the takes that never play to the bin,
 * and empty the bin now instead of waiting a week.
 */
export function registerUsage(app: FastifyInstance, s: Services): void {
  // read on each change of the library by every page open (the command bar): summed by SQL in a few groups, never each item sent
  app.get("/api/storage", async () => {
    const binned = sql<number>`case when deleted_at is null then 0 else 1 end`;
    const unkept = sql<number>`case when kept_at is null and origin = 'generated' then 1 else 0 end`;
    const groups = (await s.db.selectFrom("assets")
      .select(["kind", binned.as("binned"), unkept.as("unkept"), (eb) => eb.fn.countAll<number>().as("count"), sql<number>`sum(${SPACE})`.as("bytes")])
      .groupBy(["kind", binned, unkept])
      .execute()).map((g) => ({ ...g, binned: Number(g.binned), unkept: Number(g.unkept), count: Number(g.count), bytes: Number(g.bytes ?? 0) }));
    // the takes that never play, and of them the ones not in the bin: by their ids alone
    const idle = [...new Set((await idleTakes(s.db, inUseShown(s))).map((t) => t.asset_id))];
    const unused: Array<{ kind: string; count: number; bytes: number }> = [];
    for (let i = 0; i < idle.length; i += 500) {
      const part = await s.db.selectFrom("assets").select(["kind", (eb) => eb.fn.countAll<number>().as("count"), sql<number>`sum(${SPACE})`.as("bytes")])
        .where("id", "in", idle.slice(i, i + 500)).where("deleted_at", "is", null).groupBy("kind").execute();
      unused.push(...part.map((g) => ({ kind: g.kind, count: Number(g.count), bytes: Number(g.bytes ?? 0) })));
    }
    const sum = <T extends { count: number; bytes: number }>(rows: T[], keep: (g: T) => boolean = () => true) =>
      rows.filter(keep).reduce((n, g) => ({ count: n.count + g.count, bytes: n.bytes + g.bytes }), { count: 0, bytes: 0 });
    const live = (g: (typeof groups)[number]) => !g.binned;
    return {
      total: sum(groups).bytes,
      pictures: sum(groups, (g) => live(g) && g.kind === "image").bytes,
      videos: sum(groups, (g) => live(g) && g.kind === "video").bytes - sum(unused, (g) => g.kind === "video").bytes,
      sounds: sum(groups, (g) => live(g) && g.kind === "audio").bytes,
      /** Takes that never play: videos kept only because a clip once rendered them. */
      idleTakes: sum(unused),
      bin: sum(groups, (g) => Boolean(g.binned)),
      /** Results nobody kept: they go to the bin a day after they were made. */
      unkept: sum(groups, (g) => live(g) && Boolean(g.unkept)),
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
