import type { ReactNode } from "react";
import { Download, Film } from "lucide-react";
import { fileUrl, projectUrl, type Asset, type Clip, type Timeline } from "../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields";
import { Keys } from "../Keys";
import { Button, ButtonLink, Chip, ErrorNote, Segmented, Toggle } from "../ui";
import { stamp, type TimeRange } from "./model";
import { plural } from "../format";

/** The export box: open, what was asked, and the export that was there before (to tell the new one). `for`: one video, or the clips and a project file for a video editor. */
export type ExportAsk = { for: "video" | "editor"; scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range: boolean; blend: boolean; match: boolean; fit: "timeline" | "largest"; web: 0 | 10 | 25; before: string | null; asked: boolean };

/** What an export is asked with. */
export type ExportOptions = { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend: boolean; match: boolean; fit: "timeline" | "largest"; webMb?: 10 | 25 };

/**
 * Export video: its options, then where it stands (queued, exporting, done with its file to download). For a video editor:
 * the range and the music only, and a zip downloaded at once (nothing goes through the queue, nothing is rendered again).
 */
export function ExportDialog({ timeline: t, clips, ask: exp, onChange: setExp, range, emptyRange, finishedSize, misfits, exporting, attention, onExport, onOpen, onClose }: {
  timeline: Timeline;
  clips: Clip[];
  ask: ExportAsk;
  onChange(ask: ExportAsk): void;
  range: TimeRange | null;
  emptyRange: boolean;
  /** The finished size, when a take is larger than the frame; null when none is. */
  finishedSize: string | null;
  /** How many clips have another aspect ratio and are letterboxed. */
  misfits: number;
  /** The export being asked for, before the timeline says it is exporting. */
  exporting: boolean;
  /** What Needs attention lists, in one line with "Fix all first" (AttentionNote); shown while the export is still to ask. */
  attention?: ReactNode;
  onExport(opts: ExportOptions): void;
  /** The exported video, in the viewer. */
  onOpen(asset: Asset): void;
  onClose(): void;
}) {
  const editor = exp.for === "editor";
  const exportDone = !editor && exp?.asked && !t.exporting && t.exported && t.exported.id !== exp.before ? t.exported : null;
  const exportSize = (scale: number) => (t.width && t.height ? `${Math.round((t.width * scale) / 2) * 2} × ${Math.round((t.height * scale) / 2) * 2}` : "");
  const playable = clips.filter((c) => c.lengthMs > 0).length;
  const busy = !editor && Boolean(t.exporting || exporting);
  // the size it comes out at: the timeline's frame by the scale (not said at the finished size)
  const size = exp.web ? webSize(t, exp.web) : exp.fit === "largest" && finishedSize ? "" : exportSize(exp.scale);
  return (
    <Dialog label="Export video" onClose={onClose} className={DIALOG}>
        <DialogHead icon={<Film size={16} />} title="Export video" sub={`${t.name} · ${editor ? "its clips and a project file, as a zip" : "one MP4 in your library"}`} onClose={onClose} />
        <div className="flex flex-wrap gap-1.5">
          <Chip>{exp.range && range ? `${stamp(range.inMs)} → ${stamp(range.outMs)} · ${((range.outMs - range.inMs) / 1000).toFixed(1)} s of ${stamp(t.durationMs)}` : `${stamp(t.durationMs)} · ${playable < clips.length ? `${playable} of ${clips.length} clips` : `${plural(playable, "clip")}`}`}</Chip>
          {misfits > 0 && !editor && !exportDone && !busy && <Chip tone="warn" tip={`${misfits} clip${misfits > 1 ? "s have" : " has"} another aspect ratio and will be letterboxed (shown with bars).`}>{plural(misfits, "clip")} letterboxed</Chip>}
        </div>
        {exportDone ? (
          <>
            <span>Done. <span className="font-semibold text-ink">{exportDone.name}</span> is in your library{exportDone.width ? `, ${exportDone.width} × ${exportDone.height}` : ""}{exportDone.durationMs ? `, ${stamp(exportDone.durationMs)}` : ""}.</span>
            <DialogFoot>
              <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
              <Button onClick={() => { onOpen(exportDone); onClose(); }}>Open</Button>
              <ButtonLink tone="primary" href={fileUrl(exportDone.id)} download={`${(exportDone.name || t.name).replace(/[:<>"/\|?*]/g, ".")}.mp4`}><Download size={15} /> Download</ButtonLink>
            </DialogFoot>
          </>
        ) : busy ? (
          <>
            <span>{t.exporting?.status === "queued" ? "Queued, after the renders that were asked for before it." : "Exporting."} It runs in the queue, you can keep working.</span>
            <DialogFoot>
              <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
            </DialogFoot>
          </>
        ) : (
          <>
            {!editor && exp.asked && t.exportFailed && <ErrorNote>The export failed: {t.exportFailed}</ErrorNote>}
            {attention}
            <div className="flex flex-col">
              <FieldRow label="For" trail note="A video editor: DaVinci Resolve, Premiere Pro or Kdenlive. A zip of every clip's whole file (the frames around each cut kept), its sound, the music as heard in Afflatus, and the project files the editor rebuilds the timeline from. Nothing is rendered again; colour matching, interpolation and upscaling stay with the video export.">
                <Segmented<"video" | "editor"> label="Export for" value={exp.for} onChange={(v) => setExp({ ...exp, for: v })} options={[{ value: "video", label: "Video file" }, { value: "editor", label: "A video editor" }]} oneLine className="w-fit" />
              </FieldRow>
              {!editor && <FieldRow label="For the web" trail note="A copy small enough to play inline where it is shared: the long edge brought down to 1280, 30 frames a second, and the bitrate worked out from the length so the file stays under the size. 10 MB: what GitHub plays inline on a free account. 25 MB: chats and most posts. The full-quality export is left as it is.">
                <Segmented<"0" | "10" | "25"> label="For the web" value={String(exp.web) as "0" | "10" | "25"} onChange={(v) => setExp({ ...exp, web: Number(v) as 0 | 10 | 25 })} options={[{ value: "0", label: "Off" }, { value: "10", label: "≤ 10 MB" }, { value: "25", label: "≤ 25 MB" }]} oneLine className="w-fit" />
              </FieldRow>}
              {!editor && !exp.web && <FieldRow label="Resolution" trail note="Upscaling is done by ffmpeg (lanczos, then a light unsharp), not by a model: every frame is resized and a little sharper. The clips are not rendered again, so it works on a small card.">
                <Segmented<"1" | "1.5" | "2"> label="Resolution" value={String(exp.scale) as "1" | "1.5" | "2"} onChange={(v) => setExp({ ...exp, scale: Number(v) as 1 | 1.5 | 2 })} options={[{ value: "1", label: "As rendered" }, { value: "1.5", label: "1.5×", tip: "1.5× upscale" }, { value: "2", label: "2×", tip: "2× upscale" }]} oneLine className="w-fit" />
              </FieldRow>}
              {range && !emptyRange && (
                <FieldRow label="Only the range" note={`In ${stamp(range.inMs)} to Out ${stamp(range.outMs)}`} trail>
                  <Toggle bare on={exp.range} onChange={(only) => setExp({ ...exp, range: only })} label="Only the range" />
                </FieldRow>
              )}
              {t.music && (
                exp.range && range ? (
                  <FieldRow label="Music" note="The music is left out of a range: it would start from its beginning, not from In.">
                    <span className="text-xs text-ink-2">Left out of a range</span>
                  </FieldRow>
                ) : (
                  <FieldRow label="Music" trail>
                    <Toggle bare on={exp.music} onChange={(music) => setExp({ ...exp, music })} label="Include the music" />
                  </FieldRow>
                )
              )}
              {!editor && !exp.web && Math.max(0, ...clips.map((c) => c.take?.asset.fps ?? 0)) < 47 && (
                <FieldRow label="Interpolation" note="Frame interpolation to 48 fps, by ffmpeg minterpolate. The frames in between are worked out by your processor, not by a model: slow (minutes for a short video), and fast motion can smear. Frame interpolation at render time (RIFE, in the clip's form) is better." trail>
                  <Toggle bare on={exp.smooth} onChange={(smooth) => setExp({ ...exp, smooth })} label="Frame interpolation" />
                </FieldRow>
              )}
              {!editor && clips.some((c, i) => i > 0 && c.joined === "continue" && c.take && c.take.headMs > c.take.trimStartMs) && (
                <FieldRow label="Blend joins" note="A clip that extends the one before is crossfaded in over the frames they share (up to 0.4 s), with its sound." trail>
                  <Toggle bare on={exp.blend} onChange={(blend) => setExp({ ...exp, blend })} label="Blend joins" />
                </FieldRow>
              )}
              {!editor && playable > 1 && (
                <FieldRow label="Match colours" note="At joins: each clip's brightness and tint nudged to the clip before, a few steps at most." trail>
                  <Toggle bare on={exp.match} onChange={(match) => setExp({ ...exp, match })} label="Match colours at joins" />
                </FieldRow>
              )}
              {finishedSize && !editor && !exp.web && (
                <FieldRow label="Finished size" note="The frame of the largest take: the finished clips as they are, the drafts enlarged to it. Off: the timeline's frame." trail>
                  <span className="flex items-center gap-2.5">
                    <span className="text-xs text-ink-2">{finishedSize}</span>
                    <Toggle bare on={exp.fit === "largest"} onChange={(on) => setExp({ ...exp, fit: on ? "largest" : "timeline" })} label={`At the finished size (${finishedSize})`} />
                  </span>
                </FieldRow>
              )}
            </div>
            {editor ? (
              <DialogFoot info={`${t.width && t.height ? `${t.width} × ${t.height} · ` : ""}a zip`}>
                <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
                <ButtonLink tone="primary" autoFocus href={projectUrl(t.id, { music: exp.music && !(exp.range && range), range: exp.range && range ? { inMs: range.inMs, outMs: range.outMs } : undefined })} download><Download size={15} /> Download for an editor</ButtonLink>
              </DialogFoot>
            ) : (
            <DialogFoot info={size || undefined}>
              <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
              <Button tone="primary" autoFocus onClick={() => { setExp({ ...exp, asked: true, before: t.exported?.id ?? null }); onExport({ scale: exp.scale, music: exp.music, smooth: exp.smooth, range: exp.range && range ? { inMs: range.inMs, outMs: range.outMs } : undefined, blend: exp.blend, match: exp.match, fit: exp.fit, ...(exp.web ? { webMb: exp.web } : {}) }); }}>{exp.web ? "Export a web copy" : "Export"}</Button>
            </DialogFoot>
            )}
          </>
        )}
    </Dialog>
  );
}

/** What a web copy comes out at: the frame brought down to 1280 on its long side, the size it stays under. */
function webSize(t: Timeline, mb: number): string {
  if (!t.width || !t.height) return `under ${mb} MB`;
  const k = Math.min(1, 1280 / Math.max(t.width, t.height));
  const even = (n: number) => Math.round((n * k) / 2) * 2;
  return `${even(t.width)} × ${even(t.height)} · 30 fps · under ${mb} MB`;
}
