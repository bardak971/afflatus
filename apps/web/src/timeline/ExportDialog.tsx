import { Download, Film } from "lucide-react";
import { fileUrl, type Asset, type Clip, type Timeline } from "../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields";
import { Keys } from "../Keys";
import { Button, ButtonLink, Chip, ErrorNote, Segmented, Toggle } from "../ui";
import { stamp } from "./model";
import type { TimeRange } from "./Track";

/** The export box: open, what was asked, and the export that was there before (to tell the new one). */
export type ExportAsk = { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range: boolean; blend: boolean; match: boolean; fit: "timeline" | "largest"; web: 0 | 10 | 25; before: string | null; asked: boolean };

/** What an export is asked with. */
export type ExportOptions = { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend: boolean; match: boolean; fit: "timeline" | "largest"; webMb?: 10 | 25 };

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
  const busy = Boolean(t.exporting || exporting);
  // the size it comes out at: the timeline's frame by the scale (not said at the finished size)
  const size = exp.web ? webSize(t, exp.web) : exp.fit === "largest" && finishedSize ? "" : exportSize(exp.scale);
  return (
    <Dialog label="Export video" onClose={onClose} className={DIALOG}>
        <DialogHead icon={<Film size={16} />} title="Export video" sub={`${t.name} · one MP4 in your library`} onClose={onClose} />
        <div className="flex flex-wrap gap-1.5">
          <Chip>{exp.range && range ? `${stamp(range.inMs)} → ${stamp(range.outMs)} · ${((range.outMs - range.inMs) / 1000).toFixed(1)} s of ${stamp(t.durationMs)}` : `${stamp(t.durationMs)} · ${playable < clips.length ? `${playable} of ${clips.length} clips` : `${playable} clip${playable > 1 ? "s" : ""}`}`}</Chip>
          {misfits > 0 && !exportDone && !busy && <Chip tone="warn" tip={`${misfits} clip${misfits > 1 ? "s have" : " has"} another aspect ratio and will be letterboxed (shown with bars).`}>{misfits} clip{misfits > 1 ? "s" : ""} letterboxed</Chip>}
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
            {exp.asked && t.exportFailed && <ErrorNote>The export failed: {t.exportFailed}</ErrorNote>}
            <div className="flex flex-col">
              <FieldRow label="For the web" note="A copy small enough to play inline where it is shared: the long edge brought down to 1280, 30 frames a second, and the bitrate worked out from the length so the file stays under the size. 10 MB: what GitHub plays inline on a free account. 25 MB: chats and most posts. The full-quality export is left as it is.">
                <Segmented<"0" | "10" | "25"> label="For the web" value={String(exp.web) as "0" | "10" | "25"} onChange={(v) => setExp({ ...exp, web: Number(v) as 0 | 10 | 25 })} options={[{ value: "0", label: "Off" }, { value: "10", label: "≤ 10 MB" }, { value: "25", label: "≤ 25 MB" }]} oneLine className="w-fit" />
              </FieldRow>
              {!exp.web && <FieldRow label="Resolution" note="Upscaling is done by ffmpeg (lanczos, then a light unsharp), not by a model: every frame is resized and a little sharper. The clips are not rendered again, so it works on a small card.">
                <Segmented<"1" | "1.5" | "2"> label="Resolution" value={String(exp.scale) as "1" | "1.5" | "2"} onChange={(v) => setExp({ ...exp, scale: Number(v) as 1 | 1.5 | 2 })} options={[{ value: "1", label: "As rendered" }, { value: "1.5", label: "1.5×", tip: "1.5× upscale" }, { value: "2", label: "2×", tip: "2× upscale" }]} oneLine className="w-fit" />
              </FieldRow>}
              {range && !emptyRange && (
                <FieldRow label="Only the range" note={`In ${stamp(range.inMs)} to Out ${stamp(range.outMs)}`}>
                  <Toggle bare on={exp.range} onChange={(only) => setExp({ ...exp, range: only })} label="Only the range" />
                </FieldRow>
              )}
              {t.music && (
                exp.range && range ? (
                  <FieldRow label="Music" note="The music is left out of a range: it would start from its beginning, not from In.">
                    <span className="text-xs text-ink-2">Left out of a range</span>
                  </FieldRow>
                ) : (
                  <FieldRow label="Music">
                    <Toggle bare on={exp.music} onChange={(music) => setExp({ ...exp, music })} label="Include the music" />
                  </FieldRow>
                )
              )}
              {!exp.web && Math.max(0, ...clips.map((c) => c.take?.asset.fps ?? 0)) < 47 && (
                <FieldRow label="Interpolation" note="Frame interpolation to 48 fps, by ffmpeg minterpolate. The frames in between are worked out by your processor, not by a model: slow (minutes for a short video), and fast motion can smear. Frame interpolation at render time (RIFE, in the clip's form) is better.">
                  <Toggle bare on={exp.smooth} onChange={(smooth) => setExp({ ...exp, smooth })} label="Frame interpolation" />
                </FieldRow>
              )}
              {clips.some((c, i) => i > 0 && c.joined === "continue" && c.take && c.take.headMs > c.take.trimStartMs) && (
                <FieldRow label="Blend joins" note="A clip that extends the one before is crossfaded in over the frames they share (up to 0.4 s), with its sound.">
                  <Toggle bare on={exp.blend} onChange={(blend) => setExp({ ...exp, blend })} label="Blend joins" />
                </FieldRow>
              )}
              {playable > 1 && (
                <FieldRow label="Match colours" note="At joins: each clip's brightness and tint nudged to the clip before, a few steps at most.">
                  <Toggle bare on={exp.match} onChange={(match) => setExp({ ...exp, match })} label="Match colours at joins" />
                </FieldRow>
              )}
              {finishedSize && !exp.web && (
                <FieldRow label="Finished size" note="The frame of the largest take: the finished clips as they are, the drafts enlarged to it. Off: the timeline's frame.">
                  <span className="flex items-center gap-2.5">
                    <Toggle bare on={exp.fit === "largest"} onChange={(on) => setExp({ ...exp, fit: on ? "largest" : "timeline" })} label={`At the finished size (${finishedSize})`} />
                    <span className="text-xs text-ink-2">{finishedSize}</span>
                  </span>
                </FieldRow>
              )}
            </div>
            <DialogFoot info={size || undefined}>
              <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
              <Button tone="primary" autoFocus onClick={() => { setExp({ ...exp, asked: true, before: t.exported?.id ?? null }); onExport({ scale: exp.scale, music: exp.music, smooth: exp.smooth, range: exp.range && range ? { inMs: range.inMs, outMs: range.outMs } : undefined, blend: exp.blend, match: exp.match, fit: exp.fit, ...(exp.web ? { webMb: exp.web } : {}) }); }}>{exp.web ? "Export a web copy" : "Export"}</Button>
            </DialogFoot>
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
