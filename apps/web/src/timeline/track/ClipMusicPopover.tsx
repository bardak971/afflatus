import { useState, type RefObject } from "react";
import { CLIP_FADE_MS, clipMusicOf, MUSIC_RAMP_MS, strongDuckDb, type ClipMusic } from "@afflatus/core";
import type { Timeline } from "../../api";
import { Popover } from "../../Popover";
import { Slider } from "../../Slider";
import { Button, Help, Segmented, Toggle } from "../../ui";

/** One row of the popover: its name on the left, its control on the right. */
function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-10 grid-cols-[80px_1fr] items-center gap-2.5 border-t border-line px-3.5 py-1">
      <span>{name}</span>
      {children}
    </div>
  );
}

/** What a clip asks of the music under it, in a few words for its stretch of the music lane. */
export function clipMusicWords(m: ClipMusic | null): string[] {
  if (!m) return [];
  if (m.muted) return ["muted"];
  return [
    ...(m.volume !== undefined ? [`${m.volume} %`] : []),
    ...(m.duck === "strong" ? ["duck strong"] : m.duck === "off" ? ["no duck"] : []),
    ...(m.fadeIn ? ["fade in"] : []),
    ...(m.fadeOut ? ["fade out"] : []),
  ];
}

/** The music under one clip, set there: like its own audio. Opened from its stretch of the music lane. */
export function ClipMusicPopover({ anchor, index, music, base, onChange, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  /** The clip's place, from 0. */
  index: number;
  music: ClipMusic | null;
  base: NonNullable<Timeline["music"]>;
  /** The clip's settings as they are to be: only what differs from the rest (null: nothing does). */
  onChange(music: ClipMusic | null): void;
  onClose(): void;
}) {
  const m = music ?? {};
  const [volume, setVolume] = useState<number | null>(null);
  const set = (change: Partial<Record<keyof ClipMusic, unknown>>) => onChange(clipMusicOf({ ...m, ...change }));
  const shown = volume ?? m.volume ?? 100;
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Music under clip ${index + 1}`} width={330} height={300}>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="rounded-md bg-accent-wash px-1.5 py-0.5 text-meta font-bold text-accent">CLIP {index + 1}</span>
        <span className="text-meta font-bold tracking-wider text-ink-3 uppercase">Music under it</span>
        <Help title="Music under it" text={`Over the music's own volume, fades and ducking. Fades take ${(CLIP_FADE_MS / 1000).toFixed(1)} s; level changes at the clip's edges ramp over ${MUSIC_RAMP_MS} ms. The player and the export apply it alike.`} />
        <span className="grow" />
        <span className="text-xs text-ink-3">Esc</span>
      </div>
      <Row name="Volume">
        <span className="flex items-center gap-2.5">
          <Slider
            box={false}
            label="Volume of the music under this clip"
            min={0}
            max={150}
            step={5}
            mark={100}
            off={m.muted}
            value={shown}
            format={(v) => `${v} %`}
            onChange={setVolume}
            onCommit={(v) => {
              setVolume(null);
              set({ volume: v });
            }}
            className="grow"
          />
          <span className="w-11 text-right font-mono text-xs">{m.muted ? "muted" : `${shown} %`}</span>
        </span>
      </Row>
      <Row name="Ducking">
        <Segmented
          size="sm"
          label="Ducking under speech here"
          value={m.duck ?? "rest"}
          options={[
            { value: "rest", label: "As the rest", tip: base.duck ? `−${base.duckDb} dB under speech` : "the music is not ducked" },
            { value: "off", label: "Off" },
            { value: "strong", label: "Strong", tip: `−${strongDuckDb(base.duckDb)} dB under speech` },
          ]}
          onChange={(v) => set({ duck: v === "rest" ? undefined : v })}
        />
      </Row>
      <Row name="Fade in">
        <span className="flex justify-end"><Toggle bare on={Boolean(m.fadeIn)} onChange={(fadeIn) => set({ fadeIn })} label="Fade the music in at the clip's start" /></span>
      </Row>
      <Row name="Fade out">
        <span className="flex justify-end"><Toggle bare on={Boolean(m.fadeOut)} onChange={(fadeOut) => set({ fadeOut })} label="Fade the music out at the clip's end" /></span>
      </Row>
      <Row name="Mute here">
        <span className="flex justify-end"><Toggle bare on={Boolean(m.muted)} onChange={(muted) => set({ muted })} label="Mute the music under this clip" /></span>
      </Row>
      <div className="flex items-center gap-2 border-t border-line px-3.5 pt-2 pb-3">
        <span className="grow" />
        <Button size="sm" disabled={!music} onClick={() => onChange(null)}>Same as the rest</Button>
      </div>
    </Popover>
  );
}
