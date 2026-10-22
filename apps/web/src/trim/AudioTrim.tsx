import { useEffect, useState } from "react";
import type { Asset } from "../api";
import { AudioPlayer } from "../AudioPlayer";
import { clock } from "../format";
import { SoundRange } from "../SoundRange";
import { CloseButton, Toggle } from "../ui";
import { CutButtons } from "./CutButtons";
import type { Range } from "./range";

/**
 * The Trim mode of a sound: the player over the whole sound's waveform (SoundRange: its pauses marked, the range's ends
 * landing in them, Alt anywhere; a click plays from there), Play playing the range, and what video's Trim does with a
 * range: copied, split or removed (CutButtons), as WAVs, their loudness evened out when asked. Esc closes it.
 */
export function AudioTrim({ asset, busy, onCut, onClose }: {
  asset: Asset;
  busy: boolean;
  onCut(range: Range, action: "copy" | "split" | "remove", even: boolean): void;
  onClose(): void;
}) {
  const total = (asset.durationMs ?? 0) / 1000;
  // the whole sound at first: nothing to cut until a range is drawn or a knob moved
  const [part, setPart] = useState({ start: 0, seconds: total });
  const [even, setEven] = useState(false);
  const end = Math.min(total, part.start + part.seconds);
  const whole = part.start <= 0.01 && end >= total - 0.01;
  const range: Range = { startMs: part.start * 1000, endMs: end * 1000 };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || el?.closest("input, textarea, [role=dialog]")) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="flex w-full max-w-[860px] flex-col gap-2.5" onClick={(e) => e.stopPropagation()}>
      <AudioPlayer
        asset={asset.id} name={asset.name || "Audio"} range={{ from: part.start, to: end }}
        strip={(now, playFrom) => (
          <SoundRange asset={asset.id} total={total} start={part.start} seconds={part.seconds} min={0.05} most={total} label="Trim: the range" playhead={now} onSeek={playFrom} onCommit={(start, seconds) => setPart({ start, seconds })} />
        )}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2">
        <span className="font-mono text-xs text-ink-2">{whole ? "the whole sound: drag on it for a range" : `${clock(range.startMs, { decimals: 1 })}–${clock(range.endMs, { decimals: 1 })} · ${(end - part.start).toFixed(1)} s`}</span>
        <CutButtons what="sound" busy={busy} whole={whole} edge={part.start <= 0.01 || end >= total - 0.01} onCopy={() => onCut(range, "copy", even)} onSplit={() => onCut(range, "split", even)} onRemove={() => onCut(range, "remove", even)} />
        <Toggle on={even} onChange={setEven} label="Even loudness" note="what is made is brought to a usual level (EBU R128, -16 LUFS)" />
        <span className="grow" />
        <CloseButton label="Close Trim" keys="Esc" onClose={onClose} />
      </div>
    </div>
  );
}
