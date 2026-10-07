import { BLEND_MS, CutError, DISSOLVE_MS, MATCH, type ExportMusic, type ExportPart, joinVideos } from "./cut";
import { newId, now } from "./db";
import { assetView, extOf, newAssetRow } from "./media";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideo } from "./video";
import { clockOf, laidOut, leadOf, sameMaking, seamless, visible, type AssetRow, type TimelineCore } from "./timelineModel";

/** A timeline as one video: its clips that play joined in order, with their sounds, its music and the joins softened. */

export class TimelineExport {
  constructor(private readonly core: TimelineCore) {}

  /**
   * The timeline as one video in the library: what plays, start to end, with its sounds and its music.
   * With a range: only that part, as a copy in the library (the music is left out).
   */
  async export(id: string, opts: { scale?: number; music?: boolean; smooth?: boolean; range?: { inMs: number; outMs: number }; blend?: boolean; match?: boolean; fit?: "timeline" | "largest"; signal?: AbortSignal } = {}) {
    const { db, storage, events } = this.core;
    const t = await this.core.row(id);
    const laid = laidOut(await this.core.placed(id));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    const win = opts.range ? { a: Math.max(0, Math.min(opts.range.inMs, opts.range.outMs)), b: Math.min(total, Math.max(opts.range.inMs, opts.range.outMs)) } : null;
    if (win && win.b - win.a < 40) throw new CutError("Set In and Out apart: there is nothing between them.");
    const shown = win ? laid.filter((l) => l.atMs < win.b && l.atMs + l.lengthMs > win.a) : laid;
    const all = shown.map((l) => l.p);
    if (!all.length) throw new CutError("There is nothing to export yet: no clip of this timeline has a take.");
    const first = all[0]!.active?.asset ?? all[0]!.still;
    let frame = t.width && t.height ? { width: t.width, height: t.height } : { width: first?.width ?? 576, height: first?.height ?? 1024 };
    // at the finished size: the timeline's shape, with as many pixels as its largest take (the drafts are enlarged to it)
    if (opts.fit === "largest") {
      const most = Math.max(0, ...all.map((p) => (p.active?.asset.width ?? 0) * (p.active?.asset.height ?? 0)));
      const k = Math.sqrt(most / (frame.width * frame.height));
      if (k > 1.05) frame = { width: Math.round((frame.width * k) / 8) * 8, height: Math.round((frame.height * k) / 8) * 8 };
    }
    const fps = Math.round(Math.max(...all.map((p) => p.active?.asset.fps ?? 24), 1));
    const parts: ExportPart[] = [];
    /** The video of the part before (none after a still). */
    let prevAsset: AssetRow | null = null;
    for (const [i, l] of shown.entries()) {
      const p = l.p;
      const mine = p.clip.kind === "video" ? p.active?.asset ?? null : null;
      const beforeAsset = prevAsset;
      prevAsset = mine;
      const soundFile = p.clip.sound === "file" && p.sound ? { bytes: await storage.get(p.sound.file_key), ext: extOf(p.sound.mime) } : undefined;
      const heard = { sound: p.clip.sound, soundFile, volume: p.clip.volume / 100, fill: Boolean(p.clip.fill) };
      // within the window: the part of the clip that falls in it
      const from = win ? Math.max(0, win.a - l.atMs) : 0;
      const to = win ? Math.min(l.lengthMs, win.b - l.atMs) : l.lengthMs;
      if (p.clip.kind === "still") {
        parts.push({ kind: "still", bytes: await storage.get(p.still!.file_key), ext: extOf(p.still!.mime), startMs: from, endMs: to, hasSound: false, ...heard });
      } else {
        const x = p.active!;
        // a clip rendered as the continuation of the one before (it replayed the frames they share) starts its
        // own part exactly where that one stops: the model restarts beside the pinned frames, and the first
        // generated frames may step away from them. The export softens that step: the part before holds its
        // last frame for a few frames while this one fades in over its first generated frames
        const before = parts[i - 1];
        const shared = x.take.head_ms - x.take.trim_start_ms;
        // a join made in the latent continues the clip before's own tokens: its shared frames and the clip
        // before's last frames show the same moments, so the fade runs over them with both sides moving. A
        // pixel join restarts beside pinned frames: the clip before holds its last frame while this one fades in
        const latent = x.take.join_kind === "latent" || x.take.join_kind === "hybrid";
        // decoded as one piece with the clip before: a plain cut is the whole chain decoded at once, nothing to fade or match
        const seam = from === 0 && p.clip.joined === "continue" && seamless(x) && before?.kind === "video";
        // at a take-over point inside the shared frames both sides show the same moments, yet each clip re-rendered
        // (and enlarged) them on its own: a cut there still steps (about 38 dB between the two, measured 2026-10-07).
        // The fade runs over the same moments, before the take-over point, with both moving: no ghost, no step
        const lead = leadOf(x);
        // landed on by the clip before: the two show the same moments around the take-over point (that clip's guided tail), faded over them
        const landed = x.landed !== undefined;
        // a continuation made in the latent: the clip before plays to its end, held there while this one dissolves in (DISSOLVE_MS)
        const dissolve = latent && !landed;
        const blend = !seam && opts.blend !== false && before && before.kind === "video" && from === 0 && (landed || shared - lead >= 80)
          ? Math.min(dissolve ? DISSOLVE_MS : BLEND_MS, to - 40, ...(landed ? [x.landed!, before.endMs - before.startMs - 40] : []))
          : 0;
        // dissolved in over the clip before held on its last frame: the hold starts where that clip's file really ends. A
        // render interpolated ×2 is up to a model frame shorter than its length on the grid, and the fade began that much
        // after its last frame, a still of 3 frames then a step (measured 2026-10-08); this part takes up the difference
        const short = blend >= 80 && !landed && before?.kind === "video" && beforeAsset?.duration_ms ? Math.max(0, Math.round(before.endMs - beforeAsset.duration_ms)) : 0;
        if (short > 0 && before) before.endMs -= short;
        parts.push({
          kind: "video", bytes: await storage.get(x.asset.file_key), ext: extOf(x.asset.mime),
          startMs: visible(x).start + from - (blend >= 80 && landed ? blend : 0) - short - (blend >= 80 && dissolve ? 1000 / fps : 0), endMs: visible(x).start + to, hasSound: Boolean(x.asset.has_sound), ...heard,
          // the sound hands over at the frame the model's own begins, not where the picture took over early (see ExportPart)
          ...(blend >= 80 ? { blendMs: blend, blendMode: landed ? ("overlap" as const) : dissolve ? ("freeze" as const) : ("hold" as const) } : {}),
          // a continuation compares its shared frames with the same moments of the clip before, not the moments after them
          // the colour match reads what is seen: its first frames, against the last of the clip before (its shared frames are
          // a loose copy whose light differs, and since the dissolve they are not shown: read there, it darkened clips that
          // already came out darker, −2 to −7 steps where they wanted +1 to +4, measured 2026-10-08)
          ...(from === 0 ? { matchAtMs: visible(x).start } : {}),
          ...(seam ? { sameLook: true } : beforeAsset && !sameMaking(beforeAsset, x.asset) ? { noMatch: true } : {}),
        });
      }
    }
    const track = opts.music === false || win ? undefined : await this.core.assetRow(t.music_asset_id);
    const music: ExportMusic | undefined = track
      ? {
          bytes: await storage.get(track.file_key), ext: extOf(track.mime), durationMs: track.duration_ms ?? 0,
          volume: t.music_volume / 100, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck),
        }
      : undefined;
    const bytes = await joinVideos(parts, frame, fps, { scale: opts.scale ?? 1, music, smoothTo: opts.smooth ? 48 : undefined, match: opts.match !== false, signal: opts.signal });
    const assetId = newId();
    const key = `assets/${assetId.slice(0, 2)}/${assetId}.mp4`;
    await storage.put(key, bytes);
    const video = await readVideo(bytes, "mp4");
    const thumb = video.frame ? await makeThumb(video.frame) : null;
    if (thumb) await storage.put(thumbKey(assetId), thumb);
    const at = now();
    await db
      .insertInto("assets")
      .values(newAssetRow({
        id: assetId, kind: "video", origin: "exported", name: win ? `${t.name} · ${clockOf(win.a)}–${clockOf(win.b)}` : t.name, file_key: key, thumb_key: thumb ? thumbKey(assetId) : null,
        mime: "video/mp4", bytes: bytes.length, width: video.facts?.width ?? frame.width, height: video.facts?.height ?? frame.height,
        duration_ms: video.facts?.durationMs ?? null, fps: video.facts?.fps ?? fps, has_sound: 1, folder_id: t.folder_id, generation_id: null,
        kept_at: at, created_at: at,
      }))
      .execute();
    await db.updateTable("timelines").set({ export_asset_id: assetId }).where("id", "=", id).execute();
    events.emit("library");
    // the timeline changed too: it now has an export
    events.emit("timeline");
    return assetView(await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirstOrThrow());
  }
}
