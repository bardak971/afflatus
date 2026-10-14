import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import type { Asset, Clip, DesignerSession, RecipeInfo, Take, Timeline } from "../api";
import { useFamilies, useModelSettings, useRecipes, useSetup, useTimeline } from "../data";
import type { DesignerTurn } from "../designer/types";
import { notReady, plural } from "../format";
import { useBanners, useEditorColumn } from "../store";
import { useSelectedClip } from "../bar/bridge";
import { useQueueOf } from "../screens/studio/queueOf";
import { useNewClock } from "./clock";
import { rememberAspect } from "./EditorSkeleton";
import type { ExportAsk } from "./ExportDialog";
import type { Checks } from "./EditorColumns";
import { layout, moveAfter, otherShape, pinMirrors, ZOOM } from "./model";
import { sourcePlace } from "./track/SourceLane";
import type { PlayerHandle } from "./Player";
import { useClipEdits } from "./useClipEdits";
import { useClipSteps } from "./useClipSteps";
import { useEditorMenus } from "./useEditorMenus";
import { useBarRequests } from "./useBarRequests";
import { useEditorKeys } from "./useEditorKeys";
import { useErrorShown, useHeaderNote } from "./useHeaderNote";
import { usePlayhead } from "./usePlayhead";
import { useForecasts } from "./useForecasts";
import { useRange } from "./useRange";
import { useTimelineMutations } from "./useTimelineMutations";

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
  /** The clip whose join with the clip before is open in the column (its dot on the track was clicked). */
  const [joinOpen, setJoinOpen] = useState<string | null>(null);
  /** The source lane is open in the column. */
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The moment of the source a drag on its lane stands on: the stage shows it meanwhile. */
  const [sourcePeek, setSourcePeek] = useState<number | null>(null);
  /** A clip selected, its panel open in place of the music's. */
  const select = (clip: string | null) => {
    setSelected(clip);
    setMusicOpen(false);
    setJoinOpen(null);
    setSourceOpen(false);
  };
  /** The source lane, opened in the column: no clip selected meanwhile. */
  const openSource = () => {
    setSelected(null);
    setMusicOpen(false);
    setJoinOpen(null);
    setSourceOpen(true);
  };
  /** The join before a clip, opened in the column: the clip is selected with it. */
  const openJoin = (clip: string) => {
    setSelected(clip);
    setMusicOpen(false);
    setJoinOpen(clip);
  };

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
  // the video models that are on, and the ones a clip of this timeline is already made with
  const families = useFamilies();
  const videoRecipes = useMemo(
    () => (recipes.data?.recipes ?? []).filter((r) => r.output === "video" && (families.isOn(r.family) || clips.some((c) => c.recipe === r.id))),
    [recipes.data, families, clips],
  );
  const comfyOnline = setup.data?.comfy.online ?? false;
  const current = clips.find((c) => c.id === selected) ?? null;
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

  const { dropEdits, saveFailed, save, turn, inputsOf, editInputs, savedElsewhere, shown, formOf, ready } = useClipEdits({ timeline: t, clips, recipes, setup, settings, comfyOnline });
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
  const m = useTimelineMutations(id, {
    timeline: t, clipsNow, recipes: recipes.data?.recipes ?? [], edits: { save, turn, ready, inputsOf, editInputs, dropEdits, savedElsewhere }, firstRecipe,
    on: { note: setNote, select, unpick: () => setPicked(new Set()), writing: setWriting, open: setOpened },
  });
  const { after, render, patch, fix, edit, makeSource: makeSourceMut, splitSource, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan } = m;
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
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

  // the clips made from the source are sent to render once the timeline read again has them (their forms are read then)
  const [toRender, setToRender] = useState<string[] | null>(null);
  useEffect(() => {
    if (!toRender) return;
    const made = clips.filter((c) => toRender.includes(c.id));
    if (made.length < toRender.length) return;
    setToRender(null);
    setSourceOpen(false);
    // only what can be rendered now: a model whose files or nodes are missing is said, the clips wait with their Render
    const why = made.map((c) => ready(c).why).find(Boolean);
    const now = made.filter((c) => ready(c).input);
    if (now.length) render.mutate({ clips: now });
    if (why) setNote(`${plural(made.length, "clip")} made from the source, not rendered: ${why}`);
  }, [clips, toRender, render, ready, setNote]);
  /** The source's stretch made into clips, sent to render in order (each waits for the one it carries on from). */
  const makeSource = {
    pending: makeSourceMut.isPending || Boolean(toRender),
    run: () => makeSourceMut.mutate(undefined, { onSuccess: (r) => setToRender(r.clips) }),
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

  /** What is left to render: clips without a take, clips whose join went stale, and clips whose take was made with other flips than Mirror asks now. */
  const missing = clips.filter((c) => c.kind === "video" && !c.job && (!c.take || c.join === "stale" || c.mirrorChanged) && ready(c).input);
  const renderable = (c: Clip) => picked.has(c.id) && c.kind === "video" && Boolean(ready(c).input);

  /** About how long a clip takes to render: the server's forecast of its whole form, learned from past renders (as the timeline card's). */
  const takes = useForecasts(clips, recipes.data?.recipes ?? NONE, formOf);
  const allMs = missing.reduce((sum, c) => sum + (takes(c) ?? 0), 0);
  /** What Needs attention is worked out from (EditorColumns' Checks). */
  const checks: Checks = {
    renderable: (c: Clip) => c.kind === "video" && !c.job && Boolean(ready(c).input),
    msOf: takes,
    why: (c: Clip) => (c.kind === "video" ? ready(c).why : undefined),
    // settled, not succeeded: a list that failed to come must not hold the checks back for ever
    known: !recipes.isPending && !setup.isPending && !settings.isPending,
  };

  // the selected clip, for the command bar's `@name`: who is in it and the Inspector's own change of its cast
  const patchNow = patch.mutateAsync;
  const castRecipe = current?.recipe ? recipes.data?.recipes.find((r) => r.id === current.recipe) ?? null : null;
  const castNumber = current ? clips.indexOf(current) + 1 : 0;
  useEffect(() => {
    if (!current || !t) return void useSelectedClip.getState().set(null);
    useSelectedClip.getState().set({
      timeline: id, timelineName: t.name, id: current.id, number: castNumber, kind: current.kind, recipe: castRecipe,
      look: current.look ?? t.look, own: current.look !== null, setLook: (look) => patchNow({ clip: current.id, patch: { look } }),
      // its pinned frames' Mirror, for the bar's `> mirror pin`: its form as it stands, the Inspector's edits not yet saved included
      pins: pinMirrors(current, castRecipe ?? undefined, inputsOf(current), castNumber > 1 && current.joined === "continue" && current.kind === "video"),
      mirror: (input, on) => patchNow({ clip: current.id, patch: { pinMirror: { [input]: on } } }),
    });
  }, [current, t, id, castNumber, castRecipe, patchNow, inputsOf]);
  useEffect(() => () => useSelectedClip.getState().set(null), []);

  const { volume, muted, onVolume, onMute, cursor, setCursor, onTime, frameMs } = usePlayhead({ clock, clips, player, rangeRef, loopRef, playingRange, setPlaying });
  // a key held down sends one undo at a time: the next only once the last is back
  const stepping = undo.isPending || redo.isPending;
  // the keys' refs for what is set below: Ctrl+Enter renders, [ and ] jump, S and Ctrl+B split, Alt+[ and Alt+] step the take; - and =, Shift+Z: the track's zoom (filled by the track)
  const { selectedNow, renderNow, jumpNow, splitNow, takeNow, trackKeys } = useEditorKeys({ clock, player, toggle, undo: undo.mutate, canUndo: Boolean(t?.undo) && !stepping, redo: redo.mutate, canRedo: Boolean(t?.redo) && !stepping, remove: remove.mutate, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameMs, selected: current?.id ?? null, setSelected, setPicked, musicOpen: musicOpen || sourceOpen, closeMusic: () => { setMusicOpen(false); setSourceOpen(false); } });
  // what the command bar asked of this timeline: done here, as the buttons and the keys do it
  const openExport = useBarRequests({ id, t, shown, clips, slots, missing, ready, render, undo, redo, say, setNote, setSelected, select, setFin, setCursor, player, selectedNow, splitNow, takeNow });

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
    selected, setSelected, select, joinOpen, setJoinOpen, openJoin, sourceOpen, setSourceOpen, openSource, makeSource, splitSource, place, sourcePeek, setSourcePeek, picked, setPicked, musicOpen, setMusicOpen, playing, setPlaying, clock, pps, setPps,
    preview, setPreview, opened, setOpened, picking, setPicking, casting, setCasting, mood, setMood, setDesigning, designed,
    talks, setTalks, sessions, setSessions, note, setNote, setHeld, errorShown, exp, setExp, fin, setFin, writing, player,
    liveShown, saveFailed, save, inputsOf, editInputs, formOf, ready, sayOf, say, m, range, setRange, loopRange, snapQuiet,
    toggleSnapQuiet, emptyRange, toggle, toggleLoop, rangeAct, rangeItems, clipMenu, soundMenu, pinMenu, musicMenu, rangeMenu, onClip,
    newClip, move, missing, renderable, takes, allMs, checks, volume, muted, onVolume, onMute, cursor, setCursor, onTime,
    trackKeys, jump, splitAt, stepTake, continueFrom, continueHere, misfits, finishedSize, fixFirst, exportNow, clipHead,
    after, render, patch, fix, edit, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan,
  };
}

/** The editor once its timeline is read: what its parts are drawn with. */
export type LoadedEditor = ReturnType<typeof useTimelineEditor> & { t: Timeline; shown: NonNullable<ReturnType<typeof useTimelineEditor>["shown"]> };
