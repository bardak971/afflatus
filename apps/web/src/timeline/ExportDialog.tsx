import { Download } from "lucide-react";
import { fileUrl, type Asset, type Clip, type Timeline } from "../api";
import { Dialog } from "../Dialog";
import { Button, ErrorNote, Segmented, Toggle } from "../ui";
import { stamp } from "./model";
import type { TimeRange } from "./Track";

/** The export box: open, what was asked, and the export that was there before (to tell the new one). */
export type ExportAsk = { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range: boolean; blend: boolean; match: boolean; fit: "timeline" | "largest"; before: string | null; asked: boolean };

/** What an export is asked with. */
export type ExportOptions = { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend: boolean; match: boolean; fit: "timeline" | "largest" };

/** Export video: its options, then where it stands (queued, exporting, done with its file to download). */
export function ExportDialog({ timeline: t, clips, ask: exp, onChange: setExp, range, emptyRange, finishedSize, misfits, exporting, onExport, onOpen, onClose }: {
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
  onExport(opts: ExportOptions): void;
  /** The exported video, in the viewer. */
  onOpen(asset: Asset): void;
  onClose(): void;
}) {
  const exportDone = exp?.asked && !t.exporting && t.exported && t.exported.id !== exp.before ? t.exported : null;
  const exportSize = (scale: number) => (t.width && t.height ? `${Math.round((t.width * scale) / 2) * 2} × ${Math.round((t.height * scale) / 2) * 2}` : "");
  const playable = clips.filter((c) => c.lengthMs > 0).length;
  return (
    <Dialog label="Export video" onClose={onClose}>
        <span className="text-base font-semibold">Export video</span>
        <span className="text-ink-2">{exp.range && range ? `${stamp(range.inMs)} → ${stamp(range.outMs)} · ${((range.outMs - range.inMs) / 1000).toFixed(1)} s of ${stamp(t.durationMs)}` : `${stamp(t.durationMs)} · ${playable < clips.length ? `${playable} of ${clips.length} clips` : `${playable} clip${playable > 1 ? "s" : ""}`}`} · one MP4 in your library</span>
        {exportDone ? (
          <>
            <span>Done. <span className="font-semibold text-ink">{exportDone.name}</span> is in your library{exportDone.width ? `, ${exportDone.width} × ${exportDone.height}` : ""}{exportDone.durationMs ? `, ${stamp(exportDone.durationMs)}` : ""}.</span>
            <div className="flex flex-wrap gap-2">
              <a href={fileUrl(exportDone.id)} download={`${(exportDone.name || t.name).replace(/[:<>"/\|?*]/g, ".")}.mp4`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 font-semibold text-accent-ink"><Download size={15} /> Download</a>
              <Button onClick={() => { onOpen(exportDone); onClose(); }}>Open</Button>
              <Button tone="quiet" onClick={onClose}>Close</Button>
            </div>
          </>
        ) : t.exporting || exporting ? (
          <>
            <span>{t.exporting?.status === "queued" ? "Queued, after the renders that were asked for before it." : "Exporting."} It runs in the queue, you can keep working.</span>
            <div><Button tone="quiet" onClick={onClose}>Close</Button></div>
          </>
        ) : (
          <>
            {exp.asked && t.exportFailed && <ErrorNote>The export failed: {t.exportFailed}</ErrorNote>}
            <div className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-xs font-semibold"><span>Resolution</span><span className="font-normal text-ink-2">{exportSize(exp.scale)}</span></span>
              <Segmented<"1" | "1.5" | "2"> label="Resolution" value={String(exp.scale) as "1" | "1.5" | "2"} onChange={(v) => setExp({ ...exp, scale: Number(v) as 1 | 1.5 | 2 })} options={[{ value: "1", label: "As rendered" }, { value: "1.5", label: "1.5× upscale" }, { value: "2", label: "2× upscale" }]} />
              <span className="text-xs text-ink-2">Upscaling is done by ffmpeg (lanczos, then a light unsharp), not by a model: every frame is resized and a little sharper. The clips are not rendered again, so it works on a small card.</span>
            </div>
            {range && !emptyRange && <Toggle on={exp.range} onChange={(only) => setExp({ ...exp, range: only })} label="Only the range" note={`In ${stamp(range.inMs)} to Out ${stamp(range.outMs)}`} />}
            {t.music && (exp.range && range ? <span className="text-xs text-ink-2">The music is left out of a range: it would start from its beginning, not from In.</span> : <Toggle on={exp.music} onChange={(music) => setExp({ ...exp, music })} label="Include the music" />)}
            {Math.max(0, ...clips.map((c) => c.take?.asset.fps ?? 0)) < 47 && (
              <div className="flex flex-col gap-1">
                <Toggle on={exp.smooth} onChange={(smooth) => setExp({ ...exp, smooth })} label="Frame interpolation" note="48 fps, ffmpeg minterpolate" />
                <span className="text-xs text-ink-2">The frames in between are worked out by your processor, not by a model: slow (minutes for a short video), and fast motion can smear. Frame interpolation at render time (RIFE, in the clip's form) is better.</span>
              </div>
            )}
            {clips.some((c, i) => i > 0 && c.joined === "continue" && c.take && c.take.headMs > c.take.trimStartMs) && (
              <Toggle on={exp.blend} onChange={(blend) => setExp({ ...exp, blend })} label="Blend joins" note="a clip that extends the one before is crossfaded in over the frames they share (up to 0.4 s), with its sound" />
            )}
            {playable > 1 && <Toggle on={exp.match} onChange={(match) => setExp({ ...exp, match })} label="Match colours at joins" note="each clip's brightness and tint nudged to the clip before, a few steps at most" />}
            {finishedSize && <Toggle on={exp.fit === "largest"} onChange={(on) => setExp({ ...exp, fit: on ? "largest" : "timeline" })} label={`At the finished size (${finishedSize})`} note="the frame of the largest take: the finished clips as they are, the drafts enlarged to it. Off: the timeline's frame" />}
            {misfits > 0 && <span className="text-xs text-ink-2">{misfits} clip{misfits > 1 ? "s have" : " has"} another aspect ratio and will be letterboxed (shown with bars).</span>}
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" onClick={() => { setExp({ ...exp, asked: true, before: t.exported?.id ?? null }); onExport({ scale: exp.scale, music: exp.music, smooth: exp.smooth, range: exp.range && range ? { inMs: range.inMs, outMs: range.outMs } : undefined, blend: exp.blend, match: exp.match, fit: exp.fit }); }}>Export</Button>
              <Button tone="quiet" onClick={onClose}>Close</Button>
            </div>
          </>
        )}
    </Dialog>
  );
}
