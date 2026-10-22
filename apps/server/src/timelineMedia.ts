import { createHash } from "node:crypto";
import { frameName, nameOf } from "./autoName";
import { CutError, filmStrip, frameAt, KEYFRAME_STRIP_MS, pausesOf, peekAt } from "./cut";
import { colourNudge, MATCH, type FrameMeans, type Means, measureOf, meansAlong, meansWithin, MOTION_RATE, scenesOf, takeMeasures } from "./measure";
import { joinJump, lastFrameAt, LEAST_MOTION } from "./joinScore";
import { newId, now } from "./db";
import type { LibraryChange } from "./events";
import { notFound } from "./errors";
import { extOf, newAssetRow, pngSize } from "./media";
import { sourceOf } from "./storage";
import { folderForMade } from "./timelineFolder";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideo, videoFacts } from "./video";
import { joinFade, lengthOf, playingAs, sameMaking, seamless, stripKey, visible, type AssetRow, type Placed, type Taken, type TimelineCore } from "./timelineModel";

/**
 * What the timelines read out of their videos: a frame as a picture, the film strip, the motion and
 * loudness, the scene cuts, a peek for the trim bar, the colour along a video, and how smoothly the takes meet
 * at their joins. Most of it is worked out once and kept beside the video, since its frames do not change.
 */

/** Keep an in-process cache to its last `most` entries: the oldest go first (a Map keeps the order they were put in). */
function capped<K, V>(cache: Map<K, V>, most = 500): void {
  while (cache.size > most) cache.delete(cache.keys().next().value as K);
}

/** `work` for each item, `most` at a time: ffmpeg runs side by side without one per item at once. In the items' order. */
export async function fewAtATime<T, R>(items: T[], most: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, lane));
  return out;
}

/**
 * Where what is measured of a video once is kept beside it: its motion and loudness, its track's film strip, its frame
 * means. Written here as the editor asks for them, and by a take's landing, which measures them all at once
 * (precompute.ts, measureLanded).
 */
export const keptKey = {
  motion: (id: string) => `motion/${id.slice(0, 2)}/${id}.json`,
  strip: (id: string) => stripKey(id),
  means: (id: string) => `means/${id.slice(0, 2)}/${id}.json`,
};

/** The motion and loudness of a video as they are kept (TimelineMedia.motion): ten samples a second, the motion to a tenth. */
export const keptMotion = (m: { motion: number[]; sound: number[] | null; speech: number[] | null }) => ({ rate: MOTION_RATE, values: m.motion.map((v) => Math.round(v * 10) / 10), sound: m.sound, speech: m.speech });

/** A measure kept as JSON in storage; null when it cannot be read (cut short, damaged): it is then worked out again. */
function readKept<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export class TimelineMedia {
  constructor(private readonly core: TimelineCore) {}

  /** A stored video as ffmpeg is handed it: its path when it is on the disk here, else its bytes. */
  private source(asset: AssetRow) {
    return sourceOf(this.core.storage, asset.file_key);
  }

  /**
   * One frame of a video as a picture in the library. `once`: the same frame asked for again is the same
   * picture (a clip rendered several times from the same last frame does not fill the library with copies). It lands in the
   * folder of `timeline`, the one it is taken in (not said: see folderForMade).
   */
  async frame(video: AssetRow, atMs: number, once = false, timeline?: string, scratch = false): Promise<AssetRow> {
    const { db, storage, events } = this.core;
    // `scratch`: a box's working picture (Make the picture's frame), out of the library, its own id beside a kept frame's
    const id = once ? createHash("sha1").update(`${scratch ? "scratch-" : ""}frame:${video.id}:${Math.round(atMs)}`).digest("hex").slice(0, 32) : newId();
    const have = once ? await db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    if (have) {
      if (have.deleted_at) await db.updateTable("assets").set({ deleted_at: null }).where("id", "=", id).execute();
      return have;
    }
    const bytes = await frameAt(await this.source(video), extOf(video.mime), atMs, video.duration_ms ?? undefined);
    const key = `assets/${id.slice(0, 2)}/${id}.png`;
    await storage.put(key, bytes);
    const thumb = await makeThumb(bytes);
    if (thumb) await storage.put(thumbKey(id), thumb);
    const size = pngSize(bytes);
    const at = now();
    // "Big Air · c2 · t5 · frame 0:03.2": after the name the video goes by (worked out from where it came from when it has none)
    const source = await nameOf(db, video);
    const folder = await folderForMade(db, video, timeline);
    // the same frame asked for twice at once (two clips rendered from it): the second finds the first's row, the same picture
    await db
      .insertInto("assets")
      .values(newAssetRow({
        id, kind: "image", origin: scratch ? "scratch" : "frame", name: source ? frameName(source, atMs) : "", file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime: "image/png", bytes: bytes.length, width: size?.width ?? video.width, height: size?.height ?? video.height,
        duration_ms: null, fps: null, has_sound: 0, folder_id: scratch ? null : folder, generation_id: null, source_id: video.id, kept_at: scratch ? null : at, created_at: at,
      }))
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    if (!scratch) events.emit("library", { change: "added", items: [id], folders: [folder] } satisfies LibraryChange);
    return db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  /** Frames of a video side by side in one picture, for the timeline (and, at a size asked for, the trim bar). Made once per video and size, then kept. */
  strip(assetId: string, opts: { frames?: number; height?: number; fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
    // the track's strip asked for twice at once (the editor, and the same video measured in the background): made once
    const whole = !opts.frames && !opts.height && opts.fromMs === undefined && opts.toMs === undefined;
    return whole ? this.once(`strip:${assetId}`, () => this.stripOf(assetId, opts)) : this.stripOf(assetId, opts);
  }

  /** Work under way by what it makes: what is asked for again before it is done waits for the same run. */
  private readonly underWay = new Map<string, Promise<unknown>>();

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    let got = this.underWay.get(key) as Promise<T> | undefined;
    if (!got) {
      got = work().finally(() => this.underWay.delete(key));
      this.underWay.set(key, got);
    }
    return got;
  }

  private async stripOf(assetId: string, opts: { frames?: number; height?: number; fromMs?: number; toMs?: number }): Promise<Uint8Array> {
    const { storage } = this.core;
    const video = await this.core.assetRow(assetId);
    if (!video || video.kind !== "video") throw notFound("this video");
    const windowed = opts.fromMs !== undefined || opts.toMs !== undefined;
    const sized = opts.frames || opts.height;
    const key = sized ? stripKey(video.id, `${opts.frames ?? 0}x${opts.height ?? 0}`) : keptKey.strip(video.id);
    if (!windowed && !sized) await this.measuring(video.id);
    const have = windowed ? null : await storage.get(key).catch(() => null);
    if (have) return have;
    const source = await this.source(video);
    const length = video.duration_ms ?? (typeof source === "string" ? await videoFacts(source) : (await readVideo(source, extOf(video.mime))).facts)?.durationMs;
    if (!length) throw new CutError("This video could not be read.");
    const strip = await filmStrip(source, extOf(video.mime), length, opts);
    // a strip of a part is asked for while zooming: made each time, not kept
    if (!windowed) await storage.put(key, strip);
    return strip;
  }

  /** How much moves along a video and how loud it is, ten samples a second (see measureOf). Measured once, then kept. A sound file gives loudness only. */
  /** `row`: the asset's row, when the caller has it already (the duck, which has the whole timeline's). */
  motion(assetId: string, row?: AssetRow): Promise<{ rate: number; values: number[]; sound: number[] | null; speech: number[] | null }> {
    return this.once(`motion:${assetId}`, () => this.motionOf(assetId, row));
  }

  private async motionOf(assetId: string, row?: AssetRow): Promise<{ rate: number; values: number[]; sound: number[] | null; speech: number[] | null }> {
    const { storage } = this.core;
    const asset = row?.id === assetId ? row : await this.core.assetRow(assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) throw notFound("this video");
    const key = keptKey.motion(asset.id);
    await this.measuring(asset.id);
    const have = await storage.get(key).catch(() => null);
    // a file cut short (a crash while it was written) is measured again, not a video broken for good
    const kept = have ? readKept<{ rate: number; values: number[]; sound?: number[] | null; speech?: number[] | null }>(have) : null;
    // measured before the speech band was: measured again, once
    if (kept && Array.isArray(kept.values) && kept.sound !== undefined && kept.speech !== undefined) return { rate: kept.rate, values: kept.values, sound: kept.sound, speech: kept.speech };
    const made = keptMotion(await measureOf(await this.source(asset), extOf(asset.mime)));
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
    const kept = have ? readKept<{ cuts: number[] }>(have) : null;
    if (kept && Array.isArray(kept.cuts)) return kept;
    const made = { cuts: await scenesOf(await this.source(asset), extOf(asset.mime)) };
    await storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
    return made;
  }

  /** The pauses of a sound (or a video's sound), read once and kept beside it, as its scene cuts are: where a recording is cut into Lip sync clips. */
  async pauses(assetId: string): Promise<{ pauses: Array<{ start: number; end: number }> }> {
    const { storage } = this.core;
    const asset = await this.core.assetRow(assetId);
    if (!asset || (asset.kind !== "audio" && asset.kind !== "video")) throw notFound("this recording");
    const key = `pauses/${asset.id.slice(0, 2)}/${asset.id}.json`;
    const have = await storage.get(key).catch(() => null);
    const kept = have ? readKept<{ pauses: Array<{ start: number; end: number }> }>(have) : null;
    if (kept && Array.isArray(kept.pauses)) return kept;
    const made = { pauses: await pausesOf(await this.source(asset), extOf(asset.mime)) };
    await storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
    return made;
  }

  /** The colour along each video, by video, as it is being read or once read: the files do not change. The last two hundred. */
  private alongs = new Map<string, Promise<FrameMeans | null>>();

  /**
   * The mean luma and chroma of every frame of a video (meansAlong), worked out once per video and kept beside it, so that
   * any stretch of it (a take trimmed anew, another take of the same video) is read off it rather than measured again.
   */
  means(asset: AssetRow): Promise<FrameMeans | null> {
    let got = this.alongs.get(asset.id);
    if (!got) {
      const { storage } = this.core;
      const key = keptKey.means(asset.id);
      got = (async () => {
        await this.measuring(asset.id);
        const have = await storage.get(key).catch(() => null);
        const kept = have ? readKept<FrameMeans>(have) : null;
        if (kept) return kept;
        const made = await meansAlong(await this.source(asset), extOf(asset.mime));
        if (made.t.length) await storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
        return made;
      })().catch(() => null);
      this.alongs.set(asset.id, got);
      capped(this.alongs, 200);
      // a failure is not kept: the player would get no colour match at this video's joins until a restart, while the
      // export measures the file itself and nudges. The next ask measures it again
      const settling = got;
      void settling.then((made) => {
        if (made === null && this.alongs.get(asset.id) === settling) this.alongs.delete(asset.id);
      });
    }
    return got;
  }

  /** The jump across a join, per take, kept once worked out (a take and its neighbours' frames do not change). The last five hundred. */
  private joinScores = new Map<string, { in: number | null; out: number | null }>();

  /** Forget what was worked out of a video whose file changed (see Timelines.forgetDerived): its colour, and the join scores of the takes that play it. */
  forget(assetId: string, takes: string[]): void {
    this.alongs.delete(assetId);
    // a score names the take on each side of the join: one of them is enough to forget it
    for (const key of [...this.joinScores.keys()]) if (takes.some((id) => key.includes(id))) this.joinScores.delete(key);
  }

  /**
   * The colour nudge each clip gets in the player: the same as the export's matching, a clip nudged toward the
   * clip before over the last and first 0.4 s at their join, the clip before taken as it will look (its own
   * nudge included), within a few steps of 255. Zero for the first clip, for a still, and after one. A clip with
   * nothing to play is not in the export: it is passed over, the nudge carried on to the clip after it.
   */
  async matches(timelineId: string): Promise<Array<{ clip: string } & Means>> {
    const all = await this.core.placed(timelineId);
    // every video's colour read first, a few at a time
    const videos = [...new Map(all.flatMap((p) => (p.clip.kind === "video" && p.active && lengthOf(p) > 0 ? [[p.active.asset.id, p.active.asset] as const] : []))).values()];
    const along = new Map((await fewAtATime(videos, 3, async (a) => [a.id, await this.means(a)] as const)));
    const mean = (t: Taken, fromMs: number) => {
      const got = along.get(t.asset.id);
      return got ? meansWithin(got, fromMs, MATCH.lookSec) : null;
    };
    const out: Array<{ clip: string } & Means> = [];
    let carry: Means = { y: 0, u: 0, v: 0 };
    let before: Taken | null = null;
    for (const p of all) {
      if (lengthOf(p) <= 0) {
        out.push({ clip: p.clip.id, y: 0, u: 0, v: 0 });
        continue;
      }
      const x = p.clip.kind === "video" ? p.active : null;
      // decoded as one piece with the clip before: the same nudge as that clip, no step where the chain has none
      if (x && before && p.clip.joined === "continue" && seamless(x)) {
        /* carry stays */
      } else if (x && before && sameMaking(before.asset, x.asset)) {
        const a = mean(before, Math.max(0, visible(before).end - MATCH.lookSec * 1000));
        // what is seen: its first frames (its shared frames are a loose copy whose light differs, and they are not shown; see the export)
        const b = mean(x, visible(x).start);
        carry = a && b ? colourNudge(a, b, carry) : { y: 0, u: 0, v: 0 };
      } else carry = { y: 0, u: 0, v: 0 };
      out.push({ clip: p.clip.id, ...carry });
      before = x;
    }
    return out;
  }

  /**
   * How smoothly each take of a clip meets its neighbours: at In, the clip before's last frame against
   * the take's first frame that plays; at Out, the take's last frame against the clip after's first.
   * ×1 = the join moves like the clip itself, higher = a catch. For picking among takes. `most` takes at a time.
   */
  async joins(clipId: string, most = 3): Promise<Array<{ take: string; in: number | null; out: number | null }>> {
    const clip = await this.core.clipRow(clipId);
    const all = await this.core.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const me = all[i]!;
    const edge = (p: Placed | undefined, side: "end" | "start") => {
      if (!p) return null;
      if (p.clip.kind === "still") return p.still ? { asset: p.still, atMs: 0, key: `still:${p.still.id}` } : null;
      if (!p.active) return null;
      const { start, end } = visible(p.active);
      return { asset: p.active.asset, atMs: side === "end" ? Math.max(start, lastFrameAt(end, p.active.asset.fps)) : start, key: `${p.active.take.id}:${side === "end" ? end : start}`, fade: side === "start" ? joinFade(p.active, p.clip.joined === "continue" && me.clip.kind === "video") : null };
    };
    if (!edge(all[i - 1], "end") && !edge(all[i + 1], "start")) return me.takes.map((t) => ({ take: t.take.id, in: null, out: null }));
    const sources = new Map<string, Promise<string | Uint8Array>>();
    const load = (a: AssetRow) => {
      if (!sources.has(a.id)) sources.set(a.id, this.source(a));
      return sources.get(a.id)!;
    };
    return fewAtATime(me.takes, most, async (taken) => {
      // each take as it would play: where the clip before ends, and where it starts itself, move with the take that
      // plays (a continuation's take-over point, a landing, a seamless take). Measured against the playing take's
      // points, the others' figures changed with every take picked, and "smoothest" with them
      const as = playingAs(all, i, taken.take.id);
      const t = as[i]!.active!;
      const prev = edge(as[i - 1], "end");
      const next = edge(as[i + 1], "start");
      const { start, end } = visible(t);
      // the files' sizes too: a score kept on the disk outlives the process, and a linked file written again is another video;
      // and the floor it was weighed against (LEAST_MOTION) and where the clip before was read (lastFrameAt): a score made
      // otherwise is measured again
      const key = `least${LEAST_MOTION}:last1.5:${t.take.id}:${start}:${end}:${prev?.key ?? "-"}:${next?.key ?? "-"}:${t.asset.bytes}:${prev?.asset.bytes ?? "-"}:${next?.asset.bytes ?? "-"}`;
      let score = this.joinScores.get(key) ?? (await this.keptJoin(t.asset, key));
      if (score) this.joinScores.set(key, score);
      else {
        const fps = t.asset.fps ?? 24;
        score = {
          // as the join plays: with the fade the export and the player put there
          in: prev ? await joinJump({ source: await load(prev.asset), ext: extOf(prev.asset.mime), atMs: prev.atMs }, { source: await load(t.asset), ext: extOf(t.asset.mime), atMs: start, fps }, joinFade(t, me.clip.joined === "continue" && as[i - 1]?.clip.kind === "video")) : null,
          out: next ? await joinJump({ source: await load(t.asset), ext: extOf(t.asset.mime), atMs: Math.max(start, lastFrameAt(end, t.asset.fps)) }, { source: await load(next.asset), ext: extOf(next.asset.mime), atMs: next.atMs, fps: next.asset.fps ?? fps }, next.fade) : null,
        };
        this.joinScores.set(key, score);
        await this.keepJoin(t.asset, key, score);
      }
      capped(this.joinScores);
      return { take: t.take.id, ...score };
    });
  }

  /** The join scores kept beside a take's video, by what each was measured as (see joins): the last few dozen. */
  private joinsKey = (asset: AssetRow) => `joins/${asset.id.slice(0, 2)}/${asset.id}.json`;

  private async keptJoin(asset: AssetRow, key: string): Promise<{ in: number | null; out: number | null } | undefined> {
    const have = await this.core.storage.get(this.joinsKey(asset)).catch(() => null);
    return (have ? readKept<Record<string, { in: number | null; out: number | null }>>(have) : null)?.[key];
  }

  private async keepJoin(asset: AssetRow, key: string, score: { in: number | null; out: number | null }): Promise<void> {
    const { storage } = this.core;
    const have = await storage.get(this.joinsKey(asset)).catch(() => null);
    const kept = (have ? readKept<Record<string, { in: number | null; out: number | null }>>(have) : null) ?? {};
    delete kept[key];
    kept[key] = score;
    // a take trimmed again and again leaves a score per trim: the newest are kept
    const keys = Object.keys(kept);
    for (const old of keys.slice(0, Math.max(0, keys.length - 48))) delete kept[old];
    await storage.put(this.joinsKey(asset), new TextEncoder().encode(JSON.stringify(kept))).catch(() => {});
  }

  /**
   * What is missing of a video's motion, film strip and colour along it (`missing`, as missing() says), measured in one
   * decode of it and kept where each is kept, the same figures (takeMeasures without the look). Measured one at a time, a
   * video that is no render (an import, a cut, an export) was decoded three times: 43 CPU-s for a 1080p 30 s one against
   * 18. A strip past a minute is made by its keyframes as before, which decodes next to nothing. False when the one run
   * failed, or the video's length is not known: the caller measures them one at a time then.
   */
  measureTogether(asset: AssetRow, missing: Array<"motion" | "strip" | "means">): Promise<boolean> {
    return this.once(`together:${asset.id}`, () => this.togetherOf(asset, missing));
  }

  private async togetherOf(asset: AssetRow, missing: Array<"motion" | "strip" | "means">): Promise<boolean> {
    const { storage } = this.core;
    const length = asset.duration_ms;
    if (asset.kind !== "video" || !length) return false;
    const source = await this.source(asset);
    const ext = extOf(asset.mime);
    const strip = missing.includes("strip");
    const all = await takeMeasures(source, ext, { durationMs: length, hasSound: Boolean(asset.has_sound), look: false, strip: strip && length <= KEYFRAME_STRIP_MS }).catch(() => null);
    if (!all) return false;
    const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    if (missing.includes("motion")) await storage.put(keptKey.motion(asset.id), json(keptMotion(all.motion)));
    if (missing.includes("means") && all.means.t.length) await storage.put(keptKey.means(asset.id), json(all.means));
    if (strip) await storage.put(keptKey.strip(asset.id), all.strip ?? (await filmStrip(source, ext, length)));
    return true;
  }

  /** A video measured all at once (measureTogether): waited for, so that what it keeps is read back rather than measured again beside it. */
  private async measuring(assetId: string): Promise<void> {
    await this.underWay.get(`together:${assetId}`)?.catch(() => {});
  }

  /** What is not kept yet of a video: its motion, its track's film strip, its colour along it (what the background measure makes, precompute.ts). */
  async missing(asset: AssetRow): Promise<Array<"motion" | "strip" | "means">> {
    const { storage } = this.core;
    const there = (key: string) => storage.size(key).then((n) => n > 0, () => false);
    const out: Array<"motion" | "strip" | "means"> = [];
    if (!(await there(keptKey.motion(asset.id)))) out.push("motion");
    if (asset.kind === "video" && !(await there(keptKey.strip(asset.id)))) out.push("strip");
    if (asset.kind === "video" && !(await there(keptKey.means(asset.id)))) out.push("means");
    return out;
  }

  /** One small picture of a moment of a video, for a hover over the trim bar. Not kept. */
  async peek(assetId: string, atMs: number, height?: number): Promise<Uint8Array> {
    const video = await this.core.assetRow(assetId);
    if (!video || video.kind !== "video") throw notFound("this video");
    return peekAt(await this.source(video), extOf(video.mime), atMs, height);
  }
}
