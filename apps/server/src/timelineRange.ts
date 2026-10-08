import { latentFrameAtOrBefore, MODEL_FPS, secondsInput, type Recipe } from "@afflatus/core";
import { CutError, rangeKeep, slowMotion } from "./cut";
import { newId, now, OWNER } from "./db";
import { httpError } from "./errors";
import { extOf } from "./media";
import { makeThumb, thumbKey } from "./thumbs";
import { sourceOf } from "./storage";
import { readVideo, videoFacts } from "./video";
import { clockOf, laidOut, landingOnGrid, lengthOf, lengthOnGrid, plays, STILL_MS, visible, type AssetRow, type ClipRow, type Laid, type Placed, type TimelineCore } from "./timelineModel";

/**
 * Cuts, on the timeline's clock and in a video's own time: a clip split or duplicated, a range of the
 * timeline split, removed, regenerated, looped or slowed, and a range of a video kept as videos of the
 * library. Each change is one step to undo.
 */

/** How a clip regenerated in a range meets its neighbours: with their video as context, on a frame, or nothing there. */
export interface RangeContext {
  start: "clip" | "frame" | "none";
  end: "clip" | "frame" | "none";
}

/** A model that opens on a frame (`start`) or ends on one (`end`). */
const takesFrame = (r: Recipe<any>, role: "start" | "end") => r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === role);
/** A model that takes the clip before (`previous`) or the clip after (`next`) as context. */
const carriesClip = (r: Recipe<any>, role: "previous" | "next") => r.output === "video" && r.inputs.some((i) => i.type === "clip" && i.role === role);

/**
 * How a clip on `r` regenerated between `before` and `after` meets them: a model that takes the clip before as context
 * extends it (the motion carries across), else it opens on the frame before In; the same at Out with the clip after (a
 * still is a picture either way). Null when it cannot meet one of them.
 */
function rangeContext(r: Recipe<any>, before: Laid | undefined, after: Laid | undefined): RangeContext | null {
  const start = !before ? "none" : before.p.clip.kind === "video" && carriesClip(r, "previous") ? "clip" : takesFrame(r, "start") ? "frame" : null;
  const end = !after ? "none" : after.p.clip.kind === "video" && carriesClip(r, "next") ? "clip" : takesFrame(r, "end") ? "frame" : null;
  return start && end ? { start, end } : null;
}

export class TimelineRange {
  constructor(private readonly core: TimelineCore) {}

  /**
   * A range of a video, kept as new videos of the library: `copy` = the range as one video (the source
   * stays); `split` = before, range, after as three (the source goes to the bin); `remove` = one video
   * without the range (the source goes to the bin). Each new video remembers its source and its range.
   */
  async cutRange(video: AssetRow, startMs: number, endMs: number, action: "copy" | "split" | "remove", opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow[]> {
    const { db, events } = this.core;
    const { source, ext, total } = await this.opened(video);
    if (!total) throw new CutError("This video could not be read.");
    const a = Math.max(0, Math.min(startMs, endMs));
    const b = Math.min(total, Math.max(startMs, endMs));
    if (b - a < 20) throw new CutError("That range is too short: pick at least one frame.");
    if (a <= 0 && b >= total - 2) throw new CutError("That is the whole video: there is nothing to cut.");
    const facts = { durationMs: total, hasSound: Boolean(video.has_sound) };
    const pieces: Array<{ keep: Array<[number, number]>; said: string; range: string }> =
      action === "copy" ? [{ keep: [[a, b]], said: `${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` }]
      : action === "remove" ? [{ keep: [[0, a], [b, total]], said: `without ${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` }]
      : [
        ...(a >= 20 ? [{ keep: [[0, a]] as Array<[number, number]>, said: `${clockOf(0)}–${clockOf(a)}`, range: `0-${a}` }] : []),
        { keep: [[a, b]], said: `${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` },
        ...(total - b >= 20 ? [{ keep: [[b, total]] as Array<[number, number]>, said: `${clockOf(b)}–${clockOf(total)}`, range: `${b}-${total}` }] : []),
      ];
    const base = (video.name || "video").replace(/\.[a-z0-9]+$/i, "");
    // ffmpeg first, the files put away as they come; then every row at once, with the source binned when it was taken apart
    const rows: AssetRow[] = [];
    for (const piece of pieces) {
      const out = await rangeKeep(source, ext, facts, piece.keep, opts);
      rows.push(await this.cutRow(video, out, `${base} · ${piece.said}`, piece.range));
    }
    await db.transaction().execute(async (tx) => {
      for (const row of rows) await tx.insertInto("assets").values(row).execute();
      // the source goes to the bin when it was taken apart: a day to change one's mind
      if (action !== "copy") await tx.updateTable("assets").set({ deleted_at: now() }).where("id", "=", video.id).execute();
    });
    events.emit("library");
    const made = await db.selectFrom("assets").selectAll().where("id", "in", rows.map((r) => r.id)).execute();
    return rows.map((r) => made.find((m) => m.id === r.id)!);
  }

  /** A stored video as ffmpeg is handed it (its path when it is on the disk here), its length and its speed, read from the file when its row does not say. */
  private async opened(video: AssetRow) {
    const source = await sourceOf(this.core.storage, video.file_key);
    const ext = extOf(video.mime);
    const read = video.duration_ms && video.fps ? null : typeof source === "string" ? await videoFacts(source) : (await readVideo(source, ext)).facts;
    return { source, ext, total: video.duration_ms ?? read?.durationMs ?? 0, fps: video.fps ?? read?.fps ?? null };
  }

  /**
   * A video cut out of another, ready to be filed beside it: its file and its small picture are put away
   * here, the row (its source and the range taken, kept, not in the bin) is the caller's to insert.
   */
  private async cutRow(original: AssetRow, out: Uint8Array, name: string, range: string): Promise<AssetRow> {
    const { storage } = this.core;
    const seen = await readVideo(out, "mp4");
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.mp4`;
    await storage.put(key, out);
    const thumb = seen.frame ? await makeThumb(seen.frame) : null;
    if (thumb) await storage.put(thumbKey(id), thumb);
    const at = now();
    return {
      id, owner_id: OWNER, kind: "video", origin: "cut", name, file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime: "video/mp4", bytes: out.length,
      width: seen.facts?.width ?? original.width, height: seen.facts?.height ?? original.height,
      duration_ms: seen.facts?.durationMs ?? null, fps: seen.facts?.fps ?? original.fps, has_sound: seen.facts?.hasSound ? 1 : 0,
      folder_id: original.folder_id, generation_id: null, source_id: original.id, source_range: range, raw_key: null, latent_key: null, latent_frames: null, fine_latent_key: null,
      kept_at: at, countdown_from: null, deleted_at: null, linked_path: null, created_at: at,
    };
  }

  /**
   * One clip becomes two at a moment of its take (in the video's own time, as its take's `startMs` and `endMs` say: the
   * frame seen there, whatever a landing or a seamless join moves): the first plays up to it, the second from it on, both
   * from the same video; the second takes the clip's model, form, sound and look along, and starts as a cut. Undo takes it back.
   */
  async splitClip(clipId: string, atMs: number): Promise<string> {
    const clip = await this.core.clipRow(clipId);
    const p = (await this.core.placed(clip.timeline_id)).find((x) => x.clip.id === clipId);
    if (!p?.active) throw httpError("This clip has no take yet: render it first.");
    const { start, end } = visible(p.active);
    if (atMs < start + 40 || atMs > end - 40) throw httpError("Put the playhead inside the part that plays, at least a frame from its ends.");
    await this.core.remember(clip.timeline_id, "the split");
    const id = await this.splitAt(clip.timeline_id, p, atMs - start);
    await this.core.touch(clip.timeline_id);
    return id;
  }

  /** A copy of the clip right after it: the same form, look and sound, its takes again (the same videos), the same one playing. It starts as a cut. */
  async duplicateClip(clipId: string): Promise<string> {
    const { db } = this.core;
    const clip = await this.core.clipRow(clipId);
    const all = await this.core.placed(clip.timeline_id);
    const index = all.findIndex((p) => p.clip.id === clipId);
    const takes = await db.selectFrom("takes").selectAll().where("clip_id", "=", clipId).orderBy("created_at").execute();
    await this.core.remember(clip.timeline_id, "the duplicate");
    const id = newId();
    const at = now();
    const ids = new Map(takes.map((t) => [t.id, newId()]));
    const order = all.map((p) => p.clip.id);
    order.splice(index + 1, 0, id);
    // the copy, its takes and its place land together, or not at all; a finished take stays the finished version of the copy's
    // own draft (not of the original's: a redo of its finish then starts from the draft again)
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto("clips")
        .values({ ...clip, id, position: index + 1, take_id: clip.take_id ? ids.get(clip.take_id) ?? null : null, joined: "cut", chat: null, created_at: at, updated_at: at })
        .execute();
      for (const t of takes) {
        const finished = t.finished_from ? ids.get(t.finished_from) ?? null : null;
        await tx.insertInto("takes").values({ ...t, id: ids.get(t.id)!, clip_id: id, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: finished, created_at: at }).execute();
      }
      await this.core.renumber(clip.timeline_id, order, tx);
    });
    await this.core.touch(clip.timeline_id);
    return id;
  }

  /**
   * The split itself: `localMs` after the moment the clip starts playing. A still becomes two stills.
   * The second clip takes the first's model, form, sound and look, and starts as a cut.
   */
  private async splitAt(timelineId: string, p: Placed, localMs: number): Promise<string> {
    const { db } = this.core;
    const all = await this.core.placed(timelineId);
    const index = all.findIndex((x) => x.clip.id === p.clip.id);
    const clip = p.clip;
    const id = newId();
    const at = now();
    const still = clip.kind === "still";
    await db
      .insertInto("clips")
      .values({
        id, timeline_id: timelineId, position: index + 1, take_id: null, joined: "cut", recipe_id: still ? null : clip.recipe_id, inputs: still ? "{}" : clip.inputs,
        kind: clip.kind, still_asset_id: still ? clip.still_asset_id : null, still_ms: still ? Math.max(STILL_MS.least, Math.round(clip.still_ms - localMs)) : 3000,
        sound: clip.sound, sound_asset_id: clip.sound_asset_id, volume: clip.volume, fill: clip.fill, look: clip.look, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    const order = all.map((x) => x.clip.id);
    order.splice(index + 1, 0, id);
    await this.core.renumber(timelineId, order);
    if (still) {
      await db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(localMs)), updated_at: at }).where("id", "=", clip.id).execute();
      return id;
    }
    const { take, asset } = p.active!;
    const atMs = visible(p.active!).start + localMs;
    // the second half: the same video, trimmed to start where the first stops
    const second = newId();
    await db
      .insertInto("takes")
      .values({
        id: second, clip_id: id, asset_id: asset.id, head_ms: take.head_ms, tail_ms: take.tail_ms, trim_start_ms: Math.max(0, Math.round(atMs - take.head_ms)), trim_end_ms: take.trim_end_ms,
        // the second half starts as a cut inside the video; it ends where the clip did, so it still lands on the clip after
        // as the clip did, and it is as finished as the clip was (a finish asked again starts from the draft, not from it)
        prev_take_id: null, prev_at_ms: null, next_take_id: take.next_take_id, next_at_ms: take.next_at_ms, finished_from: take.finished_from, join_kind: null, created_at: at,
      })
      .execute();
    await db.updateTable("clips").set({ take_id: second, updated_at: at }).where("id", "=", id).execute();
    // the first half stops at the moment
    await db.updateTable("takes").set({ trim_end_ms: Math.max(0, Math.round(lengthOnGrid(asset) - take.tail_ms - atMs)) }).where("id", "=", take.id).execute();
    return id;
  }

  // ---------------------------------------------------------------- a range of the timeline

  /** In and Out, in order and within what plays; refused when nothing plays yet. */
  private async window(timelineId: string, inMs: number, outMs: number) {
    await this.core.row(timelineId);
    const laid = laidOut(await this.core.placed(timelineId));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    if (!total) throw httpError("Nothing plays yet: render a clip, or add a video or a picture first.");
    const a = Math.max(0, Math.min(total, Math.min(inMs, outMs)));
    const b = Math.max(0, Math.min(total, Math.max(inMs, outMs)));
    return { laid, total, a, b };
  }

  /** The clip that plays just before a moment (the one a cut at that moment ends), and the one that plays it. */
  private before(laid: Laid[], ms: number) { return laid.find((l) => l.atMs < ms && ms <= l.atMs + l.lengthMs); }
  private at(laid: Laid[], ms: number) { return laid.find((l) => l.atMs <= ms && ms < l.atMs + l.lengthMs); }

  /** A clip plays only its first `keepMs`. */
  private async endAt(p: Placed, keepMs: number) {
    const { db } = this.core;
    if (p.clip.kind === "still") return void (await db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(keepMs)), updated_at: now() }).where("id", "=", p.clip.id).execute());
    const x = p.active!;
    const total = lengthOnGrid(x.asset);
    await db.updateTable("takes").set({ trim_end_ms: Math.max(0, Math.round(total - x.take.tail_ms - (visible(x).start + keepMs))) }).where("id", "=", x.take.id).execute();
  }

  /** A clip plays from `fromMs` into what it played. It no longer starts where the clip before stopped: a cut. */
  private async startAt(p: Placed, fromMs: number) {
    const { db } = this.core;
    if (p.clip.kind === "still") return void (await db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(p.clip.still_ms - fromMs)), updated_at: now() }).where("id", "=", p.clip.id).execute());
    const x = p.active!;
    await db.updateTable("takes").set({ trim_start_ms: Math.max(0, Math.round(x.take.trim_start_ms + fromMs)) }).where("id", "=", x.take.id).execute();
    if (p.clip.joined === "continue") await db.updateTable("clips").set({ joined: "cut", updated_at: now() }).where("id", "=", p.clip.id).execute();
  }

  /**
   * What plays between In and Out goes: the clips inside, and the parts of the clips at the edges (a
   * clip with less than a tenth of a second left goes too). The clips after close the gap.
   */
  private async cutOut(timelineId: string, a: number, b: number): Promise<void> {
    const EDGE = 100;
    let all = await this.core.placed(timelineId);
    let laid = laidOut(all);
    // the range inside one clip: that clip is split at Out first, so that what is after the range stays a clip
    const both = laid.find((l) => l.atMs < a && l.atMs + l.lengthMs > b);
    if (both) {
      await this.splitAt(timelineId, both.p, b - both.atMs);
      all = await this.core.placed(timelineId);
      laid = laidOut(all);
    }
    // a clip with nothing to play yet (not laid out: it takes no time) goes with the range when it stands inside it
    const gone: string[] = unplayedWithin(all, a, b);
    for (const l of laid) {
      const start = l.atMs;
      const end = l.atMs + l.lengthMs;
      if (start >= a - 1 && end <= b + 1) gone.push(l.p.clip.id);
      else if (start < a && end > a) {
        if (a - start < EDGE) gone.push(l.p.clip.id);
        else await this.endAt(l.p, a - start);
      } else if (start < b && end > b) {
        if (end - b < EDGE) gone.push(l.p.clip.id);
        else await this.startAt(l.p, b - start);
      }
    }
    if (gone.length) await this.core.db.deleteFrom("clips").where("id", "in", gone).execute();
    await this.core.renumber(timelineId, (await this.core.placed(timelineId)).map((p) => p.clip.id));
  }

  /** The clips under In and under Out each become two there. Both moments on cuts already: nothing to do. */
  async splitRange(timelineId: string, inMs: number, outMs: number): Promise<void> {
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    const inside = (ms: number) => laid.find((l) => l.atMs + 40 <= ms && ms <= l.atMs + l.lengthMs - 40);
    const marks = [...new Set([b, a])].filter((ms) => inside(ms));
    if (!marks.length) throw httpError("In and Out are both on cuts already: there is nothing to split.");
    await this.core.remember(timelineId, marks.length === 2 ? "the split at In and Out" : "the split");
    // Out first: the clips before it keep their places
    for (const ms of marks) {
      const l = inside(ms);
      if (l) await this.splitAt(timelineId, (await this.core.placed(timelineId)).find((p) => p.clip.id === l.p.clip.id)!, ms - l.atMs);
    }
    await this.core.touch(timelineId);
  }

  /** What plays between In and Out goes; the clips after close the gap. Undo brings it back. */
  async removeRange(timelineId: string, inMs: number, outMs: number): Promise<void> {
    const { a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw httpError("Set In and Out apart: there is nothing between them.");
    await this.core.remember(timelineId, "the range removed");
    await this.cutOut(timelineId, a, b);
    await this.core.touch(timelineId);
  }

  /** The picture at a moment of a clip (`localMs` after it starts playing): a still itself, a frame of a take. */
  private async pictureAt(l: Laid, localMs: number): Promise<AssetRow> {
    if (l.p.clip.kind === "still") return l.p.still!;
    const x = l.p.active!;
    const { start, end } = visible(x);
    // within what is seen: the last frame that plays is a little before the moment the clip stops
    const ms = Math.max(start, Math.min(end - 20, start + localMs));
    return this.core.frame(x.asset, ms, true);
  }

  /**
   * What plays between In and Out is replaced by a new clip to render, pinned to the frame just before In
   * and the frame at Out (whichever exist: at the very start or end of the timeline there is only one),
   * as long as the range on a model that takes those frames: the clip's at In when it does, else the
   * first that does. It starts from that clip's words and settings. In = Out on a cut: a clip between
   * the two, nothing removed. The clip is not rendered here: it is selected, and its form is yours first.
   */
  async regenerateRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext; widenedMs?: number; longerMs?: number }> {
    const { registry } = this.core;
    const w = await this.window(timelineId, inMs, outMs);
    const { laid, total } = w;
    let a = this.onLatentGrid(laid, w.a);
    let b = w.b;
    let before = a > 0 ? this.before(laid, a) : undefined;
    let after = b < total ? this.at(laid, b) : undefined;
    if (!before && !after) throw httpError("The range covers everything: there is no frame to pin the new clip to. Add a clip instead.");
    const fits = (r: Recipe<any> | undefined): r is Recipe<any> => Boolean(r && rangeContext(r, before, after));
    const source = before ?? after!;
    const own = source.p.clip.recipe_id ? registry.recipe(source.p.clip.recipe_id) : undefined;
    const recipe = fits(own) ? own : registry.recipes().find(fits);
    if (!recipe) {
      throw httpError(before && after ? "None of your video models takes a first and a last frame: nothing can be rendered between the clips." : before ? "None of your video models takes a first frame (i2v)." : "None of your video models takes a last frame.");
    }
    const length = secondsInput(recipe.inputs);
    const wide = this.widenToModelLength(laid, total, recipe, { a, b, before, after });
    ({ a, b, before, after } = wide);
    const landing = this.landOnNextChunk(recipe, b, after);
    b += landing;
    const widenedMs = wide.widenedMs + landing;
    const context = rangeContext(recipe, before, after)!;
    const first = context.start === "frame" ? await this.pictureAt(before!, a - before!.atMs) : null;
    const last = context.end === "frame" ? await this.pictureAt(after!, b - after!.atMs) : null;
    await this.core.remember(timelineId, b - a >= 40 ? "the regenerated range" : "the clip added between");
    if (b - a >= 40) await this.cutOut(timelineId, a, b);
    // where it goes: after the last clip that stops by In
    const all = await this.core.placed(timelineId);
    const anchor = [...laidOut(all)].reverse().find((l) => l.atMs + l.lengthMs <= a + 50);
    const index = anchor ? anchor.index + 1 : 0;
    const id = await this.placeRangeClip(timelineId, all, index, source.p, recipe, {
      // extending the clip before: the render is given that clip's video up to In
      joined: context.start === "clip" ? "continue" : "cut",
      // the clip after: it follows the new clip when the model can end where it begins (the render is given its video from Out), else it is a cut
      nextJoined: context.end === "clip" ? "continue" : "cut",
      first, last, seconds: b - a >= 40 ? (b - a) / 1000 : undefined,
    });
    await this.core.touch(timelineId);
    // still shorter than the model makes (the clips around it too short to take from): what follows moves by that much
    const longerMs = length && b - a >= 40 ? Math.max(0, Math.round(length.min * 1000 - (b - a))) : 0;
    return { clip: id, context, ...(widenedMs ? { widenedMs } : {}), ...(longerMs > 40 ? { longerMs } : {}) };
  }

  /**
   * The clip before kept its latent (an H3 render): In goes back to a frame of its latent's grid (17k + 5), so the
   * new clip continues it in the latent, cut there, rather than from its frames (at most 16 frames earlier).
   */
  private onLatentGrid(laid: Laid[], x: number): number {
    const under = x > 0 ? this.before(laid, x) : undefined;
    if (!under?.p.active?.asset.latent_frames || under.p.clip.kind !== "video") return x;
    const assetMs = visible(under.p.active).start + (x - under.atMs);
    const frame = Math.round((assetMs * MODEL_FPS) / 1000);
    const grid = latentFrameAtOrBefore(frame);
    const back = ((frame - grid) * 1000) / MODEL_FPS;
    return grid >= 22 && back > 0 && x - back > under.atMs + 40 ? Math.round(x - back) : x;
  }

  /**
   * The range brought to a length the model makes: at least its least (H3: 4 s). Rendered as asked, a 2 s range came
   * out 4 s and everything after it moved later by the difference. The extra is taken from the clip under Out, then
   * from the one under In, keeping a second of each to join to (a guide is up to 22 frames); the clip then
   * replaces what it plays and the rest of the timeline stays put (within the model's own frame grid: H3 makes
   * 17k + 5 frames, up to half a second more or a sixth less than asked). Left as it is when the model would then no longer meet its neighbours.
   */
  private widenToModelLength(laid: Laid[], total: number, recipe: Recipe<any>, r: { a: number; b: number; before?: Laid; after?: Laid }) {
    const { a, b, before, after } = r;
    const length = secondsInput(recipe.inputs);
    const same = { ...r, widenedMs: 0 };
    if (!length || b - a < 40) return same;
    const ROOM = 1000;
    const want = (x: number) => Math.min(length.max * 1000, Math.max(length.min * 1000, x));
    const deficit = want(b - a) - (b - a);
    if (deficit <= 20) return same;
    // within the clips the range already reaches into: a clip it did not touch is not replaced
    const later = after ? Math.max(0, Math.min(deficit, after.atMs + after.lengthMs - b - ROOM)) : 0;
    const earlier = before ? Math.max(0, Math.min(deficit - later, a - before.atMs - ROOM)) : 0;
    const na = earlier > 0 ? this.onLatentGrid(laid, Math.round(a - earlier)) : a;
    // back on the grid In can come further back than asked: Out then gives back what it does not need
    const nb = Math.max(b, Math.min(b + later, na + want(b - na)));
    const wider = { a: na, b: nb, before: na > 0 ? this.before(laid, na) : undefined, after: nb < total ? this.at(laid, nb) : undefined };
    return rangeContext(recipe, wider.before, wider.after) && (nb > b || na < a) ? { ...wider, widenedMs: nb - na - (b - a) } : same;
  }

  /**
   * Landing on a clip after whose latent was kept: how far Out goes forward, to where one of its latent's 17-frame chunks begins
   * (at most 16 frames), so that the new clip lands on it in the latent, on time (H3_LANDING); the render lands there anyway.
   */
  private landOnNextChunk(recipe: Recipe<any>, b: number, after: Laid | undefined): number {
    const onto = after?.p.clip.kind === "video" && carriesClip(recipe, "next") ? after.p.active : null;
    if (!onto || !after) return 0;
    const from = plays(onto).start + (b - after.atMs);
    const there = landingOnGrid({ take: { ...onto.take, trim_start_ms: from - onto.take.head_ms }, asset: onto.asset });
    return there > from && b + (there - from) < after.atMs + after.lengthMs - 100 ? there - from : 0;
  }

  /**
   * The clip a range operation adds, put at `index`: on `recipe`, with the source clip's own settings when
   * that is its model (else what a new clip there would get) and its words when both models have them,
   * opening on `first` and ending on `last` when given, `seconds` long when the model has a length. The
   * clip at `index` before it follows it or starts as a cut, as `nextJoined` says. Within one transaction.
   */
  private async placeRangeClip(
    timelineId: string, all: Placed[], index: number, source: Placed, recipe: Recipe<any>,
    how: { joined: ClipRow["joined"]; nextJoined: ClipRow["joined"]; first: AssetRow | null; last: AssetRow | null; seconds?: number },
  ): Promise<string> {
    const own = source.clip.recipe_id ? this.core.registry.recipe(source.clip.recipe_id) : undefined;
    const srcInputs = JSON.parse(source.clip.inputs) as Record<string, unknown>;
    const inputs: Record<string, unknown> = own?.id === recipe.id
      ? Object.fromEntries(Object.entries(srcInputs).filter(([id]) => recipe.inputs.some((i) => i.id === id && !["prompt", "image", "clip", "seed"].includes(i.type))))
      : this.core.settingsOf(recipe, all, index);
    const mainOf = (r: Recipe<any>) => r.inputs.find((i) => i.type === "prompt" && !i.optional) ?? r.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
    const from = own ? mainOf(own) : undefined;
    const to = mainOf(recipe);
    if (from && to && typeof srcInputs[from.id] === "string") inputs[to.id] = srcInputs[from.id];
    if (how.first) inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id] = how.first.id;
    if (how.last) inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "end")!.id] = how.last.id;
    const seconds = secondsInput(recipe.inputs);
    // the length of the range itself, not rounded to the form's step: rounded, the clip came out up to a quarter second off and moved what follows
    if (seconds && how.seconds !== undefined) inputs[seconds.id] = Number(Math.max(seconds.min, Math.min(seconds.max, how.seconds)).toFixed(3));
    const id = newId();
    const at = now();
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    const next = all[index];
    await this.core.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("clips")
        .values({
          id, timeline_id: timelineId, position: index, take_id: null, joined: how.joined, recipe_id: recipe.id, inputs: JSON.stringify(inputs),
          kind: "video", still_asset_id: null, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: source.clip.look, chat: null, created_at: at, updated_at: at,
        })
        .execute();
      await this.core.renumber(timelineId, order, tx);
      if (next && next.clip.joined !== how.nextJoined) await tx.updateTable("clips").set({ joined: how.nextJoined, updated_at: at }).where("id", "=", next.clip.id).execute();
    });
    return id;
  }

  /**
   * A clip added after Out that brings the picture back to the frame at In, so that the range plays round:
   * it extends the clip at Out (or opens on its last frame) and ends on the frame at In, on a model that
   * takes a last frame. Out inside a clip: that clip is split there first. The clip after, if any, follows
   * as a cut. Short by default (a second and a half, or the least the model allows). Not rendered here: it
   * is selected, and its form is yours first. `arrive` is the clip under In, for the designer.
   */
  async loopRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext; arrive: string }> {
    const { registry } = this.core;
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw httpError("Set In and Out apart: a loop needs something to play round.");
    const source = this.before(laid, b)!;
    const target = this.at(laid, a) ?? this.before(laid, a)!;
    const startBy = (r: Recipe<any>): "clip" | "frame" | null => (source.p.clip.kind === "video" && carriesClip(r, "previous") ? "clip" : takesFrame(r, "start") ? "frame" : null);
    const fits = (r: Recipe<any> | undefined): r is Recipe<any> => Boolean(r && startBy(r) && takesFrame(r, "end"));
    const own = source.p.clip.recipe_id ? registry.recipe(source.p.clip.recipe_id) : undefined;
    const recipe = fits(own) ? own : registry.recipes().find(fits);
    if (!recipe) throw httpError("None of your video models takes a last frame: nothing can bring the range back to its start.");
    const context: RangeContext = { start: startBy(recipe)!, end: "frame" };
    const first = context.start === "frame" ? await this.pictureAt(source, b - source.atMs) : null;
    const last = await this.pictureAt(target, a - target.atMs);
    await this.core.remember(timelineId, "the loop clip");
    // Out inside a clip: split there, so that the loop clip comes right after what plays in the range
    if (b < source.atMs + source.lengthMs - 40) await this.splitAt(timelineId, source.p, b - source.atMs);
    const all = await this.core.placed(timelineId);
    const anchor = [...laidOut(all)].reverse().find((l) => l.atMs + l.lengthMs <= b + 50);
    const index = anchor ? anchor.index + 1 : 0;
    const id = await this.placeRangeClip(timelineId, all, index, source.p, recipe, {
      joined: context.start === "clip" ? "continue" : "cut",
      // what came after Out does not follow the loop clip: it ends on In's frame, not on that clip
      nextJoined: "cut",
      first, last, seconds: 1.5,
    });
    await this.core.touch(timelineId);
    return { clip: id, context, arrive: target.p.clip.id };
  }

  // ---------------------------------------------------------------- slow motion

  /** The range of a video as one small file to hand to ComfyUI: cut to the frame, at its own frame rate. */
  async rangeSlice(video: AssetRow, startMs: number, endMs: number): Promise<{ bytes: Uint8Array; fps: number }> {
    const { source, ext, total, fps } = await this.opened(video);
    if (!total) throw new CutError("This video could not be read.");
    const a = Math.max(0, Math.min(startMs, endMs));
    const b = Math.min(total, Math.max(startMs, endMs));
    return { bytes: await rangeKeep(source, ext, { durationMs: total, hasSound: Boolean(video.has_sound) }, [[a, b]], { crf: 10 }), fps: fps ?? 24 };
  }

  /** A video made from a range of another, filed in the library next to it with its source and range. */
  async keepCut(original: AssetRow, out: Uint8Array, name: string, startMs: number, endMs: number): Promise<AssetRow> {
    const { db, events } = this.core;
    const row = await this.cutRow(original, out, name, `${Math.round(startMs)}-${Math.round(endMs)}`);
    await db.insertInto("assets").values(row).execute();
    events.emit("library");
    return db.selectFrom("assets").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
  }

  /** The name a slowed range is filed under. */
  slowName(video: AssetRow, startMs: number, endMs: number, factor: number): string {
    const base = (video.name || "video").replace(/\.[a-z0-9]+$/i, "");
    return `${base} · slow ×${factor} ${clockOf(startMs)}–${clockOf(endMs)}`;
  }

  /** The range slowed by ffmpeg (no GPU), filed in the library. */
  async slowRange(video: AssetRow, startMs: number, endMs: number, factor: 2 | 4, opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow> {
    const { source, ext, total, fps } = await this.opened(video);
    if (!total) throw new CutError("This video could not be read.");
    const out = await slowMotion(source, ext, { durationMs: total, fps, hasSound: Boolean(video.has_sound) }, startMs, endMs, factor, opts);
    return this.keepCut(video, out, this.slowName(video, startMs, endMs, factor), startMs, endMs);
  }

  /**
   * The range made clips of their own, for slow motion: the clips under In and Out are split there, so
   * that what lies between is whole clips. Stills among them are simply held `factor` times longer. The
   * video clips come back with the part of their video to slow (a job each, whose video becomes their
   * take). The clips that followed one of them no longer do: they become cuts. One step to undo, with the
   * takes that follow.
   */
  async slowRangeOf(timelineId: string, inMs: number, outMs: number, factor: 2 | 4): Promise<Array<{ clip: string; asset: AssetRow; startMs: number; endMs: number }>> {
    const { db } = this.core;
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw httpError("Set In and Out apart: there is nothing to slow down.");
    if (!laid.some((l) => l.p.clip.kind === "video" && l.p.active && l.atMs < b && l.atMs + l.lengthMs > a)) throw httpError("Nothing in the range plays a video: there is nothing to slow down.");
    await this.core.remember(timelineId, "the split for slow motion");
    // Out first, then In: the clips before keep their places
    for (const ms of [b, a]) {
      const l = laidOut(await this.core.placed(timelineId)).find((x) => x.atMs + 40 <= ms && ms <= x.atMs + x.lengthMs - 40);
      if (l) await this.splitAt(timelineId, (await this.core.placed(timelineId)).find((p) => p.clip.id === l.p.clip.id)!, ms - l.atMs);
    }
    const all = await this.core.placed(timelineId);
    const parts = laidOut(all).filter((l) => l.atMs >= a - 1 && l.atMs + l.lengthMs <= b + 1);
    const jobs: Array<{ clip: string; asset: AssetRow; startMs: number; endMs: number }> = [];
    const at = now();
    for (const l of parts) {
      if (l.p.clip.kind === "still") {
        await db.updateTable("clips").set({ still_ms: Math.min(STILL_MS.most, Math.round(l.p.clip.still_ms * factor)), updated_at: at }).where("id", "=", l.p.clip.id).execute();
      } else if (l.p.active) {
        const { start, end } = visible(l.p.active);
        jobs.push({ clip: l.p.clip.id, asset: l.p.active.asset, startMs: start, endMs: end });
      }
      // a clip that followed what is now slowed down no longer does
      const next = all[l.index + 1];
      if (next?.clip.joined === "continue") await db.updateTable("clips").set({ joined: "cut", updated_at: at }).where("id", "=", next.clip.id).execute();
    }
    const first = parts[0];
    if (first?.p.clip.joined === "continue") await db.updateTable("clips").set({ joined: "cut", updated_at: at }).where("id", "=", first.p.clip.id).execute();
    await this.core.touch(timelineId);
    return jobs;
  }
}

/** The clips with nothing to play yet (they take no time on the clock) that stand strictly inside In and Out: they go with the range. */
export function unplayedWithin(all: Placed[], a: number, b: number): string[] {
  const out: string[] = [];
  let at = 0;
  for (const p of all) {
    const length = lengthOf(p);
    if (length <= 0 && at > a && at < b) out.push(p.clip.id);
    at += length;
  }
  return out;
}
