import type { EventEmitter } from "node:events";
import type { Db } from "./db";
import { isLinked } from "./linked";
import { inUse } from "./sweep";

/**
 * The unused takes of the timelines: the takes that are not the one playing in their clip, whose video nothing else
 * needs. Kept, with their videos, are:
 *  - the take that plays in each clip (clips.take_id), anywhere;
 *  - a take a kept take was finished from or carries on from (its draft, its latent: what a continuation is made from),
 *    and so on up the chain;
 *  - every take of a video that a kept take plays too, or that takes of another timeline play (it is not this one's to bin);
 *  - a take whose video is in the bin already, or a file of a linked folder (the user's own file on disk);
 *  - a take whose video something else uses: a clip's still or sound, a picture on a clip's form, a timeline's music, a
 *    person or a preset, a job still to run (inUse, its takes aside).
 * A few queries for all the timelines.
 */

export interface Unused {
  /** The unused takes' ids. */
  takes: string[];
  /** The video of each unused take, by take id. */
  videoOf: Map<string, string>;
  /** Their videos, each once, with its size. */
  assets: Map<string, number>;
}

/** The events after which what is in use may have changed: an item, a timeline, a person or a preset, a job queued or ended. */
const USE_CHANGES = ["library", "timeline", "entities", "queue"] as const;
/**
 * How long a reading of what is in use is kept at most: a draft's forms name pictures too, and saving a draft says nothing.
 * The bin's moves read it afresh (in their transaction); only the figures shown wait.
 */
export const IN_USE_KEPT_MS = 30_000;
const keptUse = new WeakMap<EventEmitter, { changes: number; read?: { changes: number; at: number; used: Promise<Map<string, string>> } }>();

/**
 * What is in use but the takes (inUse), for the reads that show figures (the storage card, the command index, the projects
 * tree): kept until one of USE_CHANGES or IN_USE_KEPT_MS, as the model tally is. Its seven reads (about 8 ms at
 * scale) ran on every open of the bar and every refresh of the tree.
 */
export function inUseShown(s: { db: Db; queue: { events: EventEmitter } }): Promise<Map<string, string>> {
  const events = s.queue.events;
  let kept = keptUse.get(events);
  if (!kept) {
    const fresh = { changes: 0 };
    for (const name of USE_CHANGES) events.on(name, () => fresh.changes++);
    keptUse.set(events, fresh);
    kept = fresh;
  }
  const read = kept.read;
  if (read && read.changes === kept.changes && Date.now() - read.at < IN_USE_KEPT_MS) return read.used;
  const used = inUse(s.db, { takes: false });
  const mine = { changes: kept.changes, at: Date.now(), used };
  kept.read = mine;
  // a failed read is not kept: the next one asks again
  used.catch(() => {
    if (kept.read === mine) kept.read = undefined;
  });
  return used;
}

/**
 * By timeline: its unused takes and their videos. `only`: just that timeline's (the others still decide what is shared).
 * `used`: what is in use but the takes, when the caller has it (inUseShown); read here otherwise.
 */
export async function unusedTakes(db: Db, only?: string, used?: Promise<Map<string, string>>): Promise<Map<string, Unused>> {
  const rows = await db
    .selectFrom("takes")
    .innerJoin("clips", "clips.id", "takes.clip_id")
    .innerJoin("assets", "assets.id", "takes.asset_id")
    .select([
      "takes.id as id", "takes.asset_id as asset", "takes.prev_take_id as prev", "takes.finished_from as from", "clips.take_id as playing", "clips.timeline_id as timeline",
      "assets.bytes as bytes", "assets.file_key as fileKey", "assets.deleted_at as deletedAt",
    ])
    .execute();
  const out = new Map<string, Unused>();
  if (!rows.length) return out;
  const inUseNow = await (used ?? inUse(db, { takes: false }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byAsset = new Map<string, typeof rows>();
  for (const r of rows) byAsset.set(r.asset, [...(byAsset.get(r.asset) ?? []), r]);

  const kept = new Set<string>();
  const work: string[] = [];
  const keep = (id: string | null) => {
    if (id && byId.has(id) && !kept.has(id)) {
      kept.add(id);
      work.push(id);
    }
  };
  for (const r of rows) {
    const shared = new Set(byAsset.get(r.asset)!.map((x) => x.timeline)).size > 1;
    if (r.id === r.playing || shared || r.deletedAt || isLinked(r.fileKey) || inUseNow.has(r.asset)) keep(r.id);
  }
  // what a kept take was made from is kept, and so is every take of a video a kept take plays
  for (let id = work.pop(); id; id = work.pop()) {
    const r = byId.get(id)!;
    keep(r.prev);
    keep(r.from);
    for (const x of byAsset.get(r.asset)!) keep(x.id);
  }

  for (const r of rows) {
    if (kept.has(r.id) || (only && r.timeline !== only)) continue;
    const u = out.get(r.timeline) ?? { takes: [], videoOf: new Map<string, string>(), assets: new Map<string, number>() };
    u.takes.push(r.id);
    u.videoOf.set(r.id, r.asset);
    u.assets.set(r.asset, Number(r.bytes));
    out.set(r.timeline, u);
  }
  return out;
}

/** The size of a timeline's unused takes, for the projects tree. */
export const unusedSize = (u: Unused | undefined) => ({ unusedTakes: u?.takes.length ?? 0, unusedBytes: [...(u?.assets.values() ?? [])].reduce((a, b) => a + b, 0) });
