import { fromRender } from "./aiMark";
import { CutError } from "./cut";
import { type FrameMeans } from "./measure";
import { BLEND_MS, DISSOLVE_MS, type ExportMusic, type ExportPart, joinVideosInto } from "./exportJoin";
import { newId, now } from "./db";
import type { LibraryChange } from "./events";
import { FRAME_SLACK_MS, laysSound, MIN_FADE_MS, sungHead, musicPlan, soundHandover, TRANSITIONS, transitionSpan } from "@afflatus/core";
import { duckCurve } from "./duck";
import { assetView, extOf, newAssetRow } from "./media";
import { sourceOf } from "./storage";
import { folderOfTimeline } from "./timelineFolder";
import { fewAtATime } from "./timelineMedia";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideoFile } from "./video";
import { clockOf, joinFade, laidOut, sameMaking, seamless, visible, type AssetRow, type Laid, type Placed, type Taken, type TimelineCore, type TimelineRow, musicBaseOf, musicClipsOf, transitionOfRow } from "./timelineModel";

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
  constructor(
    private readonly core: TimelineCore,
    /** A video's frame means, kept beside it (TimelineMedia.means): the colour match reads them rather than measure each join. */
    private readonly means: (asset: AssetRow) => Promise<FrameMeans | null> = async () => null,
  ) {}

  /**
   * The timeline as one video in the library: what plays, start to end, with its sounds and its music.
   * With a range: only that part, as a copy in the library (the music is left out).
   */
  async export(id: string, opts: ExportAsk = {}) {
    const { t, shown, win, frame, fps, music } = await this.layout(id, opts);
    const parts: ExportPart[] = [];
    for (const [i, l] of shown.entries()) parts.push(await this.partFor(l, partWindow(l, win), parts.at(-1), shown[i - 1]?.p, opts.blend !== false, fps));
    // the colour match reads every video's kept frame means, a few at a time (worked out and kept where missing, as the
    // player's matching does): 20 clips measured join by join were 39 ffmpeg runs before the encode
    if (opts.match !== false) {
      const videos = [...new Map(shown.flatMap((l) => (l.p.clip.kind === "video" && l.p.active ? [[l.p.active.asset.id, l.p.active.asset] as const] : []))).values()];
      const along = new Map(await fewAtATime(videos, 3, async (a) => [a.id, await this.means(a)] as const));
      for (const [i, part] of parts.entries()) {
        const asset = shown[i]!.p.active?.asset;
        if (part.kind === "video" && asset) part.means = along.get(asset.id) ?? null;
      }
    }
    const joinOpts = { scale: opts.scale ?? 1, music, smoothTo: opts.smooth ? 48 : undefined, match: opts.match !== false, webMb: opts.webMb, fromRender: await this.holdsRender(shown), signal: opts.signal };
    // stored from where ffmpeg wrote it: the export is never held whole in memory
    return joinVideosInto(parts, frame, fps, joinOpts, (file) => this.storeExport(t, file, frame, fps, win, Boolean(opts.webMb)));
  }

  /**
   * Whether a take's head sounds of the model's guess (core soundHandover's `guessedHead`): its sound a recording laid after
   * its head (Lip sync), rendered without the lead-in its render's form would say (sungHead).
   */
  private async guessedHead(x: Taken, recipeId: string | null): Promise<boolean> {
    const made = x.asset.generation_id ? await this.core.db.selectFrom("generations").select(["recipe_id", "inputs"]).where("id", "=", x.asset.generation_id).executeTakeFirst() : undefined;
    const inputs = this.core.registry.recipe(made?.recipe_id ?? recipeId ?? "")?.inputs ?? [];
    return laysSound(inputs) && !sungHead(inputs, made ? (JSON.parse(made.inputs) as Record<string, unknown>) : {});
  }

  /**
   * What an export starts from, the video's and an editor's alike: the timeline, its clips that play (those in the range,
   * with a range), the frame and the speed it is made at, and the music as the player plays it (none with a range).
   */
  async layout(id: string, opts: Pick<ExportAsk, "music" | "range" | "fit"> = {}) {
    const t = await this.core.row(id);
    const laid = laidOut(await this.core.placed(id));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    const win = opts.range ? { a: Math.max(0, Math.min(opts.range.inMs, opts.range.outMs)), b: Math.min(total, Math.max(opts.range.inMs, opts.range.outMs)) } : null;
    if (win && win.b - win.a < FRAME_SLACK_MS) throw new CutError("Set In and Out apart: there is nothing between them.");
    const shown = win ? laid.filter((l) => l.atMs < win.b && l.atMs + l.lengthMs > win.a) : laid;
    const all = shown.map((l) => l.p);
    if (!all.length) throw new CutError("There is nothing to export yet: no clip of this timeline has a take.");
    const frame = exportFrame(t, all, opts.fit);
    const fps = Math.round(Math.max(...all.map((p) => p.active?.asset.fps ?? 24), 1));
    const track = opts.music === false || win ? undefined : await this.core.assetRow(t.music_asset_id);
    // the plan the player follows too: the part of the song, from which clip, each clip's level under it
    const plan = track ? musicPlan(musicBaseOf(t, track), musicClipsOf(laid)) : null;
    const music: ExportMusic | undefined = track && plan && plan.endMs > plan.startMs
      ? {
          source: await sourceOf(this.core.storage, track.file_key), ext: extOf(track.mime), plan,
          duck: plan.spans.some((s) => s.duckDb > 0) ? await duckCurve(laid, (asset, row) => this.core.motion(asset, row), plan) : null,
        }
      : undefined;
    return { t, shown, win, frame, fps, music, totalMs: win ? win.b - win.a : total };
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
    // a cut's transition, centred on the cut (core transitions.ts): only where this part opens on its clip's start, after a part
    const t = transitionOfRow(p.clip);
    const span = before && from === 0 ? transitionSpan(t, p.clip.joined, before.endMs - before.startMs, to - from) : 0;
    const heard = { sound: p.clip.sound, soundFile, volume: p.clip.volume / 100, fill: Boolean(p.clip.fill), ...(t && span ? { transitionIn: { kind: t.kind, xfade: TRANSITIONS[t.kind].xfade, ms: span, fadeSound: t.sound === "fade" } } : {}) };
    if (p.clip.kind === "still") return { kind: "still", source: await sourceOf(storage, p.still!.file_key), ext: extOf(p.still!.mime), startMs: from, endMs: to, hasSound: false, ...heard };
    const x = p.active!;
    /** The video of the part before (none after a still). */
    const beforeAsset: AssetRow | null = prior?.clip.kind === "video" ? prior.active?.asset ?? null : null;
    const afterVideo = before?.kind === "video";
    // a clip rendered as the continuation of the one before (it replayed the frames they share) starts its own part exactly
    // where that one stops: the model restarts beside the pinned frames, and the first generated frames may step away from
    // them. The fade softens that step, the same as the player's (joinFade): a take landed on (the clip before's guided tail
    // shows the same moments) fades over those moments with both moving, and so does a window whose head is the clip before's own
    // last moments made again (a SCAIL-2 window, its join kind "window"); any other continuation of a video fades in over the
    // clip before held on its last frame; a seamless join (decoded as one piece with the clip before) is a plain cut
    const fade = afterVideo && from === 0 ? joinFade(x, p.clip.joined === "continue") : null;
    const landed = fade?.mode === "overlap";
    // a join made in the latent: the clip before plays to its end, held there while this one dissolves in (DISSOLVE_MS), the
    // sound straight on ("hybrid": takes made before 2026-10-08 joined in the latent too; none are made now)
    const dissolve = !landed && (x.take.join_kind === "latent" || x.take.join_kind === "hybrid");
    const blend = blendJoins && fade && before
      ? Math.min(landed ? fade.ms : dissolve ? DISSOLVE_MS : BLEND_MS, to - FRAME_SLACK_MS, ...(landed ? [x.landed ?? fade.ms, before.endMs - before.startMs - FRAME_SLACK_MS] : []))
      : 0;
    // dissolved in over the clip before held on its last frame: the hold starts where that clip's file really ends. A
    // render interpolated ×2 is up to a model frame shorter than its length on the grid, and the fade began that much
    // after its last frame, a still of 3 frames then a step (measured 2026-10-08); this part takes up the difference
    const short = blend >= MIN_FADE_MS && !landed && afterVideo && beforeAsset?.duration_ms ? Math.max(0, Math.round(before!.endMs - beforeAsset.duration_ms)) : 0;
    if (short > 0 && before) before.endMs -= short;
    const seam = from === 0 && p.clip.joined === "continue" && seamless(x) && afterVideo;
    // the sound hands over before the clip before's last moments, from this take's head (core soundHandover)
    const handover = soundHandover({
      seamless: seam && !heard.transitionIn,
      bothOwnSound: p.clip.sound === "own" && Boolean(x.asset.has_sound) && before?.sound === "own" && Boolean(before.hasSound),
      shownFromMs: visible(x).start,
      beforeMs: before ? before.endMs - before.startMs : 0,
      guessedHead: seam ? await this.guessedHead(x, p.clip.recipe_id) : false,
    });
    return {
      kind: "video", source: await sourceOf(storage, x.asset.file_key), ext: extOf(x.asset.mime), ...(x.asset.fps ? { fps: x.asset.fps } : {}),
      startMs: visible(x).start + from - (blend >= 80 && landed ? blend : 0) - short - (blend >= 80 && dissolve ? 1000 / fps : 0), endMs: visible(x).start + to, hasSound: Boolean(x.asset.has_sound), ...heard,
      // the sound hands over at the frame the model's own begins, not where the picture took over early (see ExportPart)
      ...(blend >= 80 ? { blendMs: blend, blendMode: landed ? ("overlap" as const) : dissolve ? ("freeze" as const) : ("hold" as const) } : {}),
      // the colour match reads what is seen: its first frames, against the last of the clip before (its shared frames are
      // a loose copy whose light differs, and since the dissolve they are not shown: read there, it darkened clips that
      // already came out darker, −2 to −7 steps where they wanted +1 to +4, measured 2026-10-08)
      ...(from === 0 ? { matchAtMs: visible(x).start } : {}),
      // decoded as one piece with the clip before: a plain cut is the whole chain decoded at once, nothing to fade or match
      ...(seam ? { sameLook: true } : beforeAsset && !sameMaking(beforeAsset, x.asset) ? { noMatch: true } : {}),
      ...(handover ? { headSoundMs: handover } : {}),
    };
  }

  /** Whether any clip that plays shows a render (or a frame, cut or edit of one): the export is then marked as made by a model. */
  private async holdsRender(shown: Laid[]): Promise<boolean> {
    for (const l of shown) {
      const seen = l.p.clip.kind === "still" ? l.p.still : l.p.active?.asset;
      if (seen && (await fromRender(this.core.db, seen))) return true;
    }
    return false;
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
    const folder = await folderOfTimeline(db, t);
    await db
      .insertInto("assets")
      .values(newAssetRow({
        id: assetId, kind: "video", origin: "exported", name: `${win ? `${t.name} · ${clockOf(win.a)}–${clockOf(win.b)}` : t.name}${web ? " · web" : ""}`, file_key: key, thumb_key: thumb ? thumbKey(assetId) : null,
        mime: "video/mp4", bytes, width: video.facts?.width ?? frame.width, height: video.facts?.height ?? frame.height,
        duration_ms: video.facts?.durationMs ?? null, fps: video.facts?.fps ?? fps, has_sound: 1, folder_id: folder, generation_id: null,
        kept_at: at, created_at: at,
      }))
      .execute();
    await db.updateTable("timelines").set({ export_asset_id: assetId }).where("id", "=", t.id).execute();
    events.emit("library", { change: "added", items: [assetId], folders: [folder] } satisfies LibraryChange);
    // the timeline changed too: it now has an export
    events.emit("timeline");
    return assetView(await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirstOrThrow());
  }
}

/** The part of a clip that falls in the window, in the clip's own time (all of it without a window). */
export function partWindow(l: Laid, win: { a: number; b: number } | null): { from: number; to: number } {
  return { from: win ? Math.max(0, win.a - l.atMs) : 0, to: win ? Math.min(l.lengthMs, win.b - l.atMs) : l.lengthMs };
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
