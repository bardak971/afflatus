import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Music, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { mostFromMs, musicPlan, songAt, type ClipMusic, type MusicSpan } from "@afflatus/core";
import type { Clip, Timeline, TimelinePatch } from "../../api";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { clock } from "../../format";
import { cx } from "../../ui";
import { PAD, placeOf, type Slot } from "../model";
import { ClipMusicPopover, clipMusicWords } from "./ClipMusicPopover";
import { MUSIC } from "./rows";
import type { Motion } from "./useMotionMarks";
import { Wave } from "./Wave";

/** How near its left edge (px) an Alt + press takes the music's start rather than the song. */
const EDGE = 10;

/** A drag on the music under way: the song slid (its `fromMs`), or its start moved to another clip (Alt + its left edge). */
type Drag = { kind: "song" | "start"; x: number; from: number; moved: boolean; span: MusicSpan | null; el: HTMLElement | null };

/**
 * The music lane: the song under the video, split at the clips. The parts of the song that do not play are drawn faint
 * past both ends; dragging it chooses which part plays, Alt + its left edge the clip it starts with. A clip's stretch
 * says what it asks of the music there (clicked: its settings; right-clicked: its menu).
 */
export function MusicLane({ timeline, slots, pps, width, selected, over, measureOf, onDragOver, onSelectMusic, onMusicMenu, onMusicEdit, onClipMusic }: {
  timeline: Timeline;
  slots: Slot[];
  pps: number;
  /** The track's width: the faint song stops there. */
  width: number;
  /** The music panel is open; an audio file is dragged over the lane. */
  selected: boolean;
  over: boolean;
  measureOf(id: string | undefined): Motion | undefined;
  onDragOver(e: DragEvent): void;
  onSelectMusic(): void;
  onMusicMenu?(e: React.MouseEvent): void;
  onMusicEdit?(patch: TimelinePatch): void;
  onClipMusic?(clip: Clip, music: ClipMusic | null): void;
}) {
  const music = timeline.music;
  const clips = timeline.clips;
  /** What a drag shows until the timeline read again says the same. */
  const [held, setHeld] = useState<{ fromMs?: number; startClip?: string | null } | null>(null);
  useEffect(() => setHeld(null), [music?.fromMs, music?.startClip]);
  const drag = useRef<Drag | null>(null);
  const [pop, setPop] = useState<{ clip: string; el: HTMLElement } | null>(null);
  const popAnchor = useRef<HTMLElement | null>(null);
  popAnchor.current = pop?.el ?? null;
  const menu = useMenu<string>();

  const base = music ? { ...music, durationMs: music.asset.durationMs ?? 0, ...held } : null;
  const planned = useMemo(() => clips.map((c) => ({ id: c.id, atMs: c.atMs, lengthMs: c.lengthMs, music: c.music })), [clips]);
  const plan = useMemo(() => (base ? musicPlan(base, planned) : null), [JSON.stringify(base), planned]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!music || !plan || !base) {
    return (
      <button
        type="button"
        onDragOver={onDragOver}
        onContextMenu={(e) => onMusicMenu?.(e)}
        aria-label="Music: none. Drop an audio file here."
        style={{ left: PAD + 1, top: MUSIC.top, height: MUSIC.height, width: Math.max(140, (slots.length ? slots.at(-1)!.left + slots.at(-1)!.width - PAD : 0) - 2) }}
        className={cx("absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-line-strong px-2 text-left text-[11px] text-ink-3", over && "outline outline-2 outline-accent")}
      >
        <Music size={11} className="relative shrink-0" />
        <span className="relative truncate">Drop an audio file here to play it under the whole video</span>
      </button>
    );
  }

  const m = measureOf(music.asset.id);
  const xAt = (ms: number) => placeOf(slots, ms)?.x ?? PAD;
  const xs = xAt(plan.startMs);
  const xe = xAt(plan.endMs);
  const songMs = base.durationMs;
  const mostFrom = mostFromMs(base, planned);
  const restMs = songMs ? Math.max(0, songMs - plan.fromMs - (plan.endMs - plan.startMs)) : 0;
  const faintLeft = xs - (plan.fromMs / 1000) * pps;
  const faintRight = Math.min(width, xe + (restMs / 1000) * pps);
  // the clips' starts the music can start with (the first: with clip 1)
  const starts = slots.filter((s) => !s.planned && s.clip.lengthMs > 0);

  const down = (e: ReactPointerEvent<HTMLElement>, span: MusicSpan | null) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const lane = el.closest("[data-music-lane]") as HTMLElement | null;
    const kind = e.altKey && Math.abs(e.clientX - (lane?.getBoundingClientRect().left ?? 0) - (xs - faintLeft)) <= EDGE ? "start" : "song";
    drag.current = { kind, x: e.clientX, from: plan.fromMs, moved: false, span, el };
    lane?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 4) return;
    d.moved = true;
    if (d.kind === "song") {
      // the song moves with the pointer: right shows an earlier part of it; on tenths of a second, within the song
      const from = Math.max(0, Math.min(mostFrom, Math.round((d.from - (dx / pps) * 1000) / 100) * 100));
      if (from !== (held?.fromMs ?? music.fromMs)) setHeld({ ...held, fromMs: from });
    } else {
      // to the nearest clip start
      const at = xAt(plan.startMs) + dx;
      const near = starts.reduce<Slot | null>((best, s) => (!best || Math.abs(s.left - at) < Math.abs(best.left - at) ? s : best), null);
      const startClip = !near || near === starts[0] ? null : near.clip.id;
      if (startClip !== (held?.startClip !== undefined ? held.startClip : music.startClip)) setHeld({ ...held, startClip });
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // a click: the music under that clip
      if (d.span && d.el) setPop({ clip: d.span.clip, el: d.el });
      else onSelectMusic();
      return;
    }
    if (d.kind === "song" && held?.fromMs !== undefined && held.fromMs !== music.fromMs) onMusicEdit?.({ music: { fromMs: held.fromMs } });
    else if (d.kind === "start" && held?.startClip !== undefined && held.startClip !== music.startClip) onMusicEdit?.({ music: { startClip: held.startClip } });
    else setHeld(null);
  };

  const popClip = pop ? clips.find((c) => c.id === pop.clip) : undefined;
  const menuClip = menu.menu ? clips.find((c) => c.id === menu.menu!.subject) : undefined;
  const indexOf = (id: string) => clips.findIndex((c) => c.id === id);
  const name = music.asset.name || "Music";

  return (
    <div
      data-music-lane
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { drag.current = null; setHeld(null); }}
      onDragOver={onDragOver}
      style={{ left: faintLeft, top: MUSIC.top, height: MUSIC.height, width: Math.max(0, faintRight - faintLeft) }}
      className={cx("absolute", (selected || over) && "rounded outline outline-2 outline-accent")}
    >
      {/* the song past both ends of what plays, faint: the parts that do not play */}
      <div
        aria-hidden
        onPointerDown={(e) => down(e, null)}
        onContextMenu={(e) => onMusicMenu?.(e)}
        className="absolute inset-0 cursor-grab overflow-hidden rounded border border-dashed border-accent/30 bg-accent/5 text-accent"
      >
        {m && songMs > 0 && <span className="absolute inset-0 opacity-40"><Wave sound={m.sound} rate={m.rate} fromMs={0} toMs={songMs} /></span>}
      </div>
      {plan.spans.map((s, i) => {
        const a = xAt(s.atMs) - faintLeft;
        const b = xAt(s.atMs + s.lengthMs) - faintLeft;
        const c = clips.find((x) => x.id === s.clip);
        const words = clipMusicWords(c?.music ?? null);
        const n = indexOf(s.clip) + 1;
        return (
          <button
            key={s.clip}
            type="button"
            data-music-clip={s.clip}
            onPointerDown={(e) => down(e, s)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setPop({ clip: s.clip, el: e.currentTarget });
              }
            }}
            onContextMenu={(e) => menu.open(e, s.clip)}
            aria-label={`Music under clip ${n}${words.length ? `: ${words.join(", ")}` : ""}`}
            data-tip={i === 0 ? "Drag: which part of the song plays · Alt + drag its left edge: start under a later clip · click: the music under this clip" : undefined}
            style={{ left: a + 1, width: Math.max(4, b - a - 2) }}
            className={cx(
              "absolute top-0 bottom-0 flex cursor-grab items-center gap-1 overflow-hidden rounded px-1.5 text-left text-[10px] text-accent active:cursor-grabbing",
              s.muted ? "bg-accent/5 ring-1 ring-accent/20 ring-inset" : "bg-accent-wash",
              pop?.clip === s.clip && "ring-2 ring-accent ring-inset",
            )}
          >
            {!s.muted && m && (
              <span className="absolute inset-0" style={{ opacity: Math.max(0.25, Math.min(1, s.level)) }}>
                <Wave sound={m.sound} rate={m.rate} fromMs={songAt(plan, s.atMs)} toMs={songAt(plan, s.atMs + s.lengthMs)} />
              </span>
            )}
            {i === 0 && <span className="relative flex shrink-0 items-center gap-1 rounded bg-ground/85 px-1 font-semibold text-ink"><Music size={10} />{name}</span>}
            {i === 0 && plan.fromMs > 0 && <span className="relative shrink-0 rounded bg-ground/85 px-1 font-mono font-semibold text-ink">from {clock(plan.fromMs, { decimals: 1 })}</span>}
            {words.map((w) => <span key={w} className={cx("relative shrink-0 rounded bg-ground/85 px-1 font-semibold", w === "muted" ? "text-ink-3" : "text-ink")}>{w}</span>)}
          </button>
        );
      })}
      {/* where it starts: Alt + drag moves it to a later clip */}
      <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-[3px] rounded bg-accent/60" style={{ left: xs - faintLeft }} />
      {pop && popClip && (
        <ClipMusicPopover
          key={pop.clip}
          anchor={popAnchor}
          index={indexOf(pop.clip)}
          music={popClip.music}
          base={music}
          onChange={(next) => onClipMusic?.(popClip, next)}
          onClose={() => setPop(null)}
        />
      )}
      {menu.menu && menuClip && (
        <ContextMenu
          at={menu.menu.at}
          label="The music under this clip"
          head={{ title: `Clip ${indexOf(menuClip.id) + 1}`, sub: "Music under it" }}
          items={[
            menuClip.music?.muted
              ? { label: "Unmute here", icon: <Volume2 size={14} />, run: () => onClipMusic?.(menuClip, { ...menuClip.music, muted: false }) }
              : { label: "Mute here", icon: <VolumeX size={14} />, run: () => onClipMusic?.(menuClip, { ...menuClip.music, muted: true }) },
            { label: "Same as the rest", icon: <Music size={14} />, disabled: !menuClip.music, run: () => onClipMusic?.(menuClip, null) },
            "—",
            { label: "Music under it…", icon: <SlidersHorizontal size={14} />, note: clipMusicWords(menuClip.music).join(" · ") || undefined, run: () => {
              const el = document.querySelector<HTMLElement>(`[data-music-clip="${menuClip.id}"]`);
              if (el) setPop({ clip: menuClip.id, el });
            } },
            { label: "Music settings", icon: <SlidersHorizontal size={14} />, run: onSelectMusic },
          ]}
          onClose={menu.close}
        />
      )}
    </div>
  );
}
