import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Download, Link2, Pause, Play, Redo2, Repeat, SkipBack, SkipForward, Sparkles, Undo2 } from "lucide-react";
import { api, type Asset, type Clip, type ClipPatch, type DesignerSession, type RecipeInfo, type Take, type TimelinePatch } from "../api";
import { useEntities, useEstimates, useFamilies, useModelSettings, useQueue, useRecipes, useSetup, useTimeline } from "../data";
import type { DesignerTurn } from "../Designer";
import { estimateFor } from "../estimate";
import { formDefaults } from "../form";
import { aboutMs, notReady } from "../format";
import { Picker } from "../PictureField";
import { useNewClock } from "../timeline/clock";
import { Inspector, MusicPanel } from "../timeline/Inspector";
import { layout, otherShape, pinInputs, SHAPES, shapeOf, stamp, ZOOM, type Shape } from "../timeline/model";
import { Player, type PlayerHandle } from "../timeline/Player";
import { MediaOverlay } from "../timeline/MediaOverlay";
import { Track } from "../timeline/Track";
import { Button, cx, ErrorNote } from "../ui";
import { FinishDialog } from "../timeline/Finish";
import { Viewer } from "../Viewer";
import { ContextMenu, useMenu } from "../ContextMenu";
import { useBanners } from "../store";
import { CastDialog } from "../timeline/CastDialog";
import { ExportDialog, type ExportAsk, type ExportOptions } from "../timeline/ExportDialog";
import { clipMenuItems, musicMenuItems, soundMenuItems, type ClipMenuActions } from "../timeline/menus";
import { Overview } from "../timeline/Overview";
import { RangeBar } from "../timeline/RangeBar";
import { Readout } from "../timeline/Readout";
import { StartPanel } from "../timeline/StartPanel";
import { useClipEdits } from "../timeline/useClipEdits";
import { useEditorKeys } from "../timeline/useEditorKeys";
import { useRange } from "../timeline/useRange";
import { movingSeed, seedAfter, useSeedMode } from "../seedMode";

// the designer's panel is a chunk of its own: fetched the first time it opens
const Designer = lazy(() => import("../Designer").then((m) => ({ default: m.Designer })));

/**
 * The timeline editor: your media on the left, the video in the middle, the selected clip on the right,
 * and the timeline itself along the bottom. Nothing here knows which model a clip is made with: it
 * shows the recipe's form and asks the server to render.
 */
export function TimelineEditor({ params }: { params: { id: string } }) {
  const id = params.id;
  const timeline = useTimeline(id);
  const recipes = useRecipes();
  const setup = useSetup();
  const queue = useQueue();
  const settings = useModelSettings();
  const client = useQueryClient();
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ["timelines"] }), [client]);

  const [selected, setSelected] = useState<string | null>(null);
  /** The clips picked with Ctrl + click on the track, to render together. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [musicOpen, setMusicOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  // the moment of what plays: not state, so that a tick redraws the track and the readout, not the whole editor
  const clock = useNewClock();
  const [pps, setPps] = useState(ZOOM.start);
  const [preview, setPreview] = useState<Take | null>(null);
  const [opened, setOpened] = useState<Asset | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [casting, setCasting] = useState(false);
  const [mood, setMood] = useState<string | null>(null);
  /** The clip the designer is open for, and what was said about each clip (kept while the editor is open). */
  const [designing, setDesigning] = useState<string | null>(null);
  const [talks, setTalks] = useState<Record<string, DesignerTurn[]>>({});
  // the language model and instructions each clip's conversation is held with, as picked here before the timeline is read again
  const [sessions, setSessions] = useState<Record<string, DesignerSession>>({});
  const entities = useEntities();
  const [note, setNote] = useState<string | null>(null);
  const [exp, setExp] = useState<ExportAsk | null>(null);
  const [fin, setFin] = useState(false);
  const player = useRef<PlayerHandle>(null);
  /** A clip selected, its panel open in place of the music's. */
  const select = (clip: string | null) => {
    setSelected(clip);
    setMusicOpen(false);
  };

  const t = timeline.data;
  const clips = useMemo(() => t?.clips ?? [], [t]);
  // the video models that are on, and the ones a clip of this timeline is already made with
  const families = useFamilies();
  const videoRecipes = useMemo(
    () => (recipes.data?.recipes ?? []).filter((r) => r.output === "video" && (families.isOn(r.family) || clips.some((c) => c.recipe === r.id))),
    [recipes.data, families, clips],
  );
  const comfyOnline = setup.data?.comfy.online ?? false;
  const current = clips.find((c) => c.id === selected) ?? null;
  // what is forming is watched large when the clip that renders is the one selected, or when the timeline has nothing to show yet
  const renderingAt = queue.data?.running ? clips.findIndex((c) => c.id === queue.data!.running!.clipId) : -1;
  const liveShown = renderingAt >= 0 && (clips[renderingAt]!.id === selected || !clips.some((c) => c.take || c.still)) ? { job: queue.data!.running!, clip: renderingAt + 1 } : null;
  const running = queue.data?.running ?? null;
  const slots = useMemo(() => layout(clips, pps, videoRecipes), [clips, pps, videoRecipes]);
  const total = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;

  const { dropEdits, saveFailed, save, inputsOf, editInputs, shown, formOf, ready } = useClipEdits({ timeline: t, clips, recipes, setup, settings, comfyOnline });
  /** What a clip says happens, in a few words, for the designer: its main text, or what it is. */
  const sayOf = (c: Clip) => {
    if (c.kind === "still") return `(a picture held on screen for ${(c.lengthMs / 1000).toFixed(1)} s${c.still?.name ? `: ${c.still.name}` : ""})`;
    const main = recipes.data?.recipes.find((r) => r.id === c.recipe)?.inputs.find((i) => i.type === "prompt" && !i.optional);
    return main ? String(inputsOf(c)[main.id] ?? "") : "(a video that was added as it is)";
  };

  const after = () => {
    void refresh();
    void client.invalidateQueries({ queryKey: ["queue"] });
  };
  const render = useMutation({
    mutationFn: async (v: { clips: Clip[]; fit?: boolean; takes?: number }) => {
      await save();
      // a seed meant to move: the takes go out with the next seeds in a row, and the clip's form shows the one after them
      const mode = useSeedMode.getState().mode;
      const sent = v.clips.map((c) => ({ clip: c, input: ready(c).input ?? {} })).map((x) => ({ ...x, seedMode: movingSeed(x.input.seed, mode) }));
      const made = await api.renderClips(id, sent.map(({ clip, input, seedMode }) => ({ id: clip.id, input, ...(v.fit === undefined ? {} : { fit: v.fit }), ...(v.takes && v.takes > 1 ? { takes: v.takes } : {}), ...(seedMode ? { seedMode } : {}) })));
      for (const x of sent) if (x.seedMode) await api.editClip(x.clip.id, { inputs: { ...inputsOf(x.clip), seed: seedAfter(x.input.seed as number, mode, v.takes ?? 1) } });
      return made;
    },
    onSuccess: after,
  });
  const patch = useMutation({ mutationFn: (v: { clip: string; patch: ClipPatch }) => api.editClip(v.clip, v.patch), onSuccess: after });
  const edit = useMutation({ mutationFn: (p: TimelinePatch) => api.editTimeline(id, p), onSuccess: after });
  const add = useMutation({
    mutationFn: (v: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip" }) => api.addClip(id, v),
    onSuccess: (r) => {
      client.setQueryData(["timelines", id], r.timeline);
      setSelected(r.clip);
      setMusicOpen(false);
      after();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteClip, onSuccess: after });
  // the clips picked with Ctrl + click, removed one after the other (each comes back with Undo)
  const removeMany = useMutation({ mutationFn: async (ids: string[]) => { for (const id of ids) await api.deleteClip(id); }, onSuccess: () => { setPicked(new Set()); after(); } });
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  const removePicked = useCallback(() => {
    if (pickedNow.current.size < 2) return false;
    removeMany.mutate([...pickedNow.current]);
    return true;
  }, [removeMany]);
  const say = useBanners((b) => b.push);
  const split = useMutation({ mutationFn: (v: { clip: string; atMs: number }) => api.splitClip(v.clip, v.atMs), onSuccess: after });
  // the designer writing a clip put between two others: its texts go into the form unless something was typed there meanwhile
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  const [writing, setWriting] = useState<string | null>(null);
  const writeBetween = useMutation({
    mutationFn: async (v: { clip: string; force: boolean; arrive?: string }) => {
      setWriting(v.clip);
      return { ...(await api.writeBetween(v.clip, v.arrive)), ...v };
    },
    onSuccess: (r) => {
      const c = clipsNow.current.find((x) => x.id === r.clip);
      if (!c) return;
      const current = inputsOf(c);
      const kept = Object.fromEntries(Object.entries(r.changes).filter(([k]) => r.force || String(current[k] ?? "") === String(r.was[k] ?? "")));
      if (Object.keys(kept).length) editInputs(c, { ...current, ...kept });
      if (r.note) setNote(`The designer: ${r.note}`);
    },
    onSettled: () => setWriting(null),
  });
  const durationMs = t?.durationMs ?? 0;
  const { range, setRange, rangeRef, loopRange, loopRef, snapQuiet, toggleSnapQuiet, playingRange, emptyRange, totalRef, toggle, toggleLoop, toggleLoopNow, rangeAct, rangeItems } = useRange({
    id, clips, durationMs, clock, player, playing, setPlaying,
    on: { after, select, note: setNote, say, writeBetween: (v) => writeBetween.mutate(v) },
  });
  // the right-click menu of a clip: what the Inspector offers on it, at the pointer
  const clipMenu = useMenu<Clip>();
  /** Right-click on a clip's audio strip and on the music strip: what the clip panel's sound section and the music panel do, in place. */
  const soundMenu = useMenu<Clip>();
  const musicMenu = useMenu<true>();
  const [soundPick, setSoundPick] = useState<Clip | null>(null);
  const [musicPick, setMusicPick] = useState(false);
  /** Where the playhead stands on a clip, when it stands on this one. */
  const onClip = (c: Clip) => {
    const here = player.current?.where();
    return here && here.clip.id === c.id ? here : null;
  };
  const rangeMenu = useMenu<true>();
  const removeTake = useMutation({ mutationFn: api.deleteTake, onSuccess: after });
  // a clip that is rendering, or waiting for its turn, is stopped from here: nothing is added, the clip keeps the takes it has
  const stop = useMutation({
    mutationFn: api.cancel,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      after();
    },
  });
  const undo = useMutation({
    mutationFn: async () => {
      await save();
      return api.undoTimeline(id);
    },
    onSuccess: (r) => {
      // what the server has now is what counts: what was typed was saved before the undo
      dropEdits();
      setNote(`Undone: ${r.undone}.`);
      after();
    },
  });
  const redo = useMutation({
    mutationFn: async () => {
      await save();
      return api.redoTimeline(id);
    },
    onSuccess: (r) => {
      dropEdits();
      setNote(`Redone: ${r.redone}.`);
      after();
    },
  });
  const duplicate = useMutation({ mutationFn: api.duplicateClip, onSuccess: (r) => { after(); setSelected(r.clip); } });
  const exportIt = useMutation({ mutationFn: (v: ExportOptions) => api.exportTimeline(id, v), onSuccess: after });
  const frame = useMutation({ mutationFn: (v: { asset: string; at: number }) => api.frame(v.asset, v.at), onSuccess: (a) => { setOpened(a); void client.invalidateQueries({ queryKey: ["assets"] }); } });
  /**
   * A loop ends where the clip begins: on its opening picture when it has one, else on the first frame
   * that plays of its take (saved as a picture, and pinned as the opening picture too unless the clip
   * flows on from the one before).
   */
  const loop = useMutation({
    mutationFn: async (c: Clip) => {
      const pins = pinInputs(recipes.data?.recipes.find((r) => r.id === c.recipe));
      if (!pins.end) return;
      const stored = inputsOf(c);
      const flows = clips.indexOf(c) > 0 && c.joined === "continue";
      const opening = !flows && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
      if (opening) return editInputs(c, { ...stored, [pins.end]: opening });
      if (!c.take) return;
      const first = await api.frame(c.take.asset.id, c.take.startMs + 20);
      void client.invalidateQueries({ queryKey: ["assets"] });
      editInputs(c, { ...stored, ...(pins.start && !flows ? { [pins.start]: first.id } : {}), [pins.end]: first.id });
      setNote("It will loop from the next take: it now ends on its own first frame.");
    },
  });
  /** A scene in a few words, written as clips by the designer and put on the timeline. Nothing is rendered. */
  const plan = useMutation({
    mutationFn: async (v: { idea: string; clips: number }) => {
      const recipe = clips.find((c) => c.recipe)?.recipe ?? firstRecipe();
      if (!recipe) throw new Error("There is no video model to plan clips for yet.");
      const made = await api.designerPlan({ recipe, idea: v.idea.trim(), clips: v.clips, look: t?.look ?? null, mood: t?.mood });
      if (!made.clips.length) throw new Error(made.note || "The designer returned no clips.");
      return api.planTimeline(id, recipe, made.clips);
    },
    onSuccess: (r) => {
      // the scene typed goes with the start panel, which the clips replace
      client.setQueryData(["timelines", id], r.timeline);
      setSelected(r.clips[0] ?? null);
      after();
    },
  });
  const error = plan.error ?? loop.error ?? render.error ?? patch.error ?? edit.error ?? add.error ?? remove.error ?? removeTake.error ?? stop.error ?? undo.error ?? exportIt.error ?? frame.error ?? rangeAct.error ?? split.error;
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);

  /** A new clip that waits to be rendered. The first one of a timeline is given a model that can run. */
  const firstRecipe = () => {
    const usable = (r: RecipeInfo) => !notReady(setup.data?.recipes.find((x) => x.id === r.id), comfyOnline);
    return (videoRecipes.find((r) => r.traits?.continues && usable(r)) ?? videoRecipes.find(usable) ?? videoRecipes[0])?.id;
  };
  const hasRecipe = clips.some((c) => c.recipe);
  const newClip = (afterId?: string | null) => add.mutate({ after: afterId, recipe: hasRecipe ? undefined : firstRecipe() });

  /** What is left to render: clips without a take, and clips whose join went stale. */
  const missing = clips.filter((c) => c.kind === "video" && !c.job && (!c.take || c.join === "stale") && ready(c).input);

  const estimates = useEstimates();
  /** About how long a clip takes to render, from past renders of its model. */
  const takes = (c: Clip) => estimateFor(estimates.data, recipes.data?.recipes.find((r) => r.id === c.recipe), ready(c).input ?? inputsOf(c))?.ms ?? null;
  const allMs = missing.reduce((sum, c) => sum + (takes(c) ?? 0), 0);

  /** Where the playhead was put by hand on the track (it can stand on a clip that is not rendered yet); null while it follows what plays. */
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const onTime = useCallback((ms: number) => {
    clock.set(ms);
    // (set only when it stands somewhere: fifteen times a second, a no-op set still costs a render)
    if (cursorRef.current !== null) setCursor(null);
    const r = rangeRef.current;
    if (playingRange.current && r && ms >= r.outMs - 15) {
      if (loopRef.current && r.outMs - r.inMs >= 40) player.current?.seek(r.inMs);
      else {
        playingRange.current = false;
        setPlaying(false);
      }
    }
  }, [clock]);
  /** One frame of the clip under the playhead, in ms (24 a second when it is not known). */
  const frameMs = () => {
    const time = clock.get();
    const c = clips.find((x) => x.lengthMs > 0 && time >= x.atMs && time < x.atMs + x.lengthMs);
    return 1000 / Math.max(1, c?.take?.asset.fps ?? 24);
  };
  const frameRef = useRef(frameMs);
  frameRef.current = frameMs;
  const selectedNow = useRef<string | null>(null);
  selectedNow.current = current?.id ?? null;
  useEditorKeys({ clock, player, toggle, undo: undo.mutate, canUndo: Boolean(t?.undo), redo: redo.mutate, canRedo: Boolean(t?.redo), remove: remove.mutate, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameRef, selectedNow, setSelected, setPicked });

  const jump = (by: -1 | 1) => {
    const time = clock.get();
    const playable = clips.filter((c) => c.lengthMs > 0);
    const here = playable.findIndex((c) => time >= c.atMs && time < c.atMs + c.lengthMs);
    // back: to the start of this clip, or of the one before when already there
    const target = by === 1 ? playable[here + 1] : time - (playable[here]?.atMs ?? 0) > 400 ? playable[here] : playable[Math.max(0, here - 1)];
    if (!target) return;
    player.current?.seek(target.atMs);
    setSelected(target.id);
    setMusicOpen(false);
  };

  /** Cut the clip on screen at the frame shown, and add a clip that continues from there. */
  const continueHere = async () => {
    const here = player.current?.where();
    if (!here) return;
    setPlaying(false);
    return continueFrom(here.clip, here.localMs);
  };
  const continueFrom = async (clip: Clip, localMs: number) => {
    const local = Math.max(0, Math.min(clip.lengthMs, localMs));
    const left = clip.lengthMs - local;
    if (clip.take && left > 60 && local > 300) await api.editClip(clip.id, { trimEndMs: clip.take.trimEndMs + Math.round(left) });
    add.mutate({ after: clip.id, recipe: hasRecipe ? undefined : firstRecipe() });
  };

  if (timeline.isError) {
    return (
      <div className="flex grow flex-col items-start gap-3 p-8">
        <ErrorNote>{timeline.error.message}</ErrorNote>
        <Link href="/timelines" className="underline">Back to the timelines</Link>
      </div>
    );
  }
  if (!t || !shown) return <div className="grow p-8 text-ink-2">Loading timeline…</div>;

  const why = current ? ready(current).why ?? null : null;
  const shape: Shape | "own" | "first" = !t.width || !t.height ? "first" : (Object.keys(SHAPES) as Shape[]).find((k) => SHAPES[k].width === t.width && SHAPES[k].height === t.height) ?? "own";
  const misfits = clips.filter((c) => otherShape(c, t) && !c.fill).length;
  // the finished size: the timeline's shape with as many pixels as its largest take, when a take is larger than the frame
  const largest = Math.max(0, ...clips.map((c) => (c.take?.asset.width ?? 0) * (c.take?.asset.height ?? 0)));
  const finishedK = t.width && t.height ? Math.sqrt(largest / (t.width * t.height)) : 1;
  const finishedSize = finishedK > 1.05 && t.width && t.height ? `${Math.round((t.width * finishedK) / 8) * 8} × ${Math.round((t.height * finishedK) / 8) * 8}` : null;
  /** What a clip's menu reaches: the editor's mutations, by name. */
  const clipActs: ClipMenuActions = {
    clips: shown.clips,
    recipes: recipes.data?.recipes ?? [],
    inputsOf,
    onClip,
    pending: { render: render.isPending, split: split.isPending, duplicate: duplicate.isPending, loop: loop.isPending, add: add.isPending, frame: frame.isPending, range: rangeAct.isPending },
    render: (c) => render.mutate({ clips: [c] }),
    patch: (clip, p) => patch.mutate({ clip, patch: p }),
    setRange,
    split: (clip, atMs) => split.mutate({ clip, atMs }),
    duplicate: (clip) => duplicate.mutate(clip),
    loop: (c) => loop.mutate(c),
    continueFrom: (c, localMs) => void continueFrom(c, localMs),
    frame: (asset, at) => frame.mutate({ asset, at }),
    open: setOpened,
    slow: (factor, inMs, outMs) => rangeAct.mutate({ slow: factor, inMs, outMs }),
    remove: (clip) => remove.mutate(clip),
    picked,
    removeMany: (ids) => removeMany.mutate(ids),
  };

  return (
    <div className="flex min-w-0 grow flex-col">
      <header className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line px-3">
        <input
          aria-label="Timeline name"
          value={name ?? t.name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null && name.trim() && name !== t.name) edit.mutate({ name: name.trim() });
            setName(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-9 w-56 rounded-lg border border-transparent bg-transparent px-2 text-base font-semibold hover:border-line focus:border-accent focus:bg-raised"
        />
        <span className="shrink-0 text-ink-2">{clips.length === 0 ? "Empty" : `${stamp(total)} · ${clips.length} clip${clips.length > 1 ? "s" : ""}`}</span>
        <span className="grow" />
        {saveFailed ? (
          // what was typed is still on screen and not on the server: said, with the way to send it again
          <span className="flex max-w-sm items-center gap-2 text-warn-ink" title={saveFailed}>
            <span className="truncate">Could not save the clip's form: {saveFailed}</span>
            <Button size="sm" onClick={() => void save()}>Retry</Button>
          </span>
        ) : (error || note) ? (
          <span className={error ? "max-w-sm truncate text-warn-ink" : "max-w-sm truncate text-ink-2"} title={error?.message}>{error?.message ?? note}</span>
        ) : null}
        <Button className="px-3" disabled={!t.redo || redo.isPending} title={t.redo ? `Redo: ${t.redo} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={() => redo.mutate()} aria-label="Redo">
          <Redo2 size={15} />
        </Button>
        <Button className="px-3" disabled={!t.undo || undo.isPending} title={t.undo ? `Undo: ${t.undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => undo.mutate()}>
          <Undo2 size={15} /> Undo
        </Button>
        {missing.length > 0 && (
          <Button tone="primary" disabled={render.isPending} title="Renders the clips that have no take yet and redoes the ones that no longer follow the clip before them, in order." onClick={() => render.mutate({ clips: missing })}>
            Render all ({missing.length}){allMs ? ` · ${aboutMs(allMs)}` : ""}
          </Button>
        )}
        {picked.size > 0 && (
          <Button tone="primary" disabled={render.isPending || !clips.some((c) => picked.has(c.id) && c.kind === "video" && ready(c).input)} title="Renders the clips picked with Ctrl + click, together: each is queued as its own job, in order, and a clip that flows on from a picked one waits for it. Esc drops the pick." onClick={() => { render.mutate({ clips: clips.filter((c) => picked.has(c.id) && c.kind === "video" && ready(c).input) }); setPicked(new Set()); }}>
            Render {picked.size} picked
          </Button>
        )}
        <Button disabled={!clips.some((c) => c.kind === "video" && c.take)} title="Every clip's selected take brought to its final quality by an upscale route, as a new take each. The drafts stay." onClick={() => setFin(true)}>
          <Sparkles size={15} /> Finish
        </Button>
        <Button disabled={!t.durationMs} onClick={() => setExp({ scale: 1, music: true, smooth: false, range: Boolean(range && !emptyRange), blend: true, match: true, fit: finishedSize ? "largest" : "timeline", before: t.exported?.id ?? null, asked: Boolean(t.exporting) })}>
          <Download size={15} /> {t.exporting ? "Exporting…" : "Export video"}
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        {/* the media and the player side by side, and under both the row that plays: it starts at the left edge */}
        <div className="flex min-w-0 grow flex-col">
        <div className="relative flex min-h-0 grow">
        <MediaOverlay
          timeline={shown}
          selected={Boolean(current)}
          onOpen={setOpened}
          onAdd={(a) => {
            if (a.kind !== "audio") return add.mutate({ asset: a.id });
            if (current) patch.mutate({ clip: current.id, patch: { soundAsset: a.id } });
            else setNote("Select a clip first, or drag the audio onto a clip or onto the music track.");
          }}
        />

        <main className="flex min-w-0 grow flex-col">
            <Player ref={player} timeline={t.id} clips={clips} music={t.music} frame={t.width && t.height ? { width: t.width, height: t.height } : null} playing={playing} onPlaying={setPlaying} onTime={onTime} preview={preview} live={liveShown} onStop={(job) => stop.mutate(job)} />
        </main>
        </div>
          {range && <RangeBar range={range} emptyRange={emptyRange} clips={clips} snapQuiet={snapQuiet} onSnapQuiet={toggleSnapQuiet} items={rangeItems()} />}
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
            <button type="button" aria-label="Previous clip" title="Previous clip" disabled={!t.durationMs} onClick={() => jump(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipBack size={15} /></button>
            <button type="button" aria-label={playing ? "Pause" : range && !emptyRange ? "Play the range" : "Play"} title={range && !emptyRange ? "Play the range: from the playhead inside it, else from In; stops at Out (Space)" : "Play / pause (Space)"} disabled={!t.durationMs} onClick={toggle} className={cx("flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40", range && !emptyRange ? "bg-accent text-accent-ink" : "bg-ink text-ground")}>
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
            </button>
            <button type="button" aria-label="Next clip" title="Next clip" disabled={!t.durationMs} onClick={() => jump(1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipForward size={15} /></button>
            {range && !emptyRange && (
              <button type="button" aria-label="Loop the range" aria-pressed={loopRange} title={loopRange ? "Loop is on: back to In at Out (L)" : "Loop the range (L)"} onClick={toggleLoop} className={cx("flex h-8 w-8 items-center justify-center rounded-lg", loopRange ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover hover:text-ink")}><Repeat size={15} /></button>
            )}
            <Readout clock={clock} slots={slots} cursor={cursor} total={total} />
            <span className="grow" />
            <button type="button" aria-label="Extend from this frame" title="Extend from this frame: cuts the clip on screen here and adds a new clip that carries on from it" disabled={!t.durationMs || add.isPending} onClick={() => void continueHere()} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><Link2 size={15} /></button>
            <button
              type="button"
              aria-label="Save frame"
              title="Save frame: the frame on screen, as an image in your library"
              disabled={!t.durationMs || frame.isPending}
              onClick={() => {
                const here = player.current?.where();
                if (here?.clip.take) frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
                else if (here?.clip.still) setOpened(here.clip.still);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <Camera size={15} />
            </button>
          </div>

        {/* the track under the stage, so that the inspector keeps the whole height on the right */}
        <Track
          timeline={shown}
          recipes={videoRecipes}
          pps={pps}
          onZoom={setPps}
          selected={musicOpen ? null : selected}
          musicSelected={musicOpen}
          picked={picked}
          onPick={(id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          clock={clock}
          running={running}
          onStop={(job) => stop.mutate(job)}
          busy={add.isPending}
          onSelect={(clipId) => {
            setSelected(clipId);
            setMusicOpen(false);
          }}
          onSelectMusic={() => setMusicOpen(true)}
          cursorMs={cursor}
          onSeek={(ms, trackMs) => {
            player.current?.seek(ms);
            // after the seek, which says where the player is: the playhead stays exactly where it was put
            if (trackMs !== undefined) setCursor(trackMs);
          }}
          onMove={(clip, afterId) => patch.mutate({ clip, patch: { after: afterId } })}
          onJoin={(clip, joined) => patch.mutate({ clip: clip.id, patch: { joined } })}
          onInsert={(asset, afterId) => add.mutate({ after: afterId, asset })}
          onUpload={(file) =>
            api.upload(file, { folder: t.folderId ?? undefined, project: t.projectId ?? null })
              .then((a) => ({ id: a.id, kind: a.kind }))
              .catch((err: Error) => {
                say({ id: `upload:${Date.now()}`, tone: "bad", title: `${file.name} could not be added`, text: err.message, href: "/", go: "Open the library" });
                return null;
              })
          }
          onPin={(clip, where, asset, atS) => {
            const pins = pinInputs(recipes.data?.recipes.find((r) => r.id === clip.recipe));
            const input = pins[where];
            if (!input) return;
            editInputs(clip, { ...inputsOf(clip), [input]: asset, ...(where === "mid" && pins.midAt && atS ? { [pins.midAt]: atS } : {}) });
            setSelected(clip.id);
            setMusicOpen(false);
          }}
          onClipSound={(clip, asset) => patch.mutate({ clip, patch: { soundAsset: asset } })}
          onMusic={(asset) => {
            edit.mutate({ music: { asset } });
            setMusicOpen(true);
          }}
          onTrim={(clip, p) => patch.mutate({ clip: clip.id, patch: p })}
          onNewClip={(afterId) => newClip(afterId)}
          onMenu={(clip, e) => clipMenu.open(e, clip)}
          onSoundMenu={(clip, e) => soundMenu.open(e, clip)}
          onMusicMenu={(e) => musicMenu.open(e, true)}
          range={range}
          onRange={setRange}
          onRangeMenu={(e) => rangeMenu.open(e, true)}
          snapQuiet={snapQuiet}
        />
        </div>

        {musicOpen && t.music ? (
          <MusicPanel timeline={t} onEdit={(p) => edit.mutate(p)} />
        ) : current ? (
          <Inspector
            key={current.id}
            timeline={t}
            clip={current}
            index={clips.indexOf(current)}
            recipes={videoRecipes}
            stored={inputsOf(current)}
            whole={formOf(current)}
            why={why}
            takesMs={takes(current)}
            running={running?.clipId === current.id ? running : null}
            busy={render.isPending}
            error={render.isError ? render.error.message : null}
            onInputs={(next) => editInputs(current, next)}
            onRecipe={(recipe) => patch.mutate({ clip: current.id, patch: { recipe } })}
            onPatch={(p) => patch.mutate({ clip: current.id, patch: p })}
            onRender={(fit, count) => render.mutate({ clips: [current], fit, takes: count })}
            onRemove={() => {
              remove.mutate(current.id);
              setSelected(null);
            }}
            onRemoveTake={(takeId) => removeTake.mutate(takeId)}
            onStop={() => current.job && stop.mutate(current.job.id)}
            onDesigner={() => setDesigning(current.id)}
            onClose={() => setSelected(null)}
            onPreview={setPreview}
            writing={writeBetween.isPending && writing === current.id}
            writeError={writeBetween.isError && writeBetween.variables?.clip === current.id && writeBetween.variables.force ? writeBetween.error.message : null}
            onWriteBetween={() => writeBetween.mutate({ clip: current.id, force: true })}
          />
        ) : (
          <aside className="flex w-[400px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-5 text-ink-2">
            <span className="text-base font-semibold text-ink">{clips.length ? t.name : "Start your video"}</span>
            {clips.length ? (
              <Overview
                timeline={t}
                aspect={{
                  value: shape,
                  onChange: (v) => edit.mutate(v === "first" ? { width: null, height: null } : v === "own" ? {} : { width: SHAPES[v as Shape].width, height: SHAPES[v as Shape].height }),
                  options: [
                    ...(Object.keys(SHAPES) as Shape[]).map((k) => ({ value: k as string, label: SHAPES[k].label, note: `${SHAPES[k].width} × ${SHAPES[k].height}` })),
                    ...(shape === "own" ? [{ value: "own", label: SHAPES[shapeOf(t.width!, t.height!)].label, note: `${t.width} × ${t.height}` }] : []),
                    { value: "first", label: "The first clip decides", detail: "The video takes the aspect ratio of the first clip that is rendered." },
                  ],
                }}
                clips={clips}
                missing={missing}
                misfits={misfits}
                allMs={allMs}
                onPick={(id) => { setSelected(id); setMusicOpen(false); }}
                onMusic={() => setMusicOpen(true)}
                onCast={() => setCasting(true)}
                onFolder={(folder) => edit.mutate({ folder })}
                onRenderAll={() => render.mutate({ clips: missing })}
                picked={picked}
                onRenderPicked={() => { render.mutate({ clips: clips.filter((c) => picked.has(c.id) && c.kind === "video" && ready(c).input) }); setPicked(new Set()); }}
                rendering={render.isPending}
              />
            ) : (
              <StartPanel busy={add.isPending} planning={plan.isPending} onPickImage={() => setPicking(true)} onPlan={(idea, count) => plan.mutate({ idea, clips: count })} onNewClip={() => newClip()} />
            )}
          </aside>
        )}
      </div>

      {clipMenu.menu && <ContextMenu at={clipMenu.menu.at} label="Actions on this clip" items={clipMenuItems(clipMenu.menu.subject, clipActs)} onClose={clipMenu.close} />}
      {rangeMenu.menu && range && <ContextMenu at={rangeMenu.menu.at} label="Actions on the range" items={rangeItems()} onClose={rangeMenu.close} />}
      {soundMenu.menu && <ContextMenu at={soundMenu.menu.at} label="The audio of this clip" items={soundMenuItems(shown.clips.find((x) => x.id === soundMenu.menu!.subject.id) ?? soundMenu.menu.subject, { patch: (clip, p) => patch.mutate({ clip, patch: p }), pick: setSoundPick, select })} onClose={soundMenu.close} />}
      {musicMenu.menu && <ContextMenu at={musicMenu.menu.at} label="The music" items={musicMenuItems(t.music, { pick: () => setMusicPick(true), open: () => { setSelected(null); setMusicOpen(true); }, edit: (p) => edit.mutate(p) })} onClose={musicMenu.close} />}
      {soundPick && <Picker title={`Audio of clip ${shown.clips.findIndex((x) => x.id === soundPick.id) + 1}`} kind="audio" onClose={() => setSoundPick(null)} onPick={(soundAsset) => { patch.mutate({ clip: soundPick.id, patch: { soundAsset } }); setSoundPick(null); }} />}
      {musicPick && <Picker title="Music" kind="audio" onClose={() => setMusicPick(false)} onPick={(asset) => { edit.mutate({ music: { asset } }); setMusicPick(false); setMusicOpen(true); }} />}

      {exp && (
        <ExportDialog
          timeline={t}
          clips={clips}
          ask={exp}
          onChange={setExp}
          range={range}
          emptyRange={emptyRange}
          finishedSize={finishedSize}
          misfits={misfits}
          exporting={exportIt.isPending}
          onExport={(v) => exportIt.mutate(v)}
          onOpen={setOpened}
          onClose={() => setExp(null)}
        />
      )}
      {fin && (
        <FinishDialog
          timeline={id}
          clips={clips}
          upscaleModels={setup.data?.recipes.find((r) => r.id === "h3.video")?.options.upscaleModel ?? setup.data?.recipes.find((r) => r.id === "wan.video")?.options.upscaleModel ?? []}
          onClose={() => setFin(false)}
          onQueued={(r) => {
            after();
            setFin(false);
            setNote(`${r.jobs.length} clip${r.jobs.length === 1 ? "" : "s"} finishing in the queue, one job each; the finished takes arrive as they land.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `clip ${x.clip} (${x.why})`).join(", ")}.` : ""}`);
          }}
        />
      )}
      {casting && <CastDialog timeline={t} mood={mood} onMood={setMood} onEdit={(p) => edit.mutate(p)} onClose={() => setCasting(false)} />}
      {designing && (() => {
        const c = clips.find((x) => x.id === designing);
        const recipe = recipes.data?.recipes.find((r) => r.id === c?.recipe);
        if (!c || !recipe) return null;
        const at = clips.indexOf(c);
        const before = at > 0 && c.joined === "continue" ? clips[at - 1] : undefined;
        const beforeRecipe = recipes.data?.recipes.find((r) => r.id === before?.recipe);
        const beforeMain = beforeRecipe?.inputs.find((i) => i.type === "prompt" && !i.optional);
        const stored = inputsOf(c);
        const status = setup.data?.recipes.find((r) => r.id === recipe.id);
        return (
          <Suspense fallback={null}>
          <Designer
            // on the left, over the media: the clip's own settings, on the right, stay in view and are seen to change
            side="left"
            draftKey={`clip:${c.id}`}
            recipe={recipe}
            values={{ ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored }}
            previous={before && beforeMain ? String(inputsOf(before)[beforeMain.id] ?? "") || undefined : undefined}
            story={{ clips: clips.map(sayOf), index: at }}
            look={c.look ?? t.look}
            mood={t.mood}
            turns={talks[c.id] ?? (c.chat as DesignerTurn[])}
            onTurns={(turns) => {
              setTalks((all) => ({ ...all, [c.id]: turns }));
              // kept with the clip, so that it is there the next time the timeline is opened
              void api.editClip(c.id, { chat: turns }).catch(() => {});
            }}
            session={sessions[c.id] ?? c.designer}
            onSession={(session) => {
              setSessions((all) => ({ ...all, [c.id]: session }));
              void api.editClip(c.id, { designer: session }).catch(() => {});
            }}
            onApply={(changes) => editInputs(c, { ...inputsOf(c), ...changes })}
            onClose={() => setDesigning(null)}
          />
          </Suspense>
        );
      })()}
      {picking && (
        <Picker
          title="Start from an image"
          onClose={() => setPicking(false)}
          onPick={(asset) => {
            add.mutate({ asset, as: "clip" });
            setPicking(false);
          }}
        />
      )}
      {opened && <Viewer asset={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
