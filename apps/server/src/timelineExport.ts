import { BLEND_MS, CutError, DISSOLVE_MS, type ExportMusic, type ExportPart, joinVideosInto } from "./cut";
import { newId, now } from "./db";
import { musicPlan } from "@afflatus/core";
import { duckCurve } from "./duck";
import { assetView, extOf, newAssetRow } from "./media";
import { sourceOf } from "./storage";
import { folderOfTimeline } from "./timelineFolder";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideoFile } from "./video";
import { clockOf, joinFade, laidOut, sameMaking, seamless, visible, type AssetRow, type Laid, type Placed, type TimelineCore, type TimelineRow, musicBaseOf, musicClipsOf } from "./timelineModel";

/** A timeline as one video: its clips that play joined in order, with their sounds, its music and the joins softened. */

export interface ExportAsk {
  scale?: number;
  music?: boolean;
  smooth?: boolean;
  range?: { inMs: number; outMs: number };
  blend?: boolean;
  match?: boolean;
  fit?: "timeline" | "largest";
  /** A copy for the web, under this many megabytes (see webCut). */
  webMb?: number;
  signal?: AbortSignal;
}

export class TimelineExport {
  constructor(private readonly core: TimelineCore) {}

  /**
   * The timeline as one video in the library: what plays, start to end, with its sounds and its music.
   * With a range: only that part, as a copy in the library (the music is left out).
   */
  async export(id: string, opts: ExportAsk = {}) {
    const t = await this.core.row(id);
    const laid = laidOut(await this.core.placed(id));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    const win = opts.range ? { a: Math.max(0, Math.min(opts.range.inMs, opts.range.outMs)), b: Math.min(total, Math.max(opts.range.inMs, opts.range.outMs)) } : null;
    if (win && win.b - win.a < 40) throw new CutError("Set In and Out apart: there is nothing between them.");
    const shown = win ? laid.filter((l) => l.atMs < win.b && l.atMs + l.lengthMs > win.a) : laid;
    const all = shown.map((l) => l.p);
    if (!all.length) throw new CutError("There is nothing to export yet: no clip of this timeline has a take.");
    const frame = exportFrame(t, all, opts.fit);
    const fps = Math.round(Math.max(...all.map((p) => p.active?.asset.fps ?? 24), 1));
    const parts: ExportPart[] = [];
    for (const [i, l] of shown.entries()) {
      // within the window: the part of the clip that falls in it
      const from = win ? Math.max(0, win.a - l.atMs) : 0;
      const to = win ? Math.min(l.lengthMs, win.b - l.atMs) : l.lengthMs;
      parts.push(await this.partFor(l, { from, to }, parts.at(-1), shown[i - 1]?.p, opts.blend !== false, fps));
    }
    const track = opts.music === false || win ? undefined : await this.core.assetRow(t.music_asset_id);
    // the plan the player follows too: the part of the song, from which clip, each clip's level under it
    const plan = track ? musicPlan(musicBaseOf(t, track), musicClipsOf(laid)) : null;
    const music: ExportMusic | undefined = track && plan && plan.endMs > plan.startMs
      ? {
          source: await sourceOf(this.core.storage, track.file_key), ext: extOf(track.mime), plan,
          duck: plan.spans.some((s) => s.duckDb > 0) ? await duckCurve(laid, (asset) => this.core.motion(asset), plan) : null,
        }
      : undefined;
    const joinOpts = { scale: opts.scale ?? 1, music, smoothTo: opts.smooth ? 48 : undefined, match: opts.match !== false, webMb: opts.webMb, signal: opts.signal };
    // stored from where ffmpeg wrote it: the export is never held whole in memory
    return joinVideosInto(parts, frame, fps, joinOpts, (file) => this.storeExport(t, file, frame, fps, win, Boolean(opts.webMb)));
  }

  /**
   * One clip's part of the export: a picture held, or the part of its take that is seen (`from`–`to` of it), with what is
   * heard, how it fades in over the part before (the same fade the player shows, joinFade) and how its colour is matched.
   */
  private async partFor(l: Laid, win: { from: number; to: number }, before: ExportPart | undefined, prior: Placed | undefined, blendJoins: boolean, fps: number): Promise<ExportPart> {
    const { storage } = this.core;
    const p = l.p;
    const { from, to } = win;
    const soundFile = p.clip.sound === "file" && p.sound ? { source: await sourceOf(storage, p.sound.file_key), ext: extOf(p.sound.mime) } : undefined;
    const heard = { sound: p.clip.sound, soundFile, volume: p.clip.volume / 100, fill: Boolean(p.clip.fill) };
    if (p.clip.kind === "still") return { kind: "still", source: await sourceOf(storage, p.still!.file_key), ext: extOf(p.still!.mime), startMs: from, endMs: to, hasSound: false, ...heard };
    const x = p.active!;
    /** The video of the part before (none after a still). */
    const beforeAsset: AssetRow | null = prior?.clip.kind === "video" ? prior.active?.asset ?? null : null;
    const afterVideo = before?.kind === "video";
    // a clip rendered as the continuation of the one before (it replayed the frames they share) starts its own part exactly
    // where that one stops: the model restarts beside the pinned frames, and the first generated frames may step away from
    // them. The fade softens that step, the same as the player's (joinFade): a take landed on (the clip before's guided tail
    // shows the same moments) fades over those moments with both moving; any other continuation of a video fades in over the
    // clip before held on its last frame; a seamless join (decoded as one piece with the clip before) is a plain cut
    const fade = afterVideo && from === 0 ? joinFade(x, p.clip.joined === "continue") : null;
    const landed = fade?.mode === "overlap";
    // a join made in the latent: the clip before plays to its end, held there while this one dissolves in (DISSOLVE_MS), the
    // sound straight on ("hybrid": takes made before 2026-10-08 joined in the latent too; none are made now)
    const dissolve = !landed && (x.take.join_kind === "latent" || x.take.join_kind === "hybrid");
    const blend = blendJoins && fade && before
      ? Math.min(landed ? fade.ms : dissolve ? DISSOLVE_MS : BLEND_MS, to - 40, ...(landed ? [x.landed!, before.endMs - before.startMs - 40] : []))
      : 0;
    // dissolved in over the clip before held on its last frame: the hold starts where that clip's file really ends. A
    // render interpolated ×2 is up to a model frame shorter than its length on the grid, and the fade began that much
    // after its last frame, a still of 3 frames then a step (measured 2026-10-08); this part takes up the difference
    const short = blend >= 80 && !landed && afterVideo && beforeAsset?.duration_ms ? Math.max(0, Math.round(before!.endMs - beforeAsset.duration_ms)) : 0;
    if (short > 0 && before) before.endMs -= short;
    const seam = from === 0 && p.clip.joined === "continue" && seamless(x) && afterVideo;
    return {
      kind: "video", source: await sourceOf(storage, x.asset.file_key), ext: extOf(x.asset.mime),
      startMs: visible(x).start + from - (blend >= 80 && landed ? blend : 0) - short - (blend >= 80 && dissolve ? 1000 / fps : 0), endMs: visible(x).start + to, hasSound: Boolean(x.asset.has_sound), ...heard,
      // the sound hands over at the frame the model's own begins, not where the picture took over early (see ExportPart)
      ...(blend >= 80 ? { blendMs: blend, blendMode: landed ? ("overlap" as const) : dissolve ? ("freeze" as const) : ("hold" as const) } : {}),
      // the colour match reads what is seen: its first frames, against the last of the clip before (its shared frames are
      // a loose copy whose light differs, and since the dissolve they are not shown: read there, it darkened clips that
      // already came out darker, −2 to −7 steps where they wanted +1 to +4, measured 2026-10-08)
      ...(from === 0 ? { matchAtMs: visible(x).start } : {}),
      // decoded as one piece with the clip before: a plain cut is the whole chain decoded at once, nothing to fade or match
      ...(seam ? { sameLook: true } : beforeAsset && !sameMaking(beforeAsset, x.asset) ? { noMatch: true } : {}),
    };
  }

  /** The export put in the library (and its storage), named after the timeline (and the range), as the timeline's last export, in the timeline's folder (folderOfTimeline). */
  private async storeExport(t: TimelineRow, file: string, frame: { width: number; height: number }, fps: number, win: { a: number; b: number } | null, web = false) {
    const { db, storage, events } = this.core;
    const assetId = newId();
    const key = `assets/${assetId.slice(0, 2)}/${assetId}.mp4`;
    await storage.putFile(key, file);
    const video = await readVideoFile(file);
    const thumb = video.frame ? await makeThumb(video.frame) : null;
    if (thumb) await storage.put(thumbKey(assetId), thumb);
    const at = now();
    const bytes = await storage.size(key);
    await db
      .insertInto("assets")
      .values(newAssetRow({
        id: assetId, kind: "video", origin: "exported", name: `${win ? `${t.name} · ${clockOf(win.a)}–${clockOf(win.b)}` : t.name}${web ? " · web" : ""}`, file_key: key, thumb_key: thumb ? thumbKey(assetId) : null,
        mime: "video/mp4", bytes, width: video.facts?.width ?? frame.width, height: video.facts?.height ?? frame.height,
        duration_ms: video.facts?.durationMs ?? null, fps: video.facts?.fps ?? fps, has_sound: 1, folder_id: await folderOfTimeline(db, t), generation_id: null,
        kept_at: at, created_at: at,
      }))
      .execute();
    await db.updateTable("timelines").set({ export_asset_id: assetId }).where("id", "=", t.id).execute();
    events.emit("library");
    // the timeline changed too: it now has an export
    events.emit("timeline");
    return assetView(await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirstOrThrow());
  }
}

/**
 * The export's frame: the timeline's own (else the first clip's), or ("largest") the timeline's shape with as many pixels as
 * its largest take (the finished ones; the drafts are enlarged to it).
 */
function exportFrame(t: TimelineRow, all: Placed[], fit: ExportAsk["fit"]): { width: number; height: number } {
  const first = all[0]!.active?.asset ?? all[0]!.still;
  const frame = t.width && t.height ? { width: t.width, height: t.height } : { width: first?.width ?? 576, height: first?.height ?? 1024 };
  if (fit !== "largest") return frame;
  const most = Math.max(0, ...all.map((p) => (p.active?.asset.width ?? 0) * (p.active?.asset.height ?? 0)));
  const k = Math.sqrt(most / (frame.width * frame.height));
  return k > 1.05 ? { width: Math.round((frame.width * k) / 8) * 8, height: Math.round((frame.height * k) / 8) * 8 } : frame;
}
