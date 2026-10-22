import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { Asset, Clip, DesignerSession, RecipeInfo, Take, Timeline } from "../api";
import { useFamilies, useModelSettings, useRecipes, useSetup, useTimeline } from "../data";
import type { DesignerTurn } from "../designer/types";
import { formsCanQueue, notReady, plural } from "../format";
import { useBanners, useEditorColumn } from "../store";
import { useQueueOf } from "../screens/studio/queueOf";
import { useNewClock } from "./clock";
import { rememberAspect } from "./EditorSkeleton";
import type { ExportAsk } from "./ExportDialog";
import { layout, moveAfter, otherShape, ZOOM } from "./model";
import { madeFromSource, sourcePlace } from "./track/SourceLane";
import { clipsOfRecording } from "./track/RecordingBand";
import { sameWindowGrid } from "@afflatus/core";
import type { PlayerHandle } from "./Player";
import { useClipEdits } from "./useClipEdits";
import { useMaskPreview, type ClipMask } from "./maskPreview";
import { useOneTrim } from "./useOneTrim";
import { useClipSteps } from "./useClipSteps";
import { useEditorMenus } from "./useEditorMenus";
import { useBarRequests } from "./useBarRequests";
import { useEditorKeys } from "./useEditorKeys";
import { useErrorShown, useHeaderNote } from "./useHeaderNote";
import { usePlayhead } from "./usePlayhead";
import { useRange } from "./useRange";
import { useTimelineMutations } from "./useTimelineMutations";
import { useEditorPanels } from "./useEditorPanels";
import { useRenderPlan } from "./useRenderPlan";
import { useSelectedClipBridge } from "./useSelectedClipBridge";

const NONE: RecipeInfo[] = [];

/**
 * What the timeline editor holds: the timeline and the lists it is read with, what is selected, picked and open, the
 * playhead, the range, the edits and the mutations, and the keys. The editor (screens/TimelineEditor.tsx) lays it out;
 * editorProps.tsx hands each of its parts what it needs from here.
 */
export function useTimelineEditor(id: string) {
  const timeline = useTimeline(id);
  const recipes = useRecipes();
  const setup = useSetup();
  // only which clip renders: the queue changes at every step of a render, and the parts that show its progress read it themselves
  const running = useQueueOf((q) => q.running?.clipId ?? null) ?? null;
  const settings = useModelSettings();
  const panelWidth = useEditorColumn((st) => st.width);
  const folded = useEditorColumn((st) => st.folded);

  const { selected, setSelected, picked, setPicked, musicOpen, setMusicOpen, joinOpen, setJoinOpen, sourceOpen, setSourceOpen, select, openSource, openJoin } = useEditorPanels();
  const [playing, setPlaying] = useState(false);
  // the moment of what plays: not state, so that a tick redraws the track and the readout, not the whole editor
  const clock = useNewClock();
  const [pps, setPps] = useState(ZOOM.start);
  const [preview, setPreview] = useState<Take | null>(null);
  const [opened, setOpened] = useState<Asset | null>(null);
  const [picking, setPicking] = useState(false);
  const [casting, setCasting] = useState(false);
  const [mood, setMood] = useState<string | null>(null);
  /** The clip the designer is open for, and what was said about each clip (kept while the editor is open). */
  const [designing, setDesigning] = useState<string | null>(null);
  const [talks, setTalks] = useState<Record<string, DesignerTurn[]>>({});
  // the language model and instructions each clip's conversation is held with, as picked here before the timeline is read again
  const [sessions, setSessions] = useState<Record<string, DesignerSession>>({});
  const { note, setSaid, setNote, held, setHeld } = useHeaderNote();
  const [exp, setExp] = useState<ExportAsk | null>(null);
  const [fin, setFin] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);
  const player = useRef<PlayerHandle>(null);
  /** The moment of the source a drag on its lane stands on: the stage shows it meanwhile. */
  const [sourcePeek, setSourcePeek] = useState<number | null>(null);
  /** Each swap clip's Show the mask, by clip: its job, and whether it is drawn over the source on the stage. */
  const [masks, setMasks] = useState<Record<string, ClipMask>>({});
  /** The stage waits for a click on the person a swap replaces, on the stretch's first frame (the source panel's Pick). */
  const [whoPicking, setWhoPicking] = useState(false);
  // the source panel closed: nothing left to pick for
  useEffect(() => {
    if (!sourceOpen) setWhoPicking(false);
  }, [sourceOpen]);

  const t = timeline.data;
  const clips = useMemo(() => t?.clips ?? [], [t]);
  // the frame's shape as it is shown (the timeline's, or its first take's while the first clip decides), kept for the
  // placeholder of the next visit: a 9:16 timeline loads into a tall frame, not a landscape one
  const firstTake = clips.find((c) => c.take?.asset.width && c.take.asset.height)?.take?.asset;
  const frameW = t?.width ?? firstTake?.width ?? null;
  const frameH = t?.height ?? firstTake?.height ?? null;
  useEffect(() => {
    if (id && frameW && frameH) rememberAspect(id, frameW, frameH);
  }, [id, frameW, frameH]);
  // the video models offered (on, and not hidden), and the ones a clip or the source of this timeline is already made with
  const families = useFamilies();
  const sourceRecipe = t?.source?.recipe;
  const videoRecipes = useMemo(
    () => (recipes.data?.recipes ?? []).filter((r) => r.output === "video" && (families.offers(r) || r.id === sourceRecipe || clips.some((c) => c.recipe === r.id))),
    [recipes.data, families, clips, sourceRecipe],
  );
  // no ComfyUI of the user's own and none answering: a clip still queues, waiting for a GPU
  const comfyOnline = formsCanQueue(setup.data?.comfy);
  const current = clips.find((c) => c.id === selected) ?? null;
  // the selected clip's Show the mask, followed until its video is made (the stage draws it over the source)
  const maskOfCurrent = useMaskPreview(current?.id, current ? masks[current.id]?.job : undefined);
  // a take shown over the player while hovered goes away as soon as it is no longer one to look at: removed, or the one that
  // plays now (its thumbnail left from under the mouse, which then never said it left), another clip selected, or Play
  const previewing = preview?.id;
  useEffect(() => {
    if (!previewing) return;
    const still = current?.takes.some((x) => x.id === previewing) && current.take?.id !== previewing;
    if (!still || playing) setPreview(null);
  }, [previewing, current, playing]);
  // what is forming is watched large when the clip that renders is the one selected, or when the timeline has nothing to show yet
  const renderingAt = running ? clips.findIndex((c) => c.id === running) : -1;
  const liveShown = renderingAt >= 0 && (clips[renderingAt]!.id === selected || !clips.some((c) => c.take || c.still)) ? { clipId: running!, clip: renderingAt + 1 } : null;
  const slots = useMemo(() => layout(clips, pps, videoRecipes), [clips, pps, videoRecipes]);
  /** Where the source lies on the track (the track's own time), the clips Make will add, whether they are made. */
  const place = useMemo(() => (t ? sourcePlace(t, slots, videoRecipes) : null), [t, slots, videoRecipes]);
  const total = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;

  const { dropEdits, saveFailed, save, turn, inputsOf, editInputs, savedElsewhere, typeSource, sourceTyped, shown, formOf, ready, keptToClip, keepToClip } = useClipEdits({ timeline: t, clips, recipes, setup, settings, comfyOnline });
  /** What a clip says happens, in a few words, for the designer: its main text, or what it is. */
  const sayOf = (c: Clip) => {
    if (c.kind === "still") return `(a picture held on screen for ${(c.lengthMs / 1000).toFixed(1)} s${c.still?.name ? `: ${c.still.name}` : ""})`;
    const main = recipes.data?.recipes.find((r) => r.id === c.recipe)?.inputs.find((i) => i.type === "prompt" && !i.optional);
    return main ? String(inputsOf(c)[main.id] ?? "") : "(a video that was added as it is)";
  };

  /** A new clip that waits to be rendered. The first one of a timeline is given a model that can run. */
  const firstRecipe = () => {
    const usable = (r: RecipeInfo) => !notReady(setup.data?.recipes.find((x) => x.id === r.id), comfyOnline);
    return (videoRecipes.find((r) => r.traits?.continues && !r.traits.windows && usable(r)) ?? videoRecipes.find(usable) ?? videoRecipes[0])?.id;
  };
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  // one trim at a time (useOneTrim): one asked for before the last one's change is back waits, the last of its kind, and
  // is run from the timeline read back, through these runs as the render after it has them
  const oneTrim = useOneTrim();
  const m = useTimelineMutations(id, {
    timeline: t, clipsNow, recipes: recipes.data?.recipes ?? [], edits: { save, turn, ready, inputsOf, editInputs, dropEdits, savedElsewhere, sourceTyped }, firstRecipe,
    on: { note: setNote, select, unpick: () => setPicked(new Set()), writing: setWriting, open: setOpened, stepping: () => oneTrim.drop() },
  });
  const { after, readBack, render, patch, fix, edit, makeSource: makeSourceMut, cutSource: cutSourceMut, sourceForm: sourceFormMut, recording: recordingMut, trimSource: trimSourceMut, trimRecording: trimRecordingMut, splitSource, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan } = m;
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  /** The source taken away with the clips it made, rendered or not (one step for Undo), its panel closed. */
  const removeSource = useCallback(() => {
    oneTrim.drop();
    edit.mutate({ source: null });
    setSourceOpen(false);
  }, [oneTrim, edit, setSourceOpen]);
  // a source taken away or another one put in, from anywhere (the bar, another tab): a trim waiting was asked of the one
  // before, and would be sent to the new one, or as the settings of a source no longer there
  const sourceNow = t?.source?.asset ?? null;
  useEffect(() => {
    oneTrim.drop();
  }, [sourceNow]); // eslint-disable-line react-hooks/exhaustive-deps -- on the source's change only: dropped, nothing waits to drop again
  const removePicked = useCallback(() => {
    if (pickedNow.current.size < 2) return false;
    removeMany.mutate([...pickedNow.current]);
    return true;
  }, [removeMany]);
  const say = useBanners((b) => b.push);
  const durationMs = t?.durationMs ?? 0;
  const { range, setRange, rangeRef, loopRange, loopRef, snapQuiet, toggleSnapQuiet, playingRange, emptyRange, totalRef, toggle, toggleLoop, toggleLoopNow, rangeAct, rangeItems } = useRange({
    id, clips, durationMs, clock, player, playing, setPlaying,
    on: { after, select, note: setNote, say, writeBetween: (v) => writeBetween.mutate(v) },
  });
  // the right-click menus (a clip's, its sound's, a pinned frame's, the music's, the range's) and what a clip's says at its head
  const { clipMenu, soundMenu, pinMenu, musicMenu, rangeMenu, onClip, clipHead } = useEditorMenus(clips, player);
  // the latest that failed, the range's actions among the others (useTimelineMutations)
  const error = rangeAct.error && (!m.error || rangeAct.submittedAt >= m.errorAt) ? rangeAct.error : m.error;
  // an error goes after a while, not while the pointer is on it (the note's own timer is useHeaderNote's)
  const errorShown = useErrorShown(error, held);

  // the clips made from the source are sent to render once the timeline read again has them (their forms are read then);
  // made from a source with no form of its own (a swap's: its clips' form is the one), the first is opened instead, to set
  // the form every clip shares before anything renders (the owner, 2026-10-18)
  const [toRender, setToRender] = useState<{ ids: string[]; render: boolean } | null>(null);
  useEffect(() => {
    if (!toRender) return;
    const made = clips.filter((c) => toRender.ids.includes(c.id));
    if (made.length < toRender.ids.length) return;
    setToRender(null);
    setSourceOpen(false);
    if (!toRender.render) return void (made[0] && select(made[0].id));
    // only what can be rendered now: a model whose files or nodes are missing is said, the clips wait with their Render
    const why = made.map((c) => ready(c).why).find(Boolean);
    const now = made.filter((c) => ready(c).input);
    if (now.length) render.mutate({ clips: now });
    if (why) setNote(`${plural(made.length, "clip")} made from the source, not rendered: ${why}`);
  }, [clips, toRender, render, ready, setNote, setSourceOpen, select]);
  /** The source's stretch made into clips, sent to render in order (each waits for the one it carries on from). */
  const makeSource = {
    pending: makeSourceMut.isPending || Boolean(toRender),
    run: (andRender = true) => makeSourceMut.mutate(undefined, { onSuccess: (r) => setToRender({ ids: r.clips, render: andRender }) }),
  };
  /**
   * The source's window, scene cuts or run-up changed (a swap clip's Source chapter): the change saved, then the source cut again,
   * its rendered clips at the start kept and the first new one opened. Nothing renders.
   */
  const cutSource = {
    pending: edit.isPending || cutSourceMut.isPending,
    // what was typed over the windows and the source's form saved first: the windows not rendered are made anew from what
    // the server has, and a save still waiting would go to a window no longer there
    run: (change: { windowMs?: number; snap?: boolean; inputs?: Record<string, unknown>; recipe?: string; clip?: string }) =>
      void save().then(() => edit.mutate({ source: change }, { onSuccess: () => cutSourceMut.mutate(undefined, { onSuccess: (r) => setToRender({ ids: r.clips, render: false }) }) })),
  };

  /**
   * The source given another windowed form (a window clip's Model, or the source's). On the same grid (H3's three) at once,
   * its windows and takes kept; on another grid, said first in the Source chapter when that leaves rendered takes behind
   * (`formAsk`: Change or Keep), its windows made anew and the first opened. Nothing renders.
   */
  const [formAsk, setFormAsk] = useState<{ recipe: string; rendered: number; windows: number } | null>(null);
  const sourceForm = {
    pending: sourceFormMut.isPending,
    ask: formAsk,
    run: (recipeId: string, sure = false) => {
      const of = (id: string | null | undefined) => videoRecipes.find((r) => r.id === id);
      const made = t ? madeFromSource(t, videoRecipes) : [];
      const rendered = made.filter((c) => c.take).length;
      if (!sure && rendered > 0 && !sameWindowGrid(of(t?.source?.recipe), of(recipeId))) return setFormAsk({ recipe: recipeId, rendered, windows: made.length });
      setFormAsk(null);
      sourceFormMut.mutate(recipeId, { onSuccess: (r) => void (r.clips.length && setToRender({ ids: r.clips, render: false })) });
    },
    keep: () => setFormAsk(null),
  };

  /**
   * The source's stretch changed (its lane dragged, In / Out typed). Before Make, its settings only. After Make, trimmed
   * (trimSource): its end at once (windows set aside and brought back, takes kept); its start moved makes every window anew,
   * asked first in the Source chapter when that leaves rendered takes behind (`stretchAsk`: Change or Keep), the first
   * window opened so the question is in view.
   */
  const [stretchAsk, setStretchAsk] = useState<{ fromMs: number; toMs: number; rendered: number; windows: number } | null>(null);
  const [, readAgain] = useReducer((n: number) => n + 1, 0);
  const trimmed = (clips: string[]) => void (clips.length && setToRender({ ids: clips, render: false }));
  const runs = useRef<{ stretch: typeof stretch; recordingTrim: typeof recordingTrim; clips: Clip[]; videoRecipes: RecipeInfo[] }>(null!);
  /**
   * Each run settles true once its change is read back (or saved, before Make), false when it is not made (asked first,
   * failed, or another one asked for in its place while it waited): the lanes draw the stretch released until then.
   */
  const stretch = {
    // waiting for the trim on its way counts as under way: it is said in the Source chapter
    pending: trimSourceMut.isPending || oneTrim.waits("source"),
    ask: stretchAsk,
    run: (fromMs: number, toMs: number, sure = false): Promise<boolean> => {
      const made = t ? madeFromSource(t, videoRecipes) : [];
      // settled once read back, and with this editor drawn again then (`readAgain`), as a trim's settle is (useOneTrim's
      // `lifted`): the lane lets go of the stretch it drew on the settle, and would draw the old one until the timeline's
      // query told the editor of the new one
      if (!t?.source || !made.length) return edit.mutateAsync({ source: { fromMs, toMs } }).then(async () => {
        await readBack();
        readAgain();
        return true;
      }, () => false);
      if (oneTrim.busy) return oneTrim.later("source", () => runs.current.stretch.run(fromMs, toMs, sure));
      // the rendered windows a trim set aside are left behind too: counted with those on the track
      const rendered = made.filter((c) => c.take).length + (t.source.parkedTakes ?? 0);
      if (!sure && rendered > 0 && Math.round(fromMs) !== t.source.fromMs) {
        setStretchAsk({ fromMs, toMs, rendered, windows: made.length });
        select(made[0]!.id);
        return Promise.resolve(false);
      }
      setStretchAsk(null);
      return oneTrim.run(trimSourceMut.mutate, { fromMs, toMs }, trimmed);
    },
    keep: () => setStretchAsk(null),
  };

  /**
   * A recording's Lip sync clips trimmed (their Recording chapter's In / Out): the end at once, its start moved asked first
   * when that leaves rendered takes behind (`recordingAsk`: Change or Keep).
   */
  const [recordingAsk, setRecordingAsk] = useState<{ asset: string; fromMs: number; toMs: number; rendered: number; clips: number } | null>(null);
  const recordingTrim = {
    pending: trimRecordingMut.isPending,
    /** A trim of this recording waits for the one on its way (the source's, or another): said as under way as well. */
    waits: (asset: string) => oneTrim.waits(`recording:${asset}`),
    ask: recordingAsk,
    run: (asset: string, mine: Clip[], fromMs: number, toMs: number, sure = false): Promise<boolean> => {
      // its clips taken again from the timeline read back: the trim before may have made them anew
      if (oneTrim.busy) return oneTrim.later(`recording:${asset}`, () => runs.current.recordingTrim.run(asset, clipsOfRecording(runs.current.clips, runs.current.videoRecipes, asset), fromMs, toMs, sure));
      const startMs = Math.round(Number(mine[0]?.inputs.recordingStart ?? 0) * 1000);
      const rendered = mine.filter((c) => c.take).length + (t?.recordings?.find((r) => r.asset.id === asset)?.parkedTakes ?? 0);
      // asked in the first clip's Recording chapter, opened so the question is in view (its band dragged on the Audio row)
      if (!sure && rendered > 0 && Math.abs(fromMs - startMs) > 20) {
        setRecordingAsk({ asset, fromMs, toMs, rendered, clips: mine.length });
        select(mine[0]!.id);
        return Promise.resolve(false);
      }
      setRecordingAsk(null);
      return oneTrim.run(trimRecordingMut.mutate, { asset, fromMs, toMs }, trimmed);
    },
    keep: () => setRecordingAsk(null),
  };
  runs.current = { stretch, recordingTrim, clips, videoRecipes };

  /** A voice recording made into Lip sync clips, the first one opened (nothing renders: its scene is to be written first). */
  const recording = {
    pending: recordingMut.isPending,
    run: (asset: string, clip?: string) => recordingMut.mutate({ asset, clip }, { onSuccess: (r) => setToRender({ ids: r.clips, render: false }) }),
  };

  // a window of the source (Motion transfer) is made from its driving video: a clip added by hand, or extending one, takes
  // the timeline's other model, as the server does (timelinePlan.ts newClip), else the first that can run
  const hasRecipe = clips.some((c) => c.recipe && !recipes.data?.recipes.find((r) => r.id === c.recipe)?.traits?.windows);
  const newClip = (afterId?: string | null) => add.mutate({ after: afterId, recipe: hasRecipe ? undefined : firstRecipe() });
  /** A clip one place earlier or later on the timeline: one step to undo, as a drag along the track. */
  const move = useCallback((clip: string, by: -1 | 1) => {
    const to = moveAfter(clipsNow.current, clip, by);
    if (to !== undefined) patch.mutate({ clip, patch: { after: to } });
  }, [patch]);

  // what is left to render, and what rendering it takes on each machine (useRenderPlan.ts)
  const { missing, renderable, takes, takesOn, allMs, allOn, allBlocked, checks } = useRenderPlan({
    id, t, clips, picked, recipes: recipes.data?.recipes ?? NONE, ready, formOf, known: !recipes.isPending && !setup.isPending && !settings.isPending,
  });

  // the selected clip, told to the command bar (useSelectedClipBridge.ts)
  useSelectedClipBridge({ id, t, clips, current, recipes: recipes.data?.recipes, patch, inputsOf, rangeAct, edit, openSource });

  const { volume, muted, onVolume, onMute, cursor, setCursor, onTime, frameMs } = usePlayhead({ clock, clips, player, rangeRef, loopRef, playingRange, setPlaying });
  // a key held down sends one undo at a time: the next only once the last is back
  const stepping = undo.isPending || redo.isPending;
  // the keys' refs for what is set below: Ctrl+Enter renders, [ and ] jump, S and Ctrl+B split, Alt+[ and Alt+] step the take; - and =, Shift+Z: the track's zoom (filled by the track)
  const { selectedNow, renderNow, jumpNow, splitNow, takeNow, trackKeys } = useEditorKeys({ clock, player, toggle, undo: undo.mutate, canUndo: Boolean(t?.undo) && !stepping, redo: redo.mutate, canRedo: Boolean(t?.redo) && !stepping, remove: remove.mutate, removing: remove.isPending || removeMany.isPending, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameMs, selected: current?.id ?? null, setSelected, setPicked, musicOpen: musicOpen || sourceOpen, closeMusic: () => { setMusicOpen(false); setSourceOpen(false); }, removeOpen: () => {
    if (!sourceOpen || !t?.source) return false;
    removeSource();
    return true;
  }, sourceMark: (which) => {
    // the source on the stage (it plays in the track's own time): I and O set its stretch's In and Out at the playhead,
    // as dragging its lane's ends does (after Make, a trim: its start moved is asked first when it leaves rendered takes)
    if (!sourceOpen || !t?.source || !place) return false;
    const at = Math.round((cursor ?? clock.get()) - place.atMs);
    const fromMs = which === "in" ? Math.max(0, at) : t.source.fromMs;
    const toMs = which === "out" ? Math.min(place.lengthMs, at) : t.source.toMs;
    if (toMs - fromMs < 1000) {
      setNote(which === "in" ? "In has to be a second or more before the source's Out." : "Out has to be a second or more after the source's In.");
      return true;
    }
    stretch.run(fromMs, toMs);
    return true;
  } });
  // what the command bar asked of this timeline: done here, as the buttons and the keys do it
  const openExport = useBarRequests({ id, t, shown, clips, slots, missing, ready, render, undo, redo, remove, say, setNote, setSelected, select, setFin, setCursor, player, selectedNow, splitNow, takeNow });

  // the playhead's own steps: to the clip before or after, a split at it, the selected clip's take before or after
  const { jump, splitAt, splitHere, stepTake } = useClipSteps({ clips, slots, clock, player, cursor, split, patch, select, setNote, setSaid, setPreview });
  jumpNow.current = jump;
  splitNow.current = splitHere;
  takeNow.current = (by) => stepTake(selectedNow.current, by);

  // opened at a clip (?clip=N, from the viewer's "In … · clip N"): that clip selected, the playhead at its start
  const [, go] = useLocation();
  const askedClip = Number(new URLSearchParams(useSearch()).get("clip")) || 0;
  useEffect(() => {
    if (!askedClip || !t || !shown) return;
    const c = clips[askedClip - 1];
    if (c) {
      player.current?.seek(c.atMs);
      select(c.id);
    }
    go(`/timelines/${id}`, { replace: true });
  }, [askedClip, t, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- once per clip asked for: clips, go and id are read as they stand then

  /**
   * Cut the clip at this moment of it and add a clip that continues from there: one step to undo (the server stops the clip
   * where it was seen, `stopAtMs`, and adds the new clip together).
   */
  const continueFrom = (clip: Clip, localMs: number) => {
    const local = Math.max(0, Math.min(clip.lengthMs, localMs));
    const left = clip.lengthMs - local;
    const stopAtMs = clip.take && left > 60 && local > 300 ? Math.round(clip.take.startMs + local) : undefined;
    add.mutate({ after: clip.id, recipe: hasRecipe ? undefined : firstRecipe(), ...(stopAtMs !== undefined ? { stopAtMs } : {}) });
  };
  /** Cut the clip on screen at the frame shown, and add a clip that continues from there. */
  const continueHere = () => {
    const here = player.current?.where();
    if (!here) return;
    setPlaying(false);
    continueFrom(here.clip, here.localMs);
  };

  // what is worked out once the timeline is read: the shapes that do not fit, and the finished size (the timeline's shape
  // with as many pixels as its largest take, when a take is larger than the frame)
  const misfits = t ? clips.filter((c) => otherShape(c, t) && !c.fill).length : 0;
  const largest = Math.max(0, ...clips.map((c) => (c.take?.asset.width ?? 0) * (c.take?.asset.height ?? 0)));
  const finishedK = t?.width && t.height ? Math.sqrt(largest / (t.width * t.height)) : 1;
  const finishedSize = finishedK > 1.05 && t?.width && t.height ? `${Math.round((t.width * finishedK) / 8) * 8} × ${Math.round((t.height * finishedK) / 8) * 8}` : null;
  // the designer stays open from clip to clip: it is for the clip selected, each with its own conversation
  // a still, or a clip with no model, has nothing to write: its form shows, and the designer comes back on the next clip it can write for
  const designed = designing && current && current.kind !== "still" && recipes.data?.recipes.some((r) => r.id === current.recipe) ? current : undefined;
  /** "Fix all first" in the Export and Finish dialogs: the dialog closes onto the Overview, where Needs attention runs it. */
  const fixFirst = (plan: Parameters<typeof fix.mutate>[0] | null, close: () => void) => {
    close();
    setSelected(null);
    setMusicOpen(false);
    if (plan && !fix.isPending && !render.isPending) fix.mutate(plan);
  };
  const exportNow = (t: Timeline, editor = false) => setExp({ for: editor ? "editor" : "video", scale: 1, music: true, smooth: false, range: Boolean(range && !emptyRange), blend: true, match: true, fit: finishedSize ? "largest" : "timeline", web: 0, before: t.exported?.id ?? null, asked: Boolean(t.exporting) });
  // the keys' and the command bar's actions that need the timeline read
  if (t && shown) {
    renderNow.current = () => {
      const c = clips.find((x) => x.id === selectedNow.current);
      if (c && c.kind === "video" && !c.job && !render.isPending) render.mutate({ clips: [c] });
    };
    openExport.current = (editor) => exportNow(t, editor);
  }

  return {
    id, timeline, t, shown, clips, recipes, setup, settings, videoRecipes, running, panelWidth, folded, slots, total, current,
    selected, setSelected, select, joinOpen, setJoinOpen, openJoin, sourceOpen, setSourceOpen, openSource, removeSource, makeSource, cutSource, sourceForm, recording, stretch, recordingTrim, splitSource, masks, setMasks, maskOfCurrent, place, sourcePeek, setSourcePeek, whoPicking, setWhoPicking, picked, setPicked, musicOpen, setMusicOpen, playing, setPlaying, clock, pps, setPps,
    preview, setPreview, opened, setOpened, picking, setPicking, casting, setCasting, mood, setMood, setDesigning, designed,
    talks, setTalks, sessions, setSessions, note, setNote, setHeld, errorShown, exp, setExp, fin, setFin, writing, player,
    liveShown, saveFailed, save, typeSource, sourceTyped, inputsOf, editInputs, formOf, ready, keptToClip, keepToClip, sayOf, say, m, range, setRange, loopRange, snapQuiet,
    toggleSnapQuiet, emptyRange, toggle, toggleLoop, rangeAct, rangeItems, clipMenu, soundMenu, pinMenu, musicMenu, rangeMenu, onClip,
    newClip, move, missing, renderable, takes, takesOn, allMs, allOn, allBlocked, checks, volume, muted, onVolume, onMute, cursor, setCursor, onTime,
    trackKeys, jump, splitAt, stepTake, continueFrom, continueHere, misfits, finishedSize, fixFirst, exportNow, clipHead,
    after, render, patch, fix, edit, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan,
  };
}

/** The editor once its timeline is read: what its parts are drawn with. */
export type LoadedEditor = ReturnType<typeof useTimelineEditor> & { t: Timeline; shown: NonNullable<ReturnType<typeof useTimelineEditor>["shown"]> };
