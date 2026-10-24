import { useState } from "react";
import { Camera, Download, History, Link2, Maximize, Redo2, Repeat, SkipBack, SkipForward, Sparkles, Undo2, Volume2, VolumeX } from "lucide-react";
import type { Clip, MachineState, Timeline } from "../api";
import { clock, est, plural } from "../format";
import { Estimate } from "./estimate";
import { Button, Chip, cx, Help, IconButton } from "../ui";
import { ContextMenu, useMenu } from "../ContextMenu";
import { PlayButton } from "../mediaControls";
import { Slider } from "../Slider";
import { useQueue } from "../data";
import { timelineKey } from "../draftMachine";
import { RenderOn, usePickedMachine } from "../GenerateOn";
import { machineLabel, severalMachines } from "../machines";
import type { Clock } from "./clock";
import { Readout, type StagePlays } from "./Readout";
import type { Slot } from "./model";

/**
 * The editor's header: the timeline's name, its length, what is said (a save that failed, an error, a note), Undo and Redo,
 * and what is done to the whole timeline: render what is left, render the picked clips, finish, export.
 */
export function TimelineHeader({ t, clips, total, saveFailed, onRetrySave, said, onHold, undo, redo, missing, allMs, allOn, allBlocked, picked, rendering, onRename, onRenderMissing, onRenderPicked, onFinish, onExport }: {
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
  /** Why a machine cannot take the clips left to render; null: it can. */
  allBlocked(m: MachineState): string | null;
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
  // a narrow header (a small window, a wide right column) folds Undo and Redo into one menu first (their keys still
  // work): Finish and Export, the two outward and costly acts, keep their words at every width; the name box and the
  // chips give up their width before that, so no button is pushed off-screen
  const wide = "@max-[60rem]/head:hidden";
  const folded = "@min-[60rem]/head:hidden";
  const history = useMenu<null>();
  return (
    <header className="@container/head flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-3">
      <input
        aria-label="Timeline name"
        value={name ?? t.name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== null && name.trim() && name !== t.name) onRename(name.trim());
          setName(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-9 w-56 min-w-24 shrink rounded-lg border border-transparent bg-transparent px-2 text-base font-semibold hover:border-line focus:border-accent focus:bg-raised focus:shadow-[0_0_0_3px_var(--color-accent-wash)]"
      />
      {/* short on a narrow header, it keeps its figures whole: the name gives way */}
      <Chip className="@[56rem]/head:min-w-0 @[56rem]/head:shrink!">
        {clips.length === 0 ? "Empty" : (
          <span className="truncate">
            <span className="font-mono">{now}</span>
            {/* on a narrow window "0:00 / 0:10", the clips' count left to the Overview: the estimate beside it is kept whole */}
            {now !== planned && <><span className="hidden @[56rem]/head:inline"> rendered of </span><span className="@[56rem]/head:hidden"> / </span><span className="font-mono">{planned}</span></>}
            <span className="hidden @[56rem]/head:inline"> · {plural(clips.length, "clip")}</span>
          </span>
        )}
      </Chip>
      {/* to do, not wrong: neutral (red is for what failed) */}
      {missing.length > 0 && <Chip className="shrink-0">{missing.length} to render{allMs ? ` · ${est(allMs)}` : ""}</Chip>}
      <span className="grow" />
      {saveFailed ? (
        // what was typed is still on screen and not on the server: said, with the way to send it again
        <span className="flex min-w-0 max-w-sm items-center gap-2 text-warn-ink" data-tip={saveFailed}>
          <span className="truncate">Could not save the form: {saveFailed}</span>
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
      <IconButton size={40} tone="outline" label="Undo" tip={t.undo ? `Undo: ${t.undo}` : "Nothing to undo"} keys="Ctrl+Z" disabled={!t.undo || undo.pending} onClick={undo.run} className={wide}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton size={40} tone="outline" label="Redo" tip={t.redo ? `Redo: ${t.redo}` : "Nothing to redo"} keys="Ctrl+Shift+Z | Ctrl+Y" disabled={!t.redo || redo.pending} onClick={redo.run} className={cx("-ml-1", wide)}>
        <Redo2 size={16} />
      </IconButton>
      <IconButton size={40} tone="outline" label="Undo or redo" tip="Undo (Ctrl+Z) or redo (Ctrl+Shift+Z)" aria-haspopup="menu" disabled={(!t.undo || undo.pending) && (!t.redo || redo.pending)} onClick={(e) => history.open(e, null)} className={folded}>
        <History size={16} />
      </IconButton>
      {history.menu && (
        <ContextMenu
          at={history.menu.at}
          label="Undo or redo"
          head={{ title: t.name, sub: "Timeline · its history" }}
          // only what there is to undo or redo: "Nothing to redo" was a dead row
          items={[
            ...(t.undo ? [{ label: `Undo: ${t.undo}`, key: "Ctrl+Z", icon: <Undo2 size={14} />, disabled: undo.pending, note: undo.pending ? "undoing…" : undefined, run: undo.run }] : []),
            ...(t.redo ? [{ label: `Redo: ${t.redo}`, key: "Ctrl+Shift+Z | Ctrl+Y", icon: <Redo2 size={14} />, disabled: redo.pending, note: redo.pending ? "redoing…" : undefined, run: redo.run }] : []),
          ]}
          onClose={history.close}
        />
      )}
      {/* plain, its count in the accent: the one coral button of the editor is the inspector's, which acts on what is
          selected; with several machines, each with the slice that picks where the timeline's clips render */}
      {missing.length > 0 && (
        <span className="flex shrink-0">
          <Button className={cx(several && "rounded-r-none!")} disabled={rendering} data-tip={`Renders the clips that have no take yet and redoes the ones that no longer follow the clip before them, in order.${on ? ` On ${machineLabel(on)}.` : ""}`} onClick={onRenderMissing}>
            Render all <Count n={missing.length} /><Estimate ms={allMs} />
          </Button>
          <RenderOn pickKey={timelineKey(t.id)} msOn={allOn} blocked={allBlocked} />
        </span>
      )}
      {picked.size > 0 && (
        <span className="flex shrink-0">
          <Button className={cx(several && "rounded-r-none!")} disabled={rendering || !picked.renderable} data-tip="Renders the clips picked with Ctrl + click, together: each is queued as its own job, in order, and a clip that flows on from a picked one waits for it. Esc drops the pick." onClick={onRenderPicked}>
            Render picked <Count n={picked.size} />
          </Button>
          <RenderOn pickKey={timelineKey(t.id)} msOn={() => null} />
        </span>
      )}
      <Button className="shrink-0" disabled={!clips.some((c) => c.kind === "video" && c.take)} data-tip="Finish: every clip's selected take brought to its final quality by an upscale route, as a new take each. The drafts stay." onClick={onFinish}>
        <Sparkles size={15} /> Finish…
      </Button>
      <Button className="shrink-0" disabled={!t.durationMs} data-tip={t.exporting ? "Exporting…" : "Export video: the whole timeline as one file"} onClick={onExport}>
        <Download size={15} /> {t.exporting ? "Exporting…" : "Export…"}
      </Button>
    </header>
  );
}

/** How many a header button acts on, in the accent: the button stays plain, its figure says there is something to do. */
function Count({ n }: { n: number }) {
  return <Chip size="xs" tone="solid" className="-ml-0.5 min-w-4.5 justify-center font-mono">{n}</Chip>;
}

/**
 * The bar under the player: previous and next clip, play (the range when there is one), loop the range, the clock, the
 * volume here, full screen, and what is done at the frame on screen (extend from it, save it).
 */
export function Transport({ t, clock, slots, cursor, total, source, playing, ranged, loopRange, volume, muted, adding, saving, onJump, onToggle, onToggleLoop, onVolume, onMute, onFullscreen, onExtend, onSaveFrame }: {
  t: Timeline;
  clock: Clock;
  slots: Slot[];
  /** The stage plays the source lane or a recording (where it lies on the track): the readout speaks of it. */
  source?: StagePlays | null;
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
      <IconButton label="Previous clip" disabled={!t.durationMs} onClick={() => onJump(-1)}><SkipBack size={15} /></IconButton>
      {/* the app's one play button (the viewer's, the music's); a range set rings it, as Play then plays the range */}
      <PlayButton on={playing} label={playing ? "Pause" : ranged ? "Play the range" : "Play"} tip={ranged ? "Play the range: from the playhead inside it, else from In; stops at Out" : "Play / pause"} disabled={!t.durationMs && !source} onClick={onToggle} className={cx(ranged && "ring-2 ring-accent/40 ring-offset-2 ring-offset-panel")} />
      <IconButton label="Next clip" disabled={!t.durationMs} onClick={() => onJump(1)}><SkipForward size={15} /></IconButton>
      {ranged && (
        <IconButton label="Loop the range" pressed={loopRange} tip={loopRange ? "Loop is on: back to In at Out" : "Loop the range"} keys="L" onClick={onToggleLoop}><Repeat size={15} /></IconButton>
      )}
      <Readout clock={clock} slots={slots} cursor={cursor} total={total} source={source} />
      <span className="grow" />
      {/* how loud it plays here (the clips' and the music's own volumes stay as set) */}
      <div className="group flex items-center gap-1">
        <IconButton label={muted || volume === 0 ? "Unmute" : "Mute"} onClick={onMute}>
          {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </IconButton>
        <Slider box={false} min={0} max={1} step={0.01} value={muted ? 0 : volume} label="Volume" format={(v) => `Volume ${Math.round(v * 100)} %`} onChange={onVolume} className="w-20" />
      </div>
      <IconButton label="Full screen" tip="Full screen (Esc leaves it; Space plays and pauses)" disabled={!t.durationMs && !source} onClick={onFullscreen}><Maximize size={15} /></IconButton>
      <IconButton label="Extend from this frame" tip="Extend from this frame: cuts the clip on screen here and adds a new clip that carries on from it" disabled={!t.durationMs || adding} onClick={onExtend}><Link2 size={15} /></IconButton>
      <IconButton label="Save frame" tip="Save frame: the frame on screen, as an image in your library" disabled={!t.durationMs || saving} onClick={onSaveFrame}>
        <Camera size={15} />
      </IconButton>
    </div>
  );
}
