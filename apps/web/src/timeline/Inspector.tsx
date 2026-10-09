import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, ImagePlus, Music, Trash2, Wand2, X } from "lucide-react";
import { mostFromMs, musicPlan, secondsInput } from "@afflatus/core";
import { api, thumbUrl, type Clip, type RecipeInfo, type RunningJob, type Take, type Timeline, type TimelinePatch } from "../api";
import { useEntities, useRecipes, useSetup } from "../data";
import { WritingHelp } from "../WritingHelp";
import { appendTo } from "../promptText";
import { LookBar, lookWords } from "../LookBar";
import { FormModel } from "../ModelLoad";
import { about, aboutMs, clock, phaseLabel, recipeLabel } from "../format";
import { Picker } from "../PictureField";
import { Form, mainTextOf } from "../RecipeForm";
import { CardPrompt } from "../recipeForm/Part";
import { CastPictures } from "../castPictures";
import { Select } from "../Select";
import { AutoText, Bar, Button, Chip, cx, ErrorNote, fieldClass, Help, NumberBox, PanelEdge, SectionTitle, Segmented, Toggle, TwoStep } from "../ui";
import { FieldRow } from "../fields";
import { RangeSlider } from "../RangeSlider";
import { Kbd } from "../Keys";
import { usePanelWidth } from "../store";
import { Slider } from "../Slider";
import { Wave } from "./track/Wave";
import { fileVersion, otherShape, pinInputs, roomOf, shapeOf, type ShownPatch } from "./model";
import { change, DRIFT, driftOf, driftWords, past, pct, runSeries, runTicks, signed, type RunPoint } from "./lookDrift";
import { DRAG_PICTURE, useDropZone } from "../dragging";
import { projectForNew } from "../project";

/** A slider that says its value while it moves and saves it when it is let go. */
function Slide({ label, value, min = 0, max, step = 1, show, onCommit }: { label: string; value: number; min?: number; max: number; step?: number; show(value: number): string; onCommit(value: number): void }) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = (v: number) => {
    if (v !== value) onCommit(v);
    setLocal(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="font-mono text-ink-2">{show(shown)}</span>
      </span>
      <Slider box={false} label={label} min={min} max={max} step={step} value={shown} format={show} onChange={setLocal} onCommit={commit} />
    </div>
  );
}

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
  const measure = useQuery({ queryKey: ["motion", m.asset.id], queryFn: () => api.motion(m.asset.id), staleTime: Infinity, retry: 0 });
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
export function MusicPanel({ timeline, onEdit }: { timeline: Timeline; onEdit(patch: TimelinePatch): void }) {
  const m = timeline.music;
  const [picking, setPicking] = useState(false);
  if (!m) return null;
  // the clips it can start with: the ones that play
  const starts = timeline.clips.map((c, i) => ({ id: c.id, n: i + 1, atMs: c.atMs, lengthMs: c.lengthMs })).filter((c) => c.lengthMs > 0);
  const startValue = m.startClip && m.startClip !== starts[0]?.id ? m.startClip : "first";
  return (
    <aside style={{ width: usePanelWidth.getState().width }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <PanelEdge side="left" />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Music size={15} className="text-accent" />
        <span className="font-semibold">Music</span>
        <span className="min-w-0 truncate text-ink-2">{m.asset.name || "an audio file"}{m.asset.durationMs ? ` · ${clock(m.asset.durationMs)}` : ""}</span>
      </div>
      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto p-4">
        <span className="text-ink-2">Plays under the whole video. Drop another audio file on the music track to replace it.</span>
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
        {m.asset.durationMs && m.asset.durationMs < timeline.durationMs ? <span className="text-xs text-ink-2">It is shorter than the video: it stops at {clock(m.asset.durationMs)}.</span> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setPicking(true)}>Choose another audio file</Button>
          <Button size="sm" onClick={() => onEdit({ music: { asset: null } })}><Trash2 size={13} /> Remove music</Button>
        </div>
      </div>
      {picking && <Picker title="Music" kind="audio" onClose={() => setPicking(false)} onPick={(asset) => { onEdit({ music: { asset } }); setPicking(false); }} />}
    </aside>
  );
}

/** The selected clip: how it starts, its takes, its sound, its pictures and its form. */
/** Where how many takes a render makes is remembered, per browser. */
const TAKES_KEY = "afflatus.timeline.takes";

export function Inspector({ timeline, clip, index, recipes, stored, whole, why, takesMs, running, busy, error, onInputs, onRecipe, onPatch, onRender, onRemove, onRemoveTake, onStop, onPreview, onDesigner, writing, writeError, onWriteBetween, onSelectClip }: {
  timeline: Timeline;
  clip: Clip;
  index: number;
  recipes: RecipeInfo[];
  /** The clip's form: what was touched. */
  stored: Record<string, unknown>;
  /** The clip's whole form as a render would send it, written or not: what its models are told from. */
  whole: Record<string, unknown> | null;
  /** Why it cannot be rendered right now, in a sentence. */
  why: string | null;
  /** About how long a render of it takes, in ms; null when nothing like it was rendered yet. */
  takesMs: number | null;
  running: RunningJob | null;
  busy: boolean;
  error: string | null;
  onInputs(next: Record<string, unknown>): void;
  onRecipe(id: string): void;
  onPatch(patch: ShownPatch): void;
  /** Render it: `count` takes at once (the first with the form's seed, the others with a fresh one each). */
  onRender(fit: boolean, count: number): void;
  onRemove(): void;
  onRemoveTake(id: string): void;
  /** Stop the render of this clip that is under way, or take it out of the queue. */
  onStop(): void;
  /** Make the clip end where it begins: on its opening picture, or on the first frame of its take. */
  /** A take is hovered: show it in the player without choosing it. */
  onPreview(take: Take | null): void;
  /** Open the designer for this clip. */
  onDesigner(): void;
  /** The designer is writing what happens between the clips around (a clip put between two others). */
  writing?: boolean;
  writeError?: string | null;
  /** Ask the designer to write it (again). */
  onWriteBetween?(): void;
  /** Back to the timeline's own panel (its name, music, cast, where renders land, export): also Escape. */
  onClose?(): void;
  /** Open another clip in the panel (the one before or after, the one it extends); left out, those are not offered. */
  onSelectClip?(id: string): void;
}) {
  const panelWidth = usePanelWidth((st) => st.width);
  const all = useRecipes();
  const setup = useSetup();
  const entities = useEntities();
  const [fit, setFit] = useState(true);
  // how many takes a render makes at once, remembered per browser
  const [count, setCount] = useState<1 | 2 | 3>(() => {
    try {
      const n = Number(localStorage.getItem(TAKES_KEY));
      return n === 2 || n === 3 ? n : 1;
    } catch {
      return 1;
    }
  });
  const pickCount = (n: 1 | 2 | 3) => {
    setCount(n);
    try {
      localStorage.setItem(TAKES_KEY, String(n));
    } catch {
      // the choice is not kept, nothing more
    }
  };
  const takes = aboutMs(takesMs === null ? null : takesMs * count);
  const [picking, setPicking] = useState<"sound" | "start" | "end" | "mid" | null>(null);
  const recipe = recipes.find((r) => r.id === clip.recipe) ?? all.data?.recipes.find((r) => r.id === clip.recipe);
  const status = setup.data?.recipes.find((r) => r.id === recipe?.id);
  const before = index > 0 ? timeline.clips[index - 1] : undefined;
  const after = timeline.clips[index + 1];
  const still = clip.kind === "still";
  const carries = Boolean(before) && clip.joined === "continue" && !still;
  const canCarry = Boolean(recipe?.traits?.continues) || (before?.kind === "still" && Boolean(pinInputs(recipe).start));
  const pins = pinInputs(recipe);
  const opens = !carries && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
  const ends = pins.end && typeof stored[pins.end] === "string" ? (stored[pins.end] as string) : null;
  const through = pins.mid && typeof stored[pins.mid] === "string" ? (stored[pins.mid] as string) : null;
  const midSpec = recipe?.inputs.find((i) => i.id === pins.midAt);
  // what the timeline fills in itself is not asked for in the form: the clips it joins onto, and its pinned pictures (shown above it)
  const form = useMemo(
    () => (recipe ? { ...recipe, inputs: recipe.inputs.filter((i) => i.type !== "clip" && !(i.type === "image" && (i.role === "start" || i.role === "end" || i.role === "mid")) && i.id !== pins.midAt) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recipe],
  );
  const canFit = Boolean(recipe?.traits?.endAnchor && after?.take && after.joined === "continue");
  const take = clip.take;
  const loops = Boolean(ends && (ends === opens));
  /** How much of the take can play at most: its video on the model's grid without the parts it shares with its neighbours (the server's). */
  const room = take ? roomOf(take) : 0;
  const shapes = { tall: "portrait", wide: "landscape", square: "square" } as const;
  const shown = still ? clip.still : take?.asset;
  const misfit = otherShape(clip, timeline) && shown?.width && shown.height && timeline.width && timeline.height
    ? { mine: shapes[shapeOf(shown.width, shown.height)], video: shapes[shapeOf(timeline.width, timeline.height)] }
    : null;
  // a neighbour joined to it at another size (enlarged in its render, or finished, when this one is not): the join shows a change of sharpness
  const sizeStep = (() => {
    const px = (a: { width: number | null; height: number | null } | undefined) => (a?.width && a.height ? a.width * a.height : 0);
    const mine = px(take?.asset);
    if (!mine) return null;
    const odd = [clip.joined === "continue" ? before : undefined, after?.joined === "continue" ? after : undefined]
      .find((n) => n?.take && px(n.take.asset) && Math.max(px(n.take.asset), mine) / Math.min(px(n.take.asset), mine) >= 1.5);
    return odd?.take ? { other: odd.take.asset, before: odd === before } : null;
  })();
  const hasOwn = Boolean(take?.asset.hasSound);
  // how smoothly each take meets the clips around: worked out once there is a choice to make
  const joins = useQuery({
    queryKey: ["joins", clip.id, clip.takes.map((t) => `${t.id}:${t.startMs}:${t.endMs}`).join(","), before?.take?.id ?? before?.still?.id ?? "-", after?.take?.id ?? after?.still?.id ?? "-"],
    queryFn: () => api.joins(clip.id),
    enabled: clip.takes.length > 1 && Boolean(before || after),
    staleTime: Infinity,
  });
  const joinOf = (takeId: string) => joins.data?.items.find((j) => j.take === takeId);
  const worst = (j: { in: number | null; out: number | null } | undefined) => Math.max(j?.in ?? 0, j?.out ?? 0);
  const smoothest = joins.data && clip.takes.length > 1 ? clip.takes.reduce<string | null>((best, t) => (best === null || worst(joinOf(t.id)) < worst(joinOf(best)) ? t.id : best), null) : null;
  const heard = clip.sound === "file" ? "file" : clip.sound === "muted" && hasOwn ? "muted" : "own";

  // ---- what the clip got (its takes, how much of the one that plays is used, how it looks) and its pinned
  // frames: above the form for a clip with no form; inside it otherwise, as its Takes chapter and in Inputs
  const inForm = Boolean(!still && form && recipe);
  const takesInner = clip.takes.length > 0 ? <TakeList clip={clip} take={take} joinOf={joinOf} smoothest={smoothest} onPreview={onPreview} onPatch={onPatch} onRemoveTake={onRemoveTake} /> : null;
  const takesHelp = clip.takes.length > 1 ? `Hover a take to preview it, click to make it play.${joins.data ? " The join figures say how much the picture jumps at In and at Out (×1 = like the clip's own motion; from ×2.5 the catch shows); the smoothest is marked." : joins.isFetching ? " Measuring the joins…" : ""}` : "Each render adds a take; the one you pick plays.";
  const durationInner = still || take ? <Duration clip={clip} take={take} room={room} rendered={Boolean(recipe)} onPatch={onPatch} /> : null;
  const lookInner = take?.measure && !still ? <LookTable timeline={timeline} index={index} take={take} onSelectClip={onSelectClip} /> : null;
  const pinnedInner = recipe && !still && (pins.start || pins.end) ? <PinnedFrames stored={stored} pins={pins} frames={{ opens, ends, through, loops, carries }} midDefault={midSpec?.type === "number" ? midSpec.default : 2.5} onInputs={onInputs} onPick={setPicking} /> : null;
  const pinHelp = `${carries && pins.start ? `It extends clip ${index}, so it needs no first frame. ` : ""}Or drop an image on the clip: near its start for the first frame, near its end for the last frame${pins.mid ? ", in the middle for a keyframe" : ""}.${take ? " A pinned frame counts from the next take." : ""}`;
  const playing = take ? clip.takes.findIndex((t) => t.id === take.id) + 1 : 0;
  const takesLead = inForm && (takesInner || durationInner) ? {
    id: "takes",
    title: "Takes",
    // for the part's ?, once the form's lead passes it on (the rows' tips say it meanwhile)
    help: takesHelp,
    summary: take ? `take ${playing} of ${clip.takes.length} plays · ${(clip.lengthMs / 1000).toFixed(1)} s${take.trimStartMs > 0 || take.trimEndMs > 0 ? " · trimmed" : ""}` : "none yet",
    node: (
      <div className="flex flex-col gap-3">
        {takesInner}
        {durationInner}
        {lookInner}
      </div>
    ),
  } : undefined;
  const pinWords = [opens && "first frame", through && "keyframe", ends && "last frame"].filter(Boolean).join(", ");
  const framesExtra = inForm && pinnedInner ? {
    summary: pinWords ? `pinned ${pinWords}` : "",
    node: (
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold">Pinned frames<Help text={pinHelp} /></span>
        {pinnedInner}
      </div>
    ),
  } : undefined;

  return (
    <aside data-designer-stays style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel">
      <PanelEdge side="left" />
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex items-start gap-2">
          {/* its number and what it is, wrapping as one line: the prompt is in the form below, not said twice */}
          <div className="flex min-w-0 grow flex-wrap items-center gap-1.5 pt-0.5">
            <span className="mr-0.5 flex h-6 shrink-0 items-center rounded-[7px] bg-accent-wash px-2 text-xs font-bold text-accent uppercase">{still ? "Still" : "Clip"} {index + 1}</span>
            <Chip tip={clip.lengthMs && shown?.width && shown.height ? "How long it plays · its size in pixels" : undefined}>
              {clip.lengthMs ? <span className="font-mono">{(clip.lengthMs / 1000).toFixed(1)} s{shown?.width && shown.height ? ` · ${shown.width}×${shown.height}` : ""}</span> : "not rendered yet"}
            </Chip>
            {carries && before && (
              <Chip tone="link" onClick={onSelectClip ? () => onSelectClip(before.id) : undefined} tip={`Its motion carries on from clip ${index}${onSelectClip ? ": open it" : ""}`}>
                extends clip {index}{onSelectClip && <ArrowUpRight size={12} />}
              </Chip>
            )}
            {!still && !recipe && take && (
              <Chip>imported video<Help title="Imported video" text="It can be trimmed, and a new clip can extend from any of its frames. It cannot be re-rendered, unless you choose a model to render in its place, under Model." /></Chip>
            )}
            {misfit && (
              <Chip tone="warn">{misfit.mine} in a {misfit.video} video<Help title="Another shape" text={`This ${still ? "still" : "clip"} is ${misfit.mine}, the video is ${misfit.video}. ${clip.fill ? "It fills the frame: its edges are cropped." : "It is letterboxed: shown whole, with bars."} Fill frame switches between the two.`} /></Chip>
            )}
            {sizeStep && take && (
              <Chip tone="warn">sharpness jumps at the join<Help title="Another size" text={`This clip is ${take.asset.width} × ${take.asset.height}, the clip ${sizeStep.before ? "before" : "after"} ${sizeStep.other.width} × ${sizeStep.other.height}: one was enlarged and the other not, so the join shows a change of sharpness. Finish all clips (the Finish button above the timeline) to bring every clip to one size the same way, or render both alike.`} /></Chip>
            )}
          </div>
          {onSelectClip && (
            <>
              <button type="button" aria-label="Previous clip" data-tip={before ? `Clip ${index}` : "This is the first clip"} disabled={!before} onClick={() => before && onSelectClip(before.id)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40">
                <ChevronLeft size={15} />
              </button>
              <button type="button" aria-label="Next clip" data-tip={after ? `Clip ${index + 2}` : "This is the last clip"} disabled={!after} onClick={() => after && onSelectClip(after.id)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40">
                <ChevronRight size={15} />
              </button>
            </>
          )}
          <TwoStep title="Remove from timeline" icon={<Trash2 size={14} />} note={still ? "The image stays in your library." : "Its videos stay in your library."} yes="Remove" onYes={onRemove} className="h-7! w-7! rounded-lg text-warn-ink! hover:bg-warn-wash!" />
        </div>
      </div>

      <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto p-4">
        {still && clip.still && (
          <>
            <img src={thumbUrl(clip.still.id)} alt={clip.still.name} className="max-h-56 self-start rounded-lg" />
            <span><Button onClick={() => onPatch({ animate: true })}>Image to video (i2v)</Button></span>
          </>
        )}

        {/* how it joins the clip before is on the track: the dot between them switches cut and extend; only a broken join is said here */}
        {before && !still && clip.join === "stale" && (
          <div className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-wash p-3">
            <span className="font-semibold text-warn-ink">This clip no longer follows clip {index}</span>
            <span className="text-xs text-ink-2">Clip {index} changed after this one was rendered, so {before.kind === "still" ? "its first frame is no longer that image" : "the motion jumps between them"}.</span>
            <span className="flex flex-wrap gap-1.5">
              {recipe && <Button size="sm" tone="danger" disabled={Boolean(why) || busy || Boolean(clip.job)} onClick={() => onRender(fit, count)}>Re-render{takes ? ` · ${takes}` : ""}</Button>}
              <Button size="sm" onClick={() => onPatch({ joined: "cut" })}>Keep as a cut</Button>
            </span>
          </div>
        )}

        {clip.failed && !clip.job && <ErrorNote>The last render failed: {clip.failed}</ErrorNote>}

        {misfit && <Toggle on={clip.fill} onChange={(fill) => onPatch({ fill })} label="Fill frame (crop)" note={clip.fill ? "its edges are cropped" : "letterboxed: shown whole, with bars"} />}

        {!inForm && takesInner && <div className="flex flex-col gap-2"><span className="flex items-center gap-1.5"><SectionTitle>Takes</SectionTitle><Help title="Takes" text={takesHelp} /></span>{takesInner}</div>}
        {!inForm && durationInner}
        {!inForm && lookInner}
        {!inForm && pinnedInner && <div className="flex flex-col gap-2"><SectionTitle>Pinned frames</SectionTitle>{pinnedInner}</div>}

        {!still && (
          <>
            {(() => {
              const picker = (
                <Select
                  label="Model"
                  value={recipe?.id ?? ""}
                  onChange={onRecipe}
                  placeholder={recipes.length ? "Choose a model for this clip" : "No video model yet: import a workflow"}
                  options={recipes.map((r) => ({ value: r.id, label: recipeLabel(all.data?.families.find((f) => f.id === r.family)?.name, r.title), detail: r.summary }))}
                />
              );
              // nothing renders it yet: only the choice of what does
              if (!form || !recipe) return <div className="flex flex-col gap-1.5"><div className="text-xs font-semibold">Model</div>{picker}</div>;
              const main = mainTextOf(form);
              const written = main ? String(stored[main.id] ?? "") : "";
              const cast = clip.look === null ? (
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs font-semibold">Cast and places</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{lookWords(timeline.look, entities.data?.items ?? []) || "Nobody yet"}</span>
                    <span className="text-xs text-ink-2">from the timeline</span>
                    <Button size="sm" onClick={() => onPatch({ look: timeline.look ?? { cast: [], style: null } })}>Change for this clip</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <LookBar title="Cast and places, for this clip only" look={clip.look} onChange={(look) => onPatch({ look })} recipe={recipe} input={stored} />
                  <span><Button size="sm" onClick={() => onPatch({ look: null })}>Use the timeline's again</Button></span>
                </div>
              );
              // a clip that joins its neighbours and is not rendered yet: what matters for the join first, the whole form folded under it
              const nextJoined = Boolean(after && after.joined === "continue" && after.take);
              // the Join view is for a clip put between two others: something to arrive at, not merely a clip that extends the one before
              const joins = !take && (nextJoined || Boolean(ends));
              const leftFrame = opens ? thumbUrl(opens) : carries && before ? (before.kind === "still" && before.still ? thumbUrl(before.still.id) : before.take ? `/api/assets/${before.take.asset.id}/peek?at=${Math.max(0, Math.round(before.take.endMs - 20))}&h=160&v=${fileVersion(before.take.asset)}` : null) : null;
              const rightFrame = ends ? thumbUrl(ends) : nextJoined && after?.take ? `/api/assets/${after.take.asset.id}/peek?at=${Math.round(after.take.startMs)}&h=160&v=${fileVersion(after.take.asset)}` : null;
              const startsHow = carries ? `Extends clip ${index}: its motion carries in` : opens ? `Opens on a picture` : "Starts on its own";
              // its own pinned last frame wins over landing on the clip after (the server skips the landing then)
              const endsHow = ends ? "ends on a picture" : nextJoined ? `ends where clip ${index + 2} begins` : "ends free";
              const seconds = secondsInput(form.inputs);
              const landing = recipe.inputs.find((i) => i.id === "landing" && i.type === "choice");
              const landingOptions = landing && landing.type === "choice" && Array.isArray(landing.options) ? landing.options : [];
              // the prompt as a card of its own, as in the Studio: the same cards, spaced alike
              const formElement = (
                  <CastPictures recipe={form} input={whole ?? stored} look={clip.look ?? timeline.look}>
                  <CardPrompt.Provider value>
                  <Form
                    key={`${clip.id}:${form.id}`}
                    recipe={form}
                    given={carries ? { previous: true } : undefined}
                    status={status}
                    stored={stored}
                    onChange={(input, value) => onInputs({ ...stored, [input]: value })}
                    onClear={(inputs) => onInputs(Object.fromEntries(Object.entries(stored).filter(([k]) => !inputs.includes(k))))}
                    made={picker}
                    madeSummary={recipeLabel(all.data?.families.find((f) => f.id === recipe.family)?.name, recipe.title)}
                    look={cast}
                    lookSummary={lookWords(clip.look ?? timeline.look, entities.data?.items ?? []) + (clip.look === null && timeline.look ? " (from the timeline)" : "")}
                    lead={takesLead}
                    frameExtra={framesExtra}
                    helpers={
                      <WritingHelp
                        recipe={form}
                        text={written}
                        // a clip that follows the timeline's cast gets a look of its own with the first snippet ticked: the timeline's, plus it
                        look={clip.look ?? timeline.look}
                        onLook={(look) => onPatch({ look })}
                        onDesigner={onDesigner}
                        onInsert={(snippet) => main?.type === "prompt" && onInputs({ ...stored, [main.id]: appendTo(written, snippet, main.style) })}
                      />
                    }
                  />
                  </CardPrompt.Provider>
                  </CastPictures>
              );
              if (!joins) return <div className="flex flex-col gap-2.5">{formElement}</div>;
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-wash/30 p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{leftFrame ? <img src={leftFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
                      <div className="flex min-w-0 grow flex-col gap-0.5 text-xs">
                        <span className="font-semibold">Join</span>
                        <span className="text-ink-2">{startsHow} · {endsHow}.</span>
                      </div>
                      <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-raised">{rightFrame ? <img src={rightFrame} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="text-[10px] text-ink-3">—</span>}</div>
                    </div>
                    {main && (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold">What happens <span className="font-normal text-ink-2">· between the two</span></span>
                        <AutoText rows={3} value={written} disabled={writing} placeholder={main.type === "prompt" ? main.placeholder ?? "What happens in this stretch" : ""} onChange={(e) => onInputs({ ...stored, [main.id]: e.target.value })} className={cx(fieldClass, "w-full py-2 disabled:opacity-60")} />
                      </label>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {writing ? (
                        <span className="animate-pulse text-ink-2">The designer is writing what happens between…</span>
                      ) : (
                        <>
                          {onWriteBetween && (nextJoined || ends) && <Button size="sm" onClick={onWriteBetween} data-tip="The designer writes the stretch from how the clip before ends to how the clip after starts, in the clip's time."><Wand2 size={13} /> {written ? "Designer: write it again" : "Designer: write it"}</Button>}
                          <Button size="sm" onClick={onDesigner}>Talk to the designer</Button>
                        </>
                      )}
                      {writeError && <span className="text-warn-ink">{writeError}</span>}
                    </div>
                    {seconds && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">Duration</span>
                        <NumberBox label="Duration" value={Number(stored[seconds.id] ?? seconds.default)} min={seconds.min} max={seconds.max} step={seconds.step} unit=" s" onCommit={(v) => onInputs({ ...stored, [seconds.id]: v })} />
                      </div>
                    )}
                    {landing && nextJoined && landingOptions.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="flex items-baseline justify-between text-xs font-semibold">Landing <span className="font-normal text-ink-2">frames of clip {index + 2} it lands on</span></span>
                        <Segmented label="Landing" value={String(stored.landing ?? (landing.type === "choice" ? landing.default : "22"))} onChange={(v) => onInputs({ ...stored, landing: v })} options={landingOptions.map((o) => ({ value: o, label: o === "5" ? "Tight · 5" : o === "22" ? "Normal · 22" : o === "39" ? "Long · 39" : o }))} />
                      </div>
                    )}
                  </div>
                  <details className="group">
                    <summary className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-ink-2 hover:text-ink"><ChevronDown size={13} className="transition-transform group-open:rotate-180" /> All settings</summary>
                    {/* the cards at the panel's full width, under the switch: not boxed a second time */}
                    <div className="flex flex-col gap-2.5 pt-3">{formElement}</div>
                  </details>
                </div>
              );
            })()}
          </>
        )}
        {(take || still) && (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5"><SectionTitle>Audio</SectionTitle>{!still && !hasOwn && heard !== "file" && <Help title="No audio of its own" text="This clip has no audio of its own. Drop an audio file on it, or choose one." />}</span>
            <Segmented
              label="Audio source"
              value={heard}
              options={[{ value: "own", label: still ? "Silent" : hasOwn ? "Own audio" : "Silent" }, { value: "file", label: "Audio file" }, ...(hasOwn ? [{ value: "muted" as const, label: "Muted" }] : [])]}
              onChange={(v) => (v === "file" ? (clip.soundAsset ? onPatch({ sound: "file" }) : setPicking("sound")) : onPatch({ sound: v }))}
            />
            {heard === "file" && clip.soundAsset && (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-raised py-1.5 pr-1.5 pl-3">
                <Music size={13} className="shrink-0 text-ink-2" />
                <span className="min-w-0 grow truncate">{clip.soundAsset.name || "Audio file"}</span>
                <Button size="sm" onClick={() => setPicking("sound")}>Change</Button>
              </div>
            )}
            {(heard === "file" || (heard === "own" && hasOwn)) && <Slide label="Volume" value={clip.volume} max={100} show={(v) => `${v}%`} onCommit={(volume) => onPatch({ volume })} />}
          </div>
        )}

      </div>

      {recipe && !still && (
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-line px-3.5 py-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {why && <div className="text-xs text-warn-ink">{why} {why.includes("ComfyUI") || why.includes("model") ? <Link href={why.includes("ComfyUI") ? "/settings" : "/settings/models"} className="font-semibold underline">Open Settings</Link> : null}</div>}
          {/* a pinned last frame wins over the landing (the server skips it): shown off, the stored choice kept for when the pin goes */}
          {canFit && (
            <div className="flex flex-col gap-1">
              <Toggle on={fit && !ends} onChange={setFit} disabled={Boolean(ends)} label={`End where clip ${index + 2} begins`} note={ends ? "off: this clip's own last frame is pinned" : "so that clip need not be redone"} />
            </div>
          )}
          {!clip.job && (
            <div className="flex items-center gap-2.5">
              <span className="grow font-semibold">Takes at once</span>
              <Segmented<"1" | "2" | "3"> label="Takes at once" size="sm" oneLine value={String(count) as "1" | "2" | "3"} onChange={(v) => pickCount(Number(v) as 1 | 2 | 3)} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }]} className="[&>button]:w-[34px] [&>button]:px-0" />
            </div>
          )}
          {whole && !clip.job && <FormModel recipe={recipe} input={whole} look={clip.look ?? timeline.look} />}
          {clip.job ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{running ? phaseLabel(running.phase) : "Queued"}</span>
                <span className="text-xs text-ink-2">{running?.steps ? `step ${running.step} of ${running.steps}` : ""}{running?.eta ? ` · ${about(running.eta)}` : ""}</span>
              </div>
              <Bar value={(running?.progress ?? 0) * 100} />
              <Button size="sm" className="self-start" onClick={onStop} data-tip={running ? "Stop this render. Nothing is added; the clip keeps the takes it has." : "Remove it from the queue."}>
                {running ? "Stop render" : "Remove from queue"}
              </Button>
            </div>
          ) : (
            <Button tone="primary" className="h-11 text-sm" disabled={Boolean(why) || busy} onClick={() => onRender(fit, count)} data-tip={count > 1 ? "The first take keeps the form's seed; the others get a fresh seed each. Pick the best in Takes." : undefined}>
              {busy ? "Sending…" : `${count > 1 ? `Render ${count} takes` : take ? "New take" : "Render this clip"}${takes ? ` · ${takes}` : ""}`}
              {/* Ctrl+Enter renders one take: said only when that is what the button does */}
              {!busy && count === 1 && <Kbd>Ctrl ↵</Kbd>}
            </Button>
          )}
        </div>
      )}

      {picking === "sound" && <Picker title={`Audio of clip ${index + 1}`} kind="audio" onClose={() => setPicking(null)} onPick={(soundAsset) => { onPatch({ soundAsset }); setPicking(null); }} />}
      {(picking === "start" || picking === "end" || picking === "mid") && (
        <Picker
          title={picking === "start" ? "First frame" : picking === "end" ? "Last frame" : "Keyframe"}
          onClose={() => setPicking(null)}
          onPick={(asset) => {
            onInputs({ ...stored, [pins[picking]!]: asset });
            setPicking(null);
          }}
        />
      )}
    </aside>
  );
}

/**
 * How the take looks, measured on its own frames when it was rendered, and how far it has moved from the clip
 * before and from the first clip of the run it flows on from (clips joined one after the other). For catching a
 * chain that slides darker, softer, duller or slower; a few per cent is the model's own variation. Under it, the
 * run at a glance: sharpness and brightness over every clip of it (see lookDrift).
 */
function LookTable({ timeline, index, take, onSelectClip }: { timeline: Timeline; index: number; take: Take; onSelectClip?(id: string): void }) {
  const [open, setOpen] = useState(false);
  const clips = timeline.clips;
  const m = take.measure!;
  const d = driftOf(clips, index);
  const before = d ? clips[d.before]?.take?.measure ?? null : null;
  const first = d ? clips[d.start]?.take?.measure ?? null : null;
  // one column when the clip before is the run's start: both say the same
  const cols = d
    ? d.same
      ? [{ head: `vs clip ${d.start + 1}`, tip: `Against clip ${d.start + 1}: the one before, and the first of this run`, of: first, by: d.whole }]
      : [{ head: `vs clip ${d.before + 1}`, tip: `Against clip ${d.before + 1}, the one before`, of: before, by: d.hop }, { head: `vs clip ${d.start + 1}`, tip: `Against clip ${d.start + 1}, the first of this run`, of: first, by: d.whole }]
    : [];
  const diff = (a: number | null | undefined, b: number | null | undefined, unit = "") => (a == null || b == null ? null : `${signed(a - b)}${unit}`);
  const share = (x: number | null) => (x == null ? null : pct(x));
  type Cell = { text: string | null; bad?: boolean };
  type Row = { label: string; value: string; vs: Cell[]; why: string; bad?: boolean };
  const each = (f: (c: (typeof cols)[number]) => Cell) => cols.map(f);
  const rows: Row[] = [
    { label: "Brightness", value: m.luma.toFixed(0), vs: each((c) => ({ text: share(c.by.luma), bad: past("luma", c.by.luma) })), why: "Mean luma of the frames, 0 to 255." },
    { label: "Sharpness", value: m.sharp.toFixed(2), vs: each((c) => ({ text: share(c.by.sharp), bad: past("sharp", c.by.sharp) })), why: "The mean absolute Laplacian of a small grey copy: 0 is flat, several units is crisp. A chain continued from exact latents loses it hop after hop." },
  ];
  if (m.pace != null) rows.push({ label: "Pace", value: m.pace.toFixed(1), vs: each((c) => ({ text: share(c.by.pace), bad: past("pace", c.by.pace) })), why: `Mean frame-to-frame change, the ruler's motion figure. H3 tends to slow down after each hand-over; past ${pct(DRIFT.pace)} it reads as slow motion.` });
  if (m.chroma) rows.push({ label: "Colour", value: `${signed(m.chroma.u)} / ${signed(m.chroma.v)}`, vs: each((c) => ({ text: c.by.colour == null ? null : `±${c.by.colour.toFixed(1)}`, bad: past("colour", c.by.colour) })), why: `Mean chroma against neutral, as U / V: U is blue (+) to yellow (−), V red (+) to green (−). Against another clip: how far the colour moved in U/V; past ${DRIFT.colour} a cast shows. A warming or greying chain shows here.` });
  if (m.handover != null) rows.push({ label: "Run-up end", value: `×${m.handover.toFixed(1)}`, vs: each(() => ({ text: null })), bad: m.handover > DRIFT.handover, why: "A continuation: how much the picture jumps where the run-up (the frames shared with the clip before; in a seamless take, that clip's own frames) ends and this clip's own frames begin, against its own motion right after. ×1 carries on; past ×3 the model stepped away from its guide and the join shows: re-render the take." });
  // the rest: read when something looks off, not every time
  const more: Row[] = [];
  if (m.range) more.push({ label: "Range", value: `${m.range.low.toFixed(0)}–${m.range.high.toFixed(0)}`, vs: each((c) => ({ text: c.of?.range ? diff(m.range!.high - m.range!.low, c.of.range.high - c.of.range.low) : null })), why: "Where the darkest and the brightest tenth of the picture sit. A shrinking range is crushed blacks or clipped whites." });
  if (m.flicker != null) more.push({ label: "Flicker", value: `${m.flicker.toFixed(1)} %`, vs: each((c) => ({ text: diff(m.flicker, c.of?.flicker, " pt") })), why: "How much the frame's mean brightness changes from one frame to the next. Exposure flicker is a known continuation artefact that averages hide." });
  if (m.voice != null) more.push({ label: "Voice", value: `${m.voice} Hz`, vs: each((c) => ({ text: share(change(m.voice, c.of?.voice)) })), why: "Where the sound's energy sits (its spectral centroid). A voice carried over several clips dulls before it changes: it drifts down." });
  if (m.drift) more.push({ label: "Run-up width", value: `×${m.drift.width.toFixed(3)}`, vs: each(() => ({ text: null })), why: "A join made in the latent: how wide the regenerated run-up came out against the latent it was guided by. 1.000 is the same; a chain of exact latents reads 1.02 to 1.05 at every hop, which is the drift." });
  const warning = driftWords(d);
  const n = clips[index]!.takes.findIndex((t) => t.id === take.id) + 1;
  const note = d
    ? `Measured on this take's own frames when it was rendered. "vs clip" is the change against that clip's take: the one before, and the first of this run (clip ${d.start + 1}); a few per cent is the model's own variation. Warned past ${pct(DRIFT.luma)} brightness, ${pct(DRIFT.sharp)} sharpness, ${pct(DRIFT.pace)} pace, a colour shift of ${DRIFT.colour}. Hover a row for what it means.`
    : "Measured on this take's own frames when it was rendered. Hover a row for what it means.";
  const grid = { gridTemplateColumns: `88px repeat(${cols.length + 1}, minmax(0, 1fr))` };
  const line = (r: Row) => (
    <div key={r.label} data-tip={r.why} className="contents">
      <span className="truncate py-1 text-ink-2">{r.label}</span>
      <span className={cx("truncate py-1 text-right font-mono tabular-nums", r.bad ? "text-warn" : "text-ink")}>{r.value}</span>
      {r.vs.map((c, i) => <span key={i} className={cx("truncate py-1 text-right font-mono tabular-nums", c.text == null ? "text-ink-3" : c.bad ? "text-warn" : "text-ink-2")}>{c.text ?? "—"}</span>)}
    </div>
  );
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="grow truncate text-[11px] font-bold tracking-[.08em] text-ink-3 uppercase">Look · take {n} of clip {index + 1}</span>
        {warning && <Chip tone="warn" className="font-mono">{warning}</Chip>}
        {m.handover != null && m.handover > DRIFT.handover && <Chip tone="warn" className="font-mono" tip="The model stepped away from its guide where the run-up ends: the join shows. Re-render the take.">run-up end ×{m.handover.toFixed(1)}</Chip>}
        <Help title="Look" text={note} />
      </div>
      <div className="px-3 pt-1.5 pb-1 text-xs">
        <div className="grid items-center gap-x-2.5" style={grid}>
          <span className="border-b border-line pb-1" />
          <span className="border-b border-line pb-1 text-right text-[11px] font-semibold text-ink-3">this take</span>
          {cols.map((c) => <span key={c.head} data-tip={c.tip} className="truncate border-b border-line pb-1 text-right text-[11px] font-semibold text-ink-3">{c.head}</span>)}
          {rows.map(line)}
          {open && more.map(line)}
        </div>
        {more.length > 0 && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1 flex w-full items-center gap-1 border-t border-line py-1.5 text-left text-xs text-ink-3 hover:text-ink">
            <ChevronDown size={13} className={cx("shrink-0 transition-transform", open && "rotate-180")} />
            <span className="truncate">{open ? "Fewer figures" : more.map((r) => r.label).join(", ")}</span>
          </button>
        )}
      </div>
      <RunChart clips={clips} index={index} onSelectClip={onSelectClip} />
    </div>
  );
}

/** The chart's drawing box: as wide as the card, scaled with it; any number of clips fits the same width. */
const CHART = { w: 440, h: 76, left: 10, right: 430, top: 6, bottom: 54, ticks: 70 } as const;

/**
 * The run at a glance: sharpness (accent) and brightness (blue) over every clip of the run, each against the
 * run's start (dashed), this clip marked. Hover a clip for its figures, click to go to it.
 */
function RunChart({ clips, index, onSelectClip }: { clips: Clip[]; index: number; onSelectClip?(id: string): void }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = runSeries(clips, index);
  if (points.length < 2) return null;
  const start = points[0]!.index;
  const values = points.flatMap((p) => [p.sharp, p.luma]).filter((v): v is number => v != null);
  // a run that barely moves stays flat: at least ±5 % of the height around the middle
  let lo = Math.min(1, ...values);
  let hi = Math.max(1, ...values);
  if (hi - lo < 0.1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.05;
    hi = mid + 0.05;
  }
  const step = (CHART.right - CHART.left) / (points.length - 1);
  const xAt = (i: number) => CHART.left + i * step;
  const yAt = (v: number) => CHART.top + ((hi - v) / (hi - lo)) * (CHART.bottom - CHART.top);
  // a line through the measured clips; a clip not measured breaks it
  const path = (pick: (p: RunPoint) => number | null) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = pick(p);
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const at = index - start;
  const here = points[at]!;
  const band = Math.max(6, Math.min(16, step * 0.7));
  const tipOf = (p: RunPoint) => {
    const mm = clips[p.index]?.take?.measure;
    if (!mm) return `clip ${p.index + 1} · not measured`;
    const by = (r: number | null) => (r == null || p.index === start ? "" : ` (${pct(r - 1)})`);
    return `clip ${p.index + 1} · sharpness ${mm.sharp.toFixed(2)}${by(p.sharp)} · brightness ${mm.luma.toFixed(0)}${by(p.luma)}`;
  };
  const anchor = (i: number) => (points.length > 2 && i === 0 ? "start" : points.length > 2 && i === points.length - 1 ? "end" : "middle");
  return (
    <div className="flex flex-col gap-1.5 border-t border-line bg-raised/50 px-3 pt-2.5 pb-2">
      <span className="flex items-center gap-3.5 text-[11px] text-ink-3">
        <span>Along the run · {points.length} clips</span>
        <span className="grow" />
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded-full bg-accent" />sharpness</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded-full bg-picture" />brightness</span>
      </span>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} className="block w-full" role="img" aria-label={`Sharpness and brightness along the ${points.length} clips of this run, against clip ${start + 1}`} onPointerLeave={() => setHover(null)}>
        <line x1={CHART.left} x2={CHART.right} y1={yAt(1)} y2={yAt(1)} stroke="var(--color-line-strong)" strokeDasharray="3 3" />
        <rect x={xAt(at) - band / 2} y={2} width={band} height={CHART.bottom} rx={4} fill="var(--color-accent)" fillOpacity={0.12} />
        {hover !== null && hover !== at && <rect x={xAt(hover) - band / 2} y={2} width={band} height={CHART.bottom} rx={4} fill="var(--color-ink)" fillOpacity={0.07} />}
        <path d={path((p) => p.luma)} fill="none" stroke="var(--color-picture)" strokeWidth={1.6} strokeOpacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path((p) => p.sharp)} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {here.luma != null && <circle cx={xAt(at)} cy={yAt(here.luma)} r={3.5} fill="var(--color-picture)" stroke="var(--color-panel)" strokeWidth={2} />}
        {here.sharp != null && <circle cx={xAt(at)} cy={yAt(here.sharp)} r={4} fill="var(--color-accent)" stroke="var(--color-panel)" strokeWidth={2} />}
        {runTicks(points.length, at, start + 1).map((i) => (
          <text key={i} x={xAt(i)} y={CHART.ticks} fontSize={9.5} textAnchor={anchor(i)} className="font-mono" fill={i === at ? "var(--color-accent)" : "var(--color-ink-3)"}>{points[i]!.index + 1}</text>
        ))}
        {/* one hit area per clip, as wide as its step: a clip of a run of 60 is still easy to hover */}
        {points.map((p, i) => (
          <rect
            key={p.index}
            x={xAt(i) - step / 2}
            y={0}
            width={step}
            height={CHART.h}
            fill="transparent"
            data-tip={tipOf(p)}
            className={onSelectClip && i !== at ? "cursor-pointer" : undefined}
            onPointerEnter={() => setHover(i)}
            onClick={() => {
              if (onSelectClip && i !== at) onSelectClip(clips[p.index]!.id);
            }}
          />
        ))}
      </svg>
      <span className="text-[11px] text-ink-3">dashed: clip {start + 1} · hover a clip for its figures{onSelectClip ? " · click to go to it" : ""}</span>
    </div>
  );
}

/** A place a picture can be dropped on to become a pinned frame: one from the library, or a file from the computer, which goes into the library first. */
function PinDrop({ className, onPick, children }: { className?: string; onPick(id: string): void; children: ReactNode }) {
  const upload = useMutation({ mutationFn: (file: File) => api.upload(file, { project: projectForNew() }), onSuccess: (a) => onPick(a.id) });
  const drop = useDropZone([DRAG_PICTURE], onPick, (file) => file.type.startsWith("image/") && upload.mutate(file));
  return (
    <div {...drop.props} className={cx(className, drop.zone, drop.wanted && "ring-1 ring-accent/50")} data-tip={drop.wanted ? "Drop the picture here" : undefined}>
      {children}
      {upload.isPending && <span className="ml-1 text-xs text-ink-2">Adding…</span>}
    </div>
  );
}

/** A state of a take, on its row: plays (filled), finished, smoothest. */
function TakeChip({ tone, tip, children }: { tone: "accent" | "good" | "neutral"; tip?: string; children: ReactNode }) {
  return (
    <span data-tip={tip} className={cx("flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[11px] font-bold", tone === "accent" ? "bg-accent text-accent-ink" : tone === "good" ? "bg-good/15 text-good" : "bg-hover text-ink-2")}>
      {children}
    </span>
  );
}

/** A clip's takes, one per row, the one that plays marked: hovered, one is previewed in the player; clicked, it plays. Each says how its joins jump, and can be removed. */
function TakeList({ clip, take, joinOf, smoothest, onPreview, onPatch, onRemoveTake }: {
  clip: Clip;
  take: Take | null;
  joinOf(take: string): { in: number | null; out: number | null } | undefined;
  /** The take whose joins jump least, once measured. */
  smoothest: string | null;
  onPreview(take: Take | null): void;
  onPatch(patch: ShownPatch): void;
  onRemoveTake(id: string): void;
}) {
  // ×2.5 and up is a visible catch
  const bad = (v: number) => v >= 2.5;
  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
      {clip.takes.map((t, i) => {
        const on = t.id === take?.id;
        const j = joinOf(t.id);
        // the thumbnail at the take's own shape, 54 px on its long side
        const w = t.asset.width ?? 0;
        const h = t.asset.height ?? 0;
        const thumb = w && h ? (h >= w ? { width: Math.max(24, Math.round((54 * w) / h)), height: 54 } : { width: 54, height: Math.max(24, Math.round((54 * h) / w)) }) : { width: 34, height: 54 };
        return (
          <div
            key={t.id}
            className={cx("group/take flex items-center rounded-[10px]", on ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : "hover:bg-hover")}
            onMouseEnter={() => !on && onPreview(t)}
            onMouseLeave={() => onPreview(null)}
          >
            <button
              type="button"
              aria-pressed={on}
              aria-label={on ? `Take ${i + 1}, the one that plays` : `Play take ${i + 1} instead`}
              data-tip={on ? undefined : "Click to make it play (hovered, it previews)"}
              onFocus={() => !on && onPreview(t)}
              onBlur={() => onPreview(null)}
              onClick={() => {
                onPreview(null);
                if (!on) onPatch({ take: t.id });
              }}
              className="flex min-w-0 grow items-center gap-2.5 p-1.5 text-left"
            >
              <img src={thumbUrl(t.asset.id)} alt="" loading="lazy" style={thumb} className="shrink-0 rounded-md bg-raised object-cover" />
              <span className="flex min-w-0 grow flex-col gap-[3px]">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-bold">Take {i + 1}</span>
                  {on && <TakeChip tone="accent">plays</TakeChip>}
                  {t.finishedFrom && <TakeChip tone="good" tip={`The finished version of take ${Math.max(1, clip.takes.findIndex((x) => x.id === t.finishedFrom) + 1)}: the same clip, brought to its final quality (${t.asset.width} × ${t.asset.height})`}>finished</TakeChip>}
                  {smoothest === t.id && clip.takes.length > 1 && <TakeChip tone="neutral" tip="The smoothest joins of the takes">smoothest</TakeChip>}
                </span>
                {j && (j.in !== null || j.out !== null) && (
                  <span className="font-mono text-[11px] text-ink-3" data-tip="How much the picture jumps at each join, against the clip's own motion: ×1 moves like the clip, ×2.5 and up is a visible catch.">
                    join{j.in !== null && <> in <span className={bad(j.in) ? "text-warn-ink" : "text-good"}>×{j.in}</span></>}{j.in !== null && j.out !== null && " ·"}{j.out !== null && <> out <span className={bad(j.out) ? "text-warn-ink" : "text-good"}>×{j.out}</span></>}
                  </span>
                )}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-ink-2">{((t.endMs - t.startMs) / 1000).toFixed(1)} s</span>
            </button>
            <button type="button" aria-label={`Remove take ${i + 1}`} data-tip="Remove this take. Its video goes to the bin with it; Undo brings both back." onClick={() => onRemoveTake(t.id)} className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-hover/take:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** How long a still is held; how long a take plays and how much is trimmed off its start, with Reset. */
function Duration({ clip, take, room, rendered, onPatch }: { clip: Clip; take: Take | null; room: number; rendered: boolean; onPatch(patch: ShownPatch): void }) {
  // the pair while a knob moves, in seconds from the start of what can play
  const [moving, setMoving] = useState<{ from: number; to: number } | null>(null);
  if (clip.kind === "still") {
    return (
      <FieldRow label="Held for">
        <NumberBox label="How long the still is held, in seconds" value={clip.lengthMs / 1000} min={0.5} max={60} step={0.1} unit="s" onCommit={(v) => onPatch({ stillMs: Math.round(v * 1000) })} />
      </FieldRow>
    );
  }
  if (!take) return null;
  // what can play counts from here: the take's start before its trim
  const base = take.startMs - take.trimStartMs;
  const from = take.trimStartMs / 1000;
  const to = (take.trimStartMs + clip.lengthMs) / 1000;
  const max = Math.max(to, (take.headMs + room - base) / 1000);
  const shown = moving ?? { from, to };
  // asked by what is seen: the server works out the trim, whatever a landing or a seamless join moves
  const commit = (f: number, t: number) => {
    setMoving(null);
    const trimStartMs = Math.round(f * 1000);
    const startMoved = trimStartMs !== take.trimStartMs;
    const endMoved = Math.abs(t - to) > 0.0005;
    if (startMoved || endMoved) onPatch({ ...(startMoved ? { trimStartMs } : {}), ...(endMoved ? { shownToMs: base + Math.round(t * 1000) } : {}) });
  };
  return (
    <FieldRow label="Plays" note={`Drag either end, or the clip's edges on the timeline. This trims what plays${rendered ? "; to make the clip itself longer, change Duration in Output and render a new take" : ""}.`}>
      <RangeSlider label="Plays" from={shown.from} to={shown.to} min={0} max={max} step={0.1} gap={0.3} format={(v) => `${v.toFixed(1)} s`} onChange={(f, t) => setMoving({ from: f, to: t })} onCommit={commit} />
      <span className="flex items-center justify-between gap-2 font-mono text-[11.5px] text-ink-2">
        <span>from {shown.from.toFixed(1)} s</span>
        {(take.trimStartMs > 0 || take.trimEndMs > 0) && <Button size="sm" className="font-sans" onClick={() => onPatch({ trimStartMs: 0, trimEndMs: 0 })}>Reset trim</Button>}
        <span>{(shown.to - shown.from).toFixed(1)} of {(room / 1000).toFixed(1)} s</span>
      </span>
    </FieldRow>
  );
}

/** The pictures pinned on a clip's form: its first and last frame and a keyframe, each changed, dropped on or removed. */
function PinnedFrames({ stored, pins, frames, midDefault, onInputs, onPick }: {
  stored: Record<string, unknown>;
  pins: ReturnType<typeof pinInputs>;
  /** The pictures pinned now (its opening one only when it does not carry on from the clip before), whether it loops, whether it carries on. */
  frames: { opens: string | null; ends: string | null; through: string | null; loops: boolean; carries: boolean };
  midDefault: number;
  onInputs(next: Record<string, unknown>): void;
  onPick(where: "start" | "end" | "mid"): void;
}) {
  const { opens, ends, through, loops, carries } = frames;
  const without = (id: string | undefined) => Object.fromEntries(Object.entries(stored).filter(([k]) => k !== id));
  const setPicking = onPick;
  return (
    <div className="flex flex-col gap-2">
            {[{ where: "start" as const, id: opens, input: pins.start, text: "First frame" }, { where: "end" as const, id: ends, input: pins.end, text: loops ? "Last frame, same as the first: it loops" : "Last frame" }].map((p) =>
              p.id ? (
                <PinDrop key={p.where} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [p.input!]: id })}>
                  <img src={thumbUrl(p.id)} alt="" className="h-11 w-11 rounded-md object-cover" />
                  <span className="grow">{p.text}</span>
                  <Button size="sm" onClick={() => setPicking(p.where)}>Change</Button>
                  <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(p.input))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
                </PinDrop>
              ) : null,
            )}
            {through && pins.mid && pins.midAt && (
              <PinDrop className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}>
                <img src={thumbUrl(through)} alt="" className="h-11 w-11 rounded-md object-cover" />
                <span className="grow">Keyframe at</span>
                <NumberBox label="When the clip reaches this keyframe, in seconds" value={Number(stored[pins.midAt] ?? midDefault)} min={0.5} max={14.5} step={0.5} unit="s" onCommit={(v) => onInputs({ ...stored, [pins.midAt!]: v })} />
                <button type="button" aria-label="Remove this pinned frame" onClick={() => onInputs(without(pins.mid))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
              </PinDrop>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* each takes a picture dropped on it: from the library, or a file from the computer */}
              {pins.start && !carries && !opens && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.start!]: id })}><Button size="sm" onClick={() => setPicking("start")}><ImagePlus size={13} /> First frame</Button></PinDrop>}
              {pins.mid && !through && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.mid!]: id })}><Button size="sm" onClick={() => setPicking("mid")}><ImagePlus size={13} /> Keyframe</Button></PinDrop>}
              {pins.end && !ends && <PinDrop className="rounded-lg" onPick={(id) => onInputs({ ...stored, [pins.end!]: id })}><Button size="sm" onClick={() => setPicking("end")}><ImagePlus size={13} /> Last frame</Button></PinDrop>}
            </div>
    </div>
  );
}
