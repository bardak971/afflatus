import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Music, Trash2 } from "lucide-react";
import { mostFromMs, musicPlan } from "@afflatus/core";
import { api, type Timeline, type TimelinePatch } from "../../api";
import { clock } from "../../format";
import { Picker } from "../../PictureField";
import { Select } from "../../Select";
import { Button, Help, NumberBox, Segmented, Toggle } from "../../ui";
import { FieldRow } from "../../fields";
import { ColumnEdge, FoldButton, useColumnWidth } from "../column";
import { Wave } from "../track/Wave";
import { CloseButton, Slide } from "./parts";
import { queryKeys } from "../../queryKeys";

/**
 * The whole song, the stretch the video plays lit: dragged (or clicked), it chooses which part plays. On tenths of a
 * second, never past the song's end less the video under it.
 */
function SongStrip({ timeline, onFrom }: { timeline: Timeline; onFrom(fromMs: number): void }) {
  const m = timeline.music!;
  const songMs = m.asset.durationMs ?? 0;
  const strip = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<number | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const measure = useQuery({ queryKey: queryKeys.motion(m.asset.id), queryFn: () => api.motion(m.asset.id), staleTime: Infinity, retry: 0 });
  const clips = timeline.clips.map((c) => ({ id: c.id, atMs: c.atMs, lengthMs: c.lengthMs, music: c.music }));
  const plan = musicPlan({ ...m, durationMs: songMs, fromMs: held ?? m.fromMs }, clips);
  const usedMs = plan.endMs - plan.startMs;
  const mostFrom = mostFromMs({ ...m, durationMs: songMs }, clips);
  const from = held ?? m.fromMs;
  if (!songMs) return null;
  const pct = (ms: number) => `${(Math.max(0, Math.min(1, ms / songMs)) * 100).toFixed(2)}%`;
  const snap = (ms: number) => Math.max(0, Math.min(mostFrom, Math.round(ms / 100) * 100));
  const msPerPx = () => songMs / Math.max(1, strip.current?.clientWidth ?? 1);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={strip}
        role="slider"
        tabIndex={0}
        aria-label="Which part of the song plays"
        aria-valuemin={0}
        aria-valuemax={mostFrom}
        aria-valuenow={from}
        aria-valuetext={`from ${clock(from, { decimals: 1 })}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, from, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || (!d.moved && Math.abs(e.clientX - d.x) < 3)) return;
          d.moved = true;
          setHeld(snap(d.from + (e.clientX - d.x) * msPerPx()));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          // a click: the lit stretch starts there
          const to = d.moved ? held : snap((e.clientX - e.currentTarget.getBoundingClientRect().left) * msPerPx());
          setHeld(null);
          if (to !== null && to !== m.fromMs) onFrom(to);
        }}
        onKeyDown={(e) => {
          const by = e.key === "ArrowRight" ? 100 : e.key === "ArrowLeft" ? -100 : 0;
          if (!by) return;
          e.preventDefault();
          onFrom(snap(m.fromMs + by * (e.shiftKey ? 10 : 1)));
        }}
        className="relative h-[34px] cursor-grab overflow-hidden rounded-lg bg-raised text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
      >
        {measure.data && <Wave sound={measure.data.sound} rate={measure.data.rate} fromMs={0} toMs={songMs} />}
        <span className="pointer-events-none absolute top-0 bottom-0 rounded-md border-[1.5px] border-accent bg-accent/30" style={{ left: pct(from), width: pct(usedMs) }} />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-ink-3">
        <span>0:00</span>
        <span className="text-accent">{clock(from, { decimals: 1 })} → {clock(from + usedMs, { decimals: 1 })}</span>
        <span>{clock(songMs)}</span>
      </div>
    </div>
  );
}

/** The music's own panel: one sound under the whole video. */
export function MusicPanel({ timeline, onEdit, onClose }: { timeline: Timeline; onEdit(patch: TimelinePatch): void; /** Back to the timeline's own panel: also Escape. */ onClose?(): void }) {
  const m = timeline.music;
  const [picking, setPicking] = useState(false);
  const width = useColumnWidth();
  if (!m) return null;
  // the clips it can start with: the ones that play
  const starts = timeline.clips.map((c, i) => ({ id: c.id, n: i + 1, atMs: c.atMs, lengthMs: c.lengthMs })).filter((c) => c.lengthMs > 0);
  const startValue = m.startClip && m.startClip !== starts[0]?.id ? m.startClip : "first";
  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <ColumnEdge />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Music size={15} className="text-accent" />
        <span className="font-semibold">Music</span>
        <Help title="Music" text="Plays under the whole video. Drop another audio file on the music track to replace it." />
        <span className="min-w-0 grow truncate text-ink-2">{m.asset.name || "an audio file"}{m.asset.durationMs ? ` · ${clock(m.asset.durationMs)}` : ""}</span>
        <FoldButton />
        {onClose && <CloseButton onClose={onClose} />}
      </div>
      <div className="@container/column flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
        <SongStrip timeline={timeline} onFrom={(fromMs) => onEdit({ music: { fromMs } })} />
        <FieldRow label="Song from" note="The moment of the song heard where the music starts. Drag the lit stretch, or the song on its lane.">
          <NumberBox label="Song from, in seconds" value={m.fromMs / 1000} min={0} max={mostFromMs({ ...m, durationMs: m.asset.durationMs ?? 0 }, timeline.clips) / 1000} step={0.1} unit="s" onCommit={(s) => onEdit({ music: { fromMs: Math.round(s * 1000) } })} />
        </FieldRow>
        <FieldRow label="Starts" note="The clip the music starts with. Alt + drag the music's left edge on its lane does the same.">
          {starts.length <= 5 ? (
            <Segmented size="sm" label="The clip the music starts with" value={startValue} options={starts.map((c, i) => ({ value: i === 0 ? "first" : c.id, label: i === 0 ? "With clip 1" : `Clip ${c.n}` }))} onChange={(v) => onEdit({ music: { startClip: v === "first" ? null : v } })} />
          ) : (
            <Select size="sm" label="The clip the music starts with" value={startValue} options={starts.map((c, i) => ({ value: i === 0 ? "first" : c.id, label: i === 0 ? "With clip 1" : `Clip ${c.n}`, note: clock(c.atMs, { decimals: 1 }) }))} onChange={(v) => onEdit({ music: { startClip: v === "first" ? null : v } })} />
          )}
        </FieldRow>
        <Slide label="Volume" value={m.volume} max={100} show={(v) => `${v}%`} onCommit={(volume) => onEdit({ music: { volume } })} />
        <Slide label="Fade in" value={m.fadeInMs} max={10_000} step={500} show={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(fadeInMs) => onEdit({ music: { fadeInMs } })} />
        <Slide label="Fade out" value={m.fadeOutMs} max={10_000} step={500} show={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(fadeOutMs) => onEdit({ music: { fadeOutMs } })} />
        <Toggle on={m.duck} onChange={(duck) => onEdit({ music: { duck } })} label="Duck under speech" note="the music dips where people speak in the clips, in the player and the export alike" />
        {m.duck && <Slide label="Duck by" value={m.duckDb} min={3} max={30} step={1} show={(v) => `−${v} dB`} onCommit={(duckDb) => onEdit({ music: { duckDb } })} />}
        {m.asset.durationMs && m.asset.durationMs < timeline.durationMs ? <span className="text-xs text-ink-2">Shorter than the video: stops at {clock(m.asset.durationMs)}</span> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPicking(true)}>Choose another audio file</Button>
          <Button size="sm" onClick={() => onEdit({ music: { asset: null } })}><Trash2 size={13} /> Remove music</Button>
        </div>
      </div>
      {picking && <Picker title="Music" kind="audio" onClose={() => setPicking(false)} onPick={(asset) => { onEdit({ music: { asset } }); setPicking(false); }} />}
    </aside>
  );
}
