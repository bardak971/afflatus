import { useState } from "react";
import { Camera, Download, Link2, Maximize, Pause, Play, Redo2, Repeat, SkipBack, SkipForward, Sparkles, Undo2, Volume2, VolumeX } from "lucide-react";
import type { Clip, MachineState, Timeline } from "../api";
import { clock, est, plural } from "../format";
import { Estimate } from "./estimate";
import { Button, Chip, cx, Help } from "../ui";
import { Slider } from "../Slider";
import { useQueue } from "../data";
import { timelineKey } from "../draftMachine";
import { RenderOn, usePickedMachine } from "../GenerateOn";
import { machineLabel, severalMachines } from "../machines";
import type { Clock } from "./clock";
import { Readout } from "./Readout";
import type { Slot } from "./model";

/**
 * The editor's header: the timeline's name, its length, what is said (a save that failed, an error, a note), Undo and Redo,
 * and what is done to the whole timeline: render what is left, render the picked clips, finish, export.
 */
export function TimelineHeader({ t, clips, total, saveFailed, onRetrySave, said, onHold, undo, redo, missing, allMs, allOn, picked, rendering, onRename, onRenderMissing, onRenderPicked, onFinish, onExport }: {
  t: Timeline;
  clips: Clip[];
  total: number;
  saveFailed: string | null;
  onRetrySave(): void;
  /** An error (said in the warning colour), else a note: one line, and what more there is to it behind a "?"; Undo beside it for what it says was done. */
  said: { error: Error | null; note: { text: string; more?: string; undo?: boolean } | null };
  /** The pointer rests on what is said: it stays while it is read. */
  onHold?(held: boolean): void;
  undo: { run(): void; pending: boolean };
  redo: { run(): void; pending: boolean };
  /** The clips with nothing to play yet or a stale join, and about how long they take to render. */
  missing: Clip[];
  /** On the machine picked for the timeline, else Auto. */
  allMs: number;
  /** On each machine (null: Auto), for the machine list beside Render all. */
  allOn(m: MachineState | null): number;
  /** How many clips are picked with Ctrl + click, and whether any of them can be rendered. */
  picked: { size: number; renderable: boolean };
  rendering: boolean;
  onRename(name: string): void;
  onRenderMissing(): void;
  onRenderPicked(): void;
  onFinish(): void;
  onExport(): void;
}) {
  const [name, setName] = useState<string | null>(null);
  const several = severalMachines(useQueue().data).length > 0;
  const on = usePickedMachine(timelineKey(t.id));
  const { error, note } = said;
  // rendered and planned, as the index says them ("1:37 rendered of 1:47"), the figures in mono
  const now = clock(t.durationMs);
  const planned = clock(total);
  // a narrow header (a small window, a wide right column) says Finish and Export by their icons, their names in the
  // tip, as Undo and Redo do; the name box and the chips give up their width first, so no button is pushed off-screen
  const narrow = "@max-[70rem]/head:hidden";
  const iconOnly = "@max-[70rem]/head:w-10 @max-[70rem]/head:px-0!";
  return (
    <header className="@container/head flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line px-3">
      <input
        aria-label="Timeline name"
        value={name ?? t.name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== null && name.trim() && name !== t.name) onRename(name.trim());
          setName(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-9 w-56 min-w-24 shrink rounded-lg border border-transparent bg-transparent px-2 text-base font-semibold hover:border-line focus:border-accent focus:bg-raised"
      />
      <Chip className="min-w-0 shrink!">
        {clips.length === 0 ? "Empty" : (
          <span className="truncate">
            <span className="font-mono">{now}</span>
            {now !== planned && <> rendered of <span className="font-mono">{planned}</span></>} · {plural(clips.length, "clip")}
          </span>
        )}
      </Chip>
      {missing.length > 0 && <Chip tone="warn" className="min-w-0 shrink!"><span className="truncate">{missing.length} to render{allMs ? ` · ${est(allMs)}` : ""}</span></Chip>}
      <span className="grow" />
      {saveFailed ? (
        // what was typed is still on screen and not on the server: said, with the way to send it again
        <span className="flex min-w-0 max-w-sm items-center gap-2 text-warn-ink" data-tip={saveFailed}>
          <span className="truncate">Could not save the clip's form: {saveFailed}</span>
          <Button size="sm" onClick={onRetrySave}>Retry</Button>
        </span>
      ) : (error || note) ? (
        <span className="flex min-w-0 max-w-sm items-center gap-1.5" onPointerEnter={() => onHold?.(true)} onPointerLeave={() => onHold?.(false)}>
          <span className={error ? "truncate text-warn-ink" : "truncate text-ink-2"} data-tip={error?.message ?? note?.text}>{error?.message ?? note?.text}</span>
          {!error && note?.more && <Help text={note.more} />}
          {!error && note?.undo && t.undo && <Button size="sm" tone="quiet" className="h-6 shrink-0 px-2" disabled={undo.pending} data-tip={`Undo: ${t.undo}`} data-tip-keys="Ctrl+Z" onClick={undo.run}>Undo</Button>}
        </span>
      ) : null}
      {/* icons, their keys in the tip: as words they stood level with Finish and Export, which they are not */}
      <Button className="w-10 shrink-0 px-0!" aria-label="Undo" disabled={!t.undo || undo.pending} data-tip={t.undo ? `Undo: ${t.undo}` : "Nothing to undo"} data-tip-keys="Ctrl+Z" onClick={undo.run}>
        <Undo2 size={16} />
      </Button>
      <Button className="-ml-1 w-10 shrink-0 px-0!" aria-label="Redo" disabled={!t.redo || redo.pending} data-tip={t.redo ? `Redo: ${t.redo}` : "Nothing to redo"} data-tip-keys="Ctrl+Shift+Z | Ctrl+Y" onClick={redo.run}>
        <Redo2 size={16} />
      </Button>
      {/* with several ComfyUIs, each with the slice that picks where the timeline's clips render (New take's pick) */}
      {missing.length > 0 && (
        <span className="flex shrink-0">
          <Button tone="primary" className={cx(several && "rounded-r-none!")} disabled={rendering} data-tip={`Renders the clips that have no take yet and redoes the ones that no longer follow the clip before them, in order.${on ? ` On ${machineLabel(on)}.` : ""}`} onClick={onRenderMissing}>
            Render all ({missing.length})<Estimate ms={allMs} />
          </Button>
          <RenderOn pickKey={timelineKey(t.id)} msOn={allOn} />
        </span>
      )}
      {picked.size > 0 && (
        <span className="flex shrink-0">
          <Button tone="primary" className={cx(several && "rounded-r-none!")} disabled={rendering || !picked.renderable} data-tip="Renders the clips picked with Ctrl + click, together: each is queued as its own job, in order, and a clip that flows on from a picked one waits for it. Esc drops the pick." onClick={onRenderPicked}>
            Render {picked.size} picked
          </Button>
          <RenderOn pickKey={timelineKey(t.id)} msOn={() => null} />
        </span>
      )}
      <Button className={cx("shrink-0", iconOnly)} aria-label="Finish" disabled={!clips.some((c) => c.kind === "video" && c.take)} data-tip="Finish: every clip's selected take brought to its final quality by an upscale route, as a new take each. The drafts stay." onClick={onFinish}>
        <Sparkles size={15} /> <span className={narrow}>Finish</span>
      </Button>
      <Button className={cx("shrink-0", iconOnly)} aria-label={t.exporting ? "Exporting…" : "Export video"} disabled={!t.durationMs} data-tip={t.exporting ? "Exporting…" : "Export video: the whole timeline as one file"} onClick={onExport}>
        <Download size={15} /> <span className={narrow}>{t.exporting ? "Exporting…" : "Export video"}</span>
      </Button>
    </header>
  );
}

/**
 * The bar under the player: previous and next clip, play (the range when there is one), loop the range, the clock, the
 * volume here, full screen, and what is done at the frame on screen (extend from it, save it).
 */
export function Transport({ t, clock, slots, cursor, total, source, playing, ranged, loopRange, volume, muted, adding, saving, onJump, onToggle, onToggleLoop, onVolume, onMute, onFullscreen, onExtend, onSaveFrame }: {
  t: Timeline;
  clock: Clock;
  slots: Slot[];
  /** The stage plays the source lane (where it lies on the track): the readout speaks of it. */
  source?: { atMs: number; lengthMs: number } | null;
  cursor: number | null;
  total: number;
  playing: boolean;
  /** A range is set (and not empty): Play plays it, and it can loop. */
  ranged: boolean;
  loopRange: boolean;
  volume: number;
  muted: boolean;
  adding: boolean;
  saving: boolean;
  onJump(by: -1 | 1): void;
  onToggle(): void;
  onToggleLoop(): void;
  onVolume(volume: number): void;
  onMute(): void;
  onFullscreen(): void;
  onExtend(): void;
  onSaveFrame(): void;
}) {
  return (
    <div className="flex h-[54px] shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
      <button type="button" aria-label="Previous clip" data-tip="Previous clip" disabled={!t.durationMs} onClick={() => onJump(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipBack size={15} /></button>
      <button type="button" aria-label={playing ? "Pause" : ranged ? "Play the range" : "Play"} data-tip={ranged ? "Play the range: from the playhead inside it, else from In; stops at Out (Space)" : "Play / pause (Space)"} disabled={!t.durationMs && !source} onClick={onToggle} className={cx("flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40", ranged ? "bg-accent text-accent-ink" : "bg-ink text-ground")}>
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
      </button>
      <button type="button" aria-label="Next clip" data-tip="Next clip" disabled={!t.durationMs} onClick={() => onJump(1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipForward size={15} /></button>
      {ranged && (
        <button type="button" aria-label="Loop the range" aria-pressed={loopRange} data-tip={loopRange ? "Loop is on: back to In at Out (L)" : "Loop the range (L)"} onClick={onToggleLoop} className={cx("flex h-8 w-8 items-center justify-center rounded-lg", loopRange ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover hover:text-ink")}><Repeat size={15} /></button>
      )}
      <Readout clock={clock} slots={slots} cursor={cursor} total={total} source={source} />
      <span className="grow" />
      {/* how loud it plays here (the clips' and the music's own volumes stay as set) */}
      <div className="group flex items-center gap-1">
        <button type="button" aria-label={muted || volume === 0 ? "Unmute" : "Mute"} data-tip={muted || volume === 0 ? "Unmute" : "Mute"} onClick={onMute} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
          {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <Slider box={false} min={0} max={1} step={0.01} value={muted ? 0 : volume} label="Volume" format={(v) => `Volume ${Math.round(v * 100)} %`} onChange={onVolume} className="w-20" />
      </div>
      <button type="button" aria-label="Full screen" data-tip="Full screen (Esc leaves it; Space plays and pauses)" disabled={!t.durationMs && !source} onClick={onFullscreen} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><Maximize size={15} /></button>
      <button type="button" aria-label="Extend from this frame" data-tip="Extend from this frame: cuts the clip on screen here and adds a new clip that carries on from it" disabled={!t.durationMs || adding} onClick={onExtend} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><Link2 size={15} /></button>
      <button
        type="button"
        aria-label="Save frame"
        data-tip="Save frame: the frame on screen, as an image in your library"
        disabled={!t.durationMs || saving}
        onClick={onSaveFrame}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
      >
        <Camera size={15} />
      </button>
    </div>
  );
}
