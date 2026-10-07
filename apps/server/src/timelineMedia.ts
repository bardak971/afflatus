import { createHash } from "node:crypto";
import { colourNudge, CutError, MATCH, type Means, stretchMeans, filmStrip, frameAt, joinJump, measureOf, MOTION_RATE, peekAt, scenesOf } from "./cut";
import { newId, now } from "./db";
import { notFound } from "./errors";
import { extOf, newAssetRow, pngSize } from "./media";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideo } from "./video";
import { joinFade, lengthOf, sameMaking, seamless, visible, type AssetRow, type Placed, type Taken, type TimelineCore } from "./timelineModel";

/**
 * What the timelines read out of their videos: a frame as a picture, the film strip, the motion and
 * loudness, the scene cuts, a peek for the trim bar, and how smoothly the takes meet at their joins. Most
 * of it is worked out once and kept beside the video, since its frames do not change.
 */

/** Keep an in-process cache to its last `most` entries: the oldest go first (a Map keeps the order they were put in). */
function capped<K, V>(cache: Map<K, V>, most = 500): void {
  while (cache.size > most) cache.delete(cache.keys().next().value as K);
}

export class TimelineMedia {
  constructor(private readonly core: TimelineCore) {}

  /**
   * One frame of a video as a picture in the library. `once`: the same frame asked for again is the same
   * picture (a clip rendered several times from the same last frame does not fill the library with copies).
   */
  async frame(video: AssetRow, atMs: number, once = false): Promise<AssetRow> {
    const { db, storage, events } = this.core;
    const id = once ? createHash("sha1").update(`frame:${video.id}:${Math.round(atMs)}`).digest("hex").slice(0, 32) : newId();
    const have = once ? await db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    if (have) {
      if (have.deleted_at) await db.updateTable("assets").set({ deleted_at: null }).where("id", "=", id).execute();
      return have;
    }
    const bytes = await frameAt(await storage.get(video.file_key), extOf(video.mime), atMs, video.duration_ms ?? undefined);
    const key = `assets/${id.slice(0, 2)}/${id}.png`;
    await storage.put(key, bytes);
    const thumb = await makeThumb(bytes);
    if (thumb) await storage.put(thumbKey(id), thumb);
    const size = pngSize(bytes);
    const at = now();
    await db
      .insertInto("assets")
      .values(newAssetRow({
        id, kind: "image", origin: "frame", name: video.name ? `${video.name}, a frame` : "", file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime: "image/png", bytes: bytes.length, width: size?.width ?? video.width, height: size?.height ?? video.height,
        duration_ms: null, fps: null, has_sound: 0, folder_id: video.folder_id, generation_id: null, source_id: video.id, kept_at: at, created_at: at,
      }))
      .execute();
    events.emit("library");
    return db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  /** Frames of a video side by side in one picture, for the timeline (and, at a size asked for, the trim bar). Made once per video and size, then kept. */
  async strip(assetId: string, opts: { frames?: number; height?: number; fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
    const { storage } = this.core;
    const video = await this.core.assetRow(assetId);
    if (!video || video.kind !== "video") throw notFound("this video");
    const windowed = opts.fromMs !== undefined || opts.toMs !== undefined;
    const sized = opts.frames || opts.height;
    const key = sized ? `strips/${video.id.slice(0, 2)}/${video.id}-${opts.frames ?? 0}x${opts.height ?? 0}.jpg` : `strips/${video.id.slice(0, 2)}/${video.id}.jpg`;
    const have = windowed ? null : await storage.get(key).catch(() => null);
    if (have) return have;
    const bytes = await storage.get(video.file_key);
    const length = video.duration_ms ?? (await readVideo(bytes, extOf(video.mime))).facts?.durationMs;
    if (!length) throw new CutError("This video could not be read.");
    const strip = await filmStrip(bytes, extOf(video.mime), length, opts);
    // a strip of a part is asked for while zooming: made each time, not kept
    if (!windowed) await storage.put(key, strip);
    return strip;
  }

  /** How much moves along a video and how loud it is, ten samples a second (see measureOf). Measured once, then kept. A sound file gives loudness only. */
  async motion(assetId: string): Promise<{ rate: number; values: number[]; sound: number[] | null }> {
    const { storage } = this.core;
    const asset = await this.core.assetRow(assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) throw notFound("this video");
    const key = `motion/${asset.id.slice(0, 2)}/${asset.id}.json`;
    const have = await storage.get(key).catch(() => null);
    if (have) {
      const kept = JSON.parse(Buffer.from(have).toString("utf8")) as { rate: number; values: number[]; sound?: number[] | null };
      if (kept.sound !== undefined) return { rate: kept.rate, values: kept.values, sound: kept.sound };
    }
    const { motion, sound } = await measureOf(await storage.get(asset.file_key), extOf(asset.mime));
    const made = { rate: MOTION_RATE, values: motion.map((v) => Math.round(v * 10) / 10), sound };
    await storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
    return made;
  }

  /** Where a video cuts between shots, kept once worked out (a video's frames do not change). */
  async scenes(assetId: string): Promise<{ cuts: number[] }> {
    const { storage } = this.core;
    const asset = await this.core.assetRow(assetId);
    if (!asset || asset.kind !== "video") throw notFound("this video");
    const key = `scenes/${asset.id.slice(0, 2)}/${asset.id}.json`;
    const have = await storage.get(key).catch(() => null);
    if (have) return JSON.parse(Buffer.from(have).toString("utf8")) as { cuts: number[] };
    const made = { cuts: await scenesOf(await storage.get(asset.file_key), extOf(asset.mime)) };
    await storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
    return made;
  }

  /** The jump across a join, per take, kept once worked out (a take and its neighbours' frames do not change). The last five hundred. */
  private joinScores = new Map<string, { in: number | null; out: number | null }>();

  /** The mean colour of stretches of takes already measured, by take, moment and length: the files do not change. The last five hundred. */
  private stretchMeans = new Map<string, Promise<Means | null>>();

  /** Forget the join scores and colour means of these takes: the file behind them changed (see Timelines.forgetDerived). */
  forgetTakes(takes: string[]): void {
    // a score names the take on each side of the join: one of them is enough to forget it
    for (const cache of [this.joinScores, this.stretchMeans]) for (const key of [...cache.keys()]) if (takes.some((id) => key.includes(id))) cache.delete(key);
  }

  /**
   * The colour nudge each clip gets in the player: the same as the export's matching, a clip nudged toward the
   * clip before over the last and first 0.4 s at their join, the clip before taken as it will look (its own
   * nudge included), within a few steps of 255. Zero for the first clip, for a still, and after one.
   */
  async matches(timelineId: string): Promise<Array<{ clip: string } & Means>> {
    const all = await this.core.placed(timelineId);
    const mean = (t: Taken, fromMs: number) => {
      const key = `${t.take.id}:${Math.round(fromMs)}`;
      let got = this.stretchMeans.get(key);
      if (!got) {
        got = this.core.storage.get(t.asset.file_key).then((bytes) => stretchMeans(bytes, extOf(t.asset.mime), fromMs, MATCH.lookSec)).catch(() => null);
        this.stretchMeans.set(key, got);
        capped(this.stretchMeans);
      }
      return got;
    };
    const out: Array<{ clip: string } & Means> = [];
    let carry: Means = { y: 0, u: 0, v: 0 };
    let before: Taken | null = null;
    for (const p of all) {
      const x = p.clip.kind === "video" ? p.active : null;
      // decoded as one piece with the clip before: the same nudge as that clip, no step where the chain has none
      if (x && before && p.clip.joined === "continue" && seamless(x)) {
        /* carry stays */
      } else if (x && before && sameMaking(before.asset, x.asset)) {
        const a = await mean(before, Math.max(0, visible(before).end - MATCH.lookSec * 1000));
        // what is seen: its first frames (its shared frames are a loose copy whose light differs, and they are not shown; see the export)
        const b = await mean(x, visible(x).start);
        carry = a && b ? colourNudge(a, b, carry) : { y: 0, u: 0, v: 0 };
      } else carry = { y: 0, u: 0, v: 0 };
      out.push({ clip: p.clip.id, ...carry });
      before = x && lengthOf(p) > 0 ? x : null;
    }
    return out;
  }

  /**
   * How smoothly each take of a clip meets its neighbours: at In, the clip before's last frame against
   * the take's first frame that plays; at Out, the take's last frame against the clip after's first.
   * ×1 = the join moves like the clip itself, higher = a catch. For picking among takes.
   */
  async joins(clipId: string): Promise<Array<{ take: string; in: number | null; out: number | null }>> {
    const clip = await this.core.clipRow(clipId);
    const all = await this.core.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const me = all[i]!;
    const edge = (p: Placed | undefined, side: "end" | "start") => {
      if (!p) return null;
      if (p.clip.kind === "still") return p.still ? { asset: p.still, atMs: 0, key: `still:${p.still.id}` } : null;
      if (!p.active) return null;
      const { start, end } = visible(p.active);
      return { asset: p.active.asset, atMs: side === "end" ? Math.max(start, end - 20) : start, key: `${p.active.take.id}:${side === "end" ? end : start}`, fade: side === "start" ? joinFade(p.active, p.clip.joined === "continue") : null };
    };
    const prev = edge(all[i - 1], "end");
    const next = edge(all[i + 1], "start");
    if (!prev && !next) return me.takes.map((t) => ({ take: t.take.id, in: null, out: null }));
    const bytes = new Map<string, Uint8Array>();
    const load = async (a: AssetRow) => {
      const have = bytes.get(a.id);
      if (have) return have;
      const got = await this.core.storage.get(a.file_key);
      bytes.set(a.id, got);
      return got;
    };
    const out: Array<{ take: string; in: number | null; out: number | null }> = [];
    for (const t of me.takes) {
      const { start, end } = visible(t);
      const key = `${t.take.id}:${start}:${end}:${prev?.key ?? "-"}:${next?.key ?? "-"}`;
      let score = this.joinScores.get(key);
      if (!score) {
        const fps = t.asset.fps ?? 24;
        score = {
          // as the join plays: with the fade the export and the player put there
          in: prev ? await joinJump({ bytes: await load(prev.asset), ext: extOf(prev.asset.mime), atMs: prev.atMs }, { bytes: await load(t.asset), ext: extOf(t.asset.mime), atMs: start, fps }, joinFade(t, me.clip.joined === "continue")) : null,
          out: next ? await joinJump({ bytes: await load(t.asset), ext: extOf(t.asset.mime), atMs: Math.max(start, end - 20) }, { bytes: await load(next.asset), ext: extOf(next.asset.mime), atMs: next.atMs, fps: next.asset.fps ?? fps }, next.fade) : null,
        };
        this.joinScores.set(key, score);
        capped(this.joinScores);
      }
      out.push({ take: t.take.id, ...score });
    }
    return out;
  }

  /** One small picture of a moment of a video, for a hover over the trim bar. Not kept. */
  async peek(assetId: string, atMs: number, height?: number): Promise<Uint8Array> {
    const video = await this.core.assetRow(assetId);
    if (!video || video.kind !== "video") throw notFound("this video");
    return peekAt(await this.core.storage.get(video.file_key), extOf(video.mime), atMs, height);
  }
}
