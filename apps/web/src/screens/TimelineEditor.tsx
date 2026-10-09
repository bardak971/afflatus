import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { api, type Asset, type Clip, type DesignerSession, type RecipeInfo, type Take } from "../api";
import { useFamilies, useModelSettings, useRecipes, useSetup, useTimeline } from "../data";
import type { DesignerTurn } from "../Designer";
import { clock as mmss, notReady } from "../format";
import { Picker } from "../PictureField";
import { useNewClock } from "../timeline/clock";
import { Inspector, MusicPanel } from "../timeline/Inspector";
import { layout, moveAfter, otherShape, pinInputs, SHAPES, shapeOf, splitPoint, stamp, ZOOM, type Shape } from "../timeline/model";
import { Player, type PlayerHandle } from "../timeline/Player";
import { MediaOverlay } from "../timeline/MediaOverlay";
import { Track, type TrackKeys } from "../timeline/Track";
import { ErrorNote, PanelEdge } from "../ui";
import { FinishDialog } from "../timeline/Finish";
import { Viewer } from "../Viewer";
import { ContextMenu, useMenu, type MenuHead } from "../ContextMenu";
import { useBanners, usePanelWidth } from "../store";
import { CastDialog } from "../timeline/CastDialog";
import { ClipDesigner } from "../timeline/ClipDesigner";
import { TimelineHeader, Transport } from "../timeline/EditorBars";
import { ExportDialog, type ExportAsk } from "../timeline/ExportDialog";
import { clipMenuItems, musicMenuItems, placeItems, soundMenuItems, type ClipMenuActions } from "../timeline/menus";
import { Overview } from "../timeline/Overview";
import { RangeBar } from "../timeline/RangeBar";
import { StartPanel } from "../timeline/StartPanel";
import { useClipEdits } from "../timeline/useClipEdits";
import { useEditorKeys } from "../timeline/useEditorKeys";
import { useForecasts } from "../timeline/useForecasts";
import { useRange } from "../timeline/useRange";
import { useTimelineMutations } from "../timeline/useTimelineMutations";
import { useSelectedClip, useTimelineRequest } from "../bar/bridge";
import { useQueueOf } from "./studio/queueOf";

const NONE: RecipeInfo[] = [];

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
  // only which clip renders: the queue changes at every step of a render, and the parts that show its progress read it themselves
  const running = useQueueOf((q) => q.running?.clipId ?? null) ?? null;
  const settings = useModelSettings();
  const panelWidth = usePanelWidth((st) => st.width);

  const [selected, setSelected] = useState<string | null>(null);
  /** The clips picked with Ctrl + click on the track, to render together. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [musicOpen, setMusicOpen] = useState(false);
  // for Escape, which closes it as it closes a clip's panel
  const musicOpenNow = useRef(false);
  musicOpenNow.current = musicOpen;
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
  /** A line in the header, and what more there is to it (behind its "?"); `undo`: an Undo beside it, for what it says was done. */
  const [note, setSaid] = useState<{ text: string; more?: string; undo?: boolean } | null>(null);
  const setNote = useCallback((text: string | null, more?: string) => setSaid(text === null ? null : { text, more }), []);
  /** The pointer rests on what the header says: it stays while it is read. */
  const [held, setHeld] = useState(false);
  const [exp, setExp] = useState<ExportAsk | null>(null);
  const [fin, setFin] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);
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
  const total = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;

  const { dropEdits, saveFailed, save, inputsOf, editInputs, shown, formOf, ready } = useClipEdits({ timeline: t, clips, recipes, setup, settings, comfyOnline });
  /** What a clip says happens, in a few words, for the designer: its main text, or what it is. */
  const sayOf = (c: Clip) => {
    if (c.kind === "still") return `(a picture held on screen for ${(c.lengthMs / 1000).toFixed(1)} s${c.still?.name ? `: ${c.still.name}` : ""})`;
    const main = recipes.data?.recipes.find((r) => r.id === c.recipe)?.inputs.find((i) => i.type === "prompt" && !i.optional);
    return main ? String(inputsOf(c)[main.id] ?? "") : "(a video that was added as it is)";
  };

  /** A new clip that waits to be rendered. The first one of a timeline is given a model that can run. */
  const firstRecipe = () => {
    const usable = (r: RecipeInfo) => !notReady(setup.data?.recipes.find((x) => x.id === r.id), comfyOnline);
    return (videoRecipes.find((r) => r.traits?.continues && usable(r)) ?? videoRecipes.find(usable) ?? videoRecipes[0])?.id;
  };
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  const m = useTimelineMutations(id, {
    timeline: t, clipsNow, recipes: recipes.data?.recipes ?? [], edits: { save, ready, inputsOf, editInputs, dropEdits }, firstRecipe,
    on: { note: setNote, select, unpick: () => setPicked(new Set()), writing: setWriting, open: setOpened },
  });
  const { after, render, patch, fix, edit, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan } = m;
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
  /** The head of a clip's menu: "Clip 3", its length and which take plays, the picture it shows. */
  const clipHead = (c: Clip): MenuHead => {
    const n = clips.findIndex((x) => x.id === c.id) + 1;
    const take = c.take && c.takes.length > 1 ? ` · take ${c.takes.findIndex((x) => x.id === c.take!.id) + 1} of ${c.takes.length}` : "";
    return {
      title: `Clip ${n}`,
      thumb: c.take?.asset.id ?? c.still?.id ?? c.pictures[0]?.asset.id,
      sub: <>{c.kind === "still" ? "Still · " : ""}<span className="font-mono">{mmss(c.lengthMs)}</span>{take}</>,
    };
  };
  /** The head of a clip's audio menu: what is heard, and how loud. */
  const soundHead = (c: Clip): MenuHead => ({
    title: `Audio of clip ${clips.findIndex((x) => x.id === c.id) + 1}`,
    sub: `${c.sound === "own" ? "Own audio" : c.sound === "muted" ? "Muted" : "Audio file"} · ${c.volume} %`,
  });
  // the latest that failed, the range's actions among the others (useTimelineMutations)
  const error = rangeAct.error && (!m.error || rangeAct.submittedAt >= m.errorAt) ? rangeAct.error : m.error;
  // a note goes after a few seconds (longer with more to read behind its "?"), an error after a while: not while the pointer is on it
  useEffect(() => {
    if (!note || held) return;
    const timer = setTimeout(() => setSaid(null), note.more ? 12_000 : 4000);
    return () => clearTimeout(timer);
  }, [note, held]);
  const [errorGone, setErrorGone] = useState<Error | null>(null);
  useEffect(() => {
    if (!error || held) return;
    const timer = setTimeout(() => setErrorGone(error), 10_000);
    return () => clearTimeout(timer);
  }, [error, held]);
  const errorShown = error && error !== errorGone ? error : null;

  const hasRecipe = clips.some((c) => c.recipe);
  const newClip = (afterId?: string | null) => add.mutate({ after: afterId, recipe: hasRecipe ? undefined : firstRecipe() });
  /** A clip one place earlier or later on the timeline: one step to undo, as a drag along the track. */
  const move = useCallback((clip: string, by: -1 | 1) => {
    const to = moveAfter(clipsNow.current, clip, by);
    if (to !== undefined) patch.mutate({ clip, patch: { after: to } });
  }, [patch]);

  /** What is left to render: clips without a take, and clips whose join went stale. */
  const missing = clips.filter((c) => c.kind === "video" && !c.job && (!c.take || c.join === "stale") && ready(c).input);
  const renderable = (c: Clip) => picked.has(c.id) && c.kind === "video" && Boolean(ready(c).input);

  /** About how long a clip takes to render: the server's forecast of its whole form, learned from past renders (as the timeline card's). */
  const takes = useForecasts(clips, recipes.data?.recipes ?? NONE, formOf);
  const allMs = missing.reduce((sum, c) => sum + (takes(c) ?? 0), 0);

  // what the command bar asked of this timeline (render clips by number, render what is missing, export): done here, as
  // the buttons do it, once the timeline and its forms are read
  const openExport = useRef<(() => void) | null>(null);
  const request = useTimelineRequest((r) => r.request);
  useEffect(() => {
    if (!request || request.timeline !== id || !t || !shown) return;
    // Fix all is the overview's, which measures the joins: the clip's panel gives way to it, and it takes the request
    if (request.do === "fix-all" && clips.length) return setSelected(null);
    const asked = useTimelineRequest.getState().take();
    if (request.do === "fix-all") {
      asked?.reply(null);
      return say({ id: `bar-fix:${Date.now()}`, tone: "good", title: `${t.name}: nothing to fix`, text: "It has no clip yet.", href: `/timelines/${id}`, go: "Open the timeline" });
    }
    if (request.do === "export") {
      asked?.reply(null);
      return openExport.current?.();
    }
    // the Finish dialog, as the Finish button opens it
    if (request.do === "finish") {
      asked?.reply(null);
      return setFin(true);
    }
    // the selected clip split at the playhead, or playing its take before or after: as S and Alt+[ ] do it, said in the note
    if (request.do === "split" || request.do === "take") {
      asked?.reply(null);
      if (request.do === "split") splitNow.current(selectedNow.current);
      else takeNow.current(request.by);
      return;
    }
    const list = request.do === "render-missing" ? missing : clips.filter((c, i) => request.clips.includes(i + 1) && c.kind === "video" && !c.job && ready(c).input);
    if (!list.length) {
      asked?.reply(null);
      say({ id: `bar-render:${Date.now()}`, tone: "bad", title: request.do === "render-missing" ? `${t.name} has no clip left to render` : `Nothing to render in clip${request.clips.length > 1 ? "s" : ""} ${request.clips.join(", ")}`, text: request.do === "render" ? "A clip renders when it is a video clip with its form filled, and is not already in the queue." : undefined, href: `/timelines/${id}`, go: "Open the timeline" });
      return;
    }
    // (the promise, not the mutation's own callbacks: those are dropped when the editor is left before the answer)
    render.mutateAsync({ clips: list }).then(
      (made) => {
        asked?.reply(made.ids);
        // sent to the top of the queue: the bar says so once they are there
        if (!request.top) say({ id: `bar-render:${Date.now()}`, tone: "good", title: `${list.length} clip${list.length > 1 ? "s" : ""} of ${t.name} queued`, href: "/queue", go: "Open queue" });
      },
      (err: Error) => {
        asked?.reply(null);
        say({ id: `bar-render:${Date.now()}`, tone: "bad", title: `Clips of ${t.name} could not be rendered`, text: err.message, href: `/timelines/${id}`, go: "Open the timeline" });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, id, t, shown]);

  // the selected clip, for the command bar's `@name`: who is in it and the Inspector's own change of its cast
  const setLook = patch.mutateAsync;
  const castRecipe = current?.recipe ? recipes.data?.recipes.find((r) => r.id === current.recipe) ?? null : null;
  const castNumber = current ? clips.indexOf(current) + 1 : 0;
  useEffect(() => {
    if (!current || !t) return void useSelectedClip.getState().set(null);
    useSelectedClip.getState().set({
      timeline: id, timelineName: t.name, id: current.id, number: castNumber, kind: current.kind, recipe: castRecipe,
      look: current.look ?? t.look, own: current.look !== null, setLook: (look) => setLook({ clip: current.id, patch: { look } }),
    });
  }, [current, t, id, castNumber, castRecipe, setLook]);
  useEffect(() => () => useSelectedClip.getState().set(null), []);

  /** How loud the player plays here (0 to 1) and whether it is muted: this browser's, over the timeline's own mix. */
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem("afflatus.player.volume"));
      return Number.isFinite(v) && localStorage.getItem("afflatus.player.volume") !== null ? Math.max(0, Math.min(1, v)) : 1;
    } catch {
      return 1;
    }
  });
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("afflatus.player.volume", String(volume));
    } catch {
      /* a private window: not kept */
    }
  }, [volume]);
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
  // a key held down sends one undo at a time: the next only once the last is back
  const stepping = undo.isPending || redo.isPending;
  // Ctrl+Enter: the selected clip renders (set once the clip actions exist, below)
  const renderNow = useRef(() => {});
  // [ and ]: the clip before or after (set once jump exists, below)
  const jumpNow = useRef<(by: -1 | 1) => void>(() => {});
  // S and Ctrl+B: split at the playhead; Alt+[ and Alt+]: the selected clip's take before or after (set below)
  const splitNow = useRef<(only?: string | null) => void>(() => {});
  const takeNow = useRef<(by: -1 | 1) => void>(() => {});
  // - and =, Shift+Z: the track's zoom and Fit all (filled by the track)
  const trackKeys = useRef<TrackKeys | null>(null);
  useEditorKeys({ clock, player, toggle, undo: undo.mutate, canUndo: Boolean(t?.undo) && !stepping, redo: redo.mutate, canRedo: Boolean(t?.redo) && !stepping, remove: remove.mutate, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameRef, selectedNow, setSelected, setPicked, musicOpenNow, closeMusic: () => setMusicOpen(false), renderNow, jumpNow, splitNow, takeNow, trackKeys });

  const jump = (by: -1 | 1) => {
    const time = clock.get();
    const playable = clips.filter((c) => c.lengthMs > 0);
    const here = playable.findIndex((c) => time >= c.atMs && time < c.atMs + c.lengthMs);
    // back: to the start of this clip, or of the one before when already there
    const target = by === 1 ? playable[here + 1] : time - (playable[here]?.atMs ?? 0) > 400 ? playable[here] : playable[Math.max(0, here - 1)];
    if (!target) return;
    player.current?.seek(target.atMs);
    select(target.id);
  };
  jumpNow.current = jump;

  /** A clip split at this moment of its video, said in the header once made ("Split clip 3 at 0:12.4", Undo beside it). */
  const splitAt = (clip: Clip, atMs: number) => {
    const n = clipsNow.current.findIndex((x) => x.id === clip.id) + 1;
    const when = stamp(clock.get());
    split.mutate({ clip: clip.id, atMs }, { onSuccess: () => setSaid({ text: `Split clip ${n} at ${when}`, undo: true }) });
  };
  /**
   * S and Ctrl+B: the clip under the playhead split there; with `only` (the bar, for the selected clip) when it is that clip.
   * Only inside what a clip plays, never on a cut: else the note says why and nothing changes.
   */
  splitNow.current = (only) => {
    if (split.isPending) return;
    const here = player.current?.where();
    // the playhead put by hand on a clip with nothing rendered stands there, not on the clip the player shows
    const by = cursor;
    const slot = by !== null ? slots.find((x) => by >= x.startMs && by < x.startMs + x.lengthMs) : undefined;
    const c = clips.find((x) => x.id === (slot?.planned ? slot.clip.id : here?.clip.id));
    if (!c) return setNote("No clip under the playhead");
    const n = clips.indexOf(c) + 1;
    if (only && only !== c.id) return setNote(`The playhead is not on clip ${clips.findIndex((x) => x.id === only) + 1}`);
    const cut = splitPoint(c, here && here.clip.id === c.id ? here.assetMs : -1);
    if ("why" in cut) return setNote(`Clip ${n} not split: ${cut.why}`);
    splitAt(c, cut.at);
  };
  // the take last asked from the keys, until the timeline read again plays it: a second press goes on from there
  const askedTake = useRef<{ clip: string; take: string; at: number } | null>(null);
  /** The selected clip plays its take before or after, as a click on it in the clip panel; at either end it stays, and says so. */
  const stepTake = (clipId: string | null, by: -1 | 1) => {
    const c = clips.find((x) => x.id === clipId);
    if (!c) return setNote("No clip selected");
    const n = clips.indexOf(c) + 1;
    const a = askedTake.current;
    const playing = a && a.clip === c.id && performance.now() - a.at < 3000 && c.takes.some((x) => x.id === a.take) ? a.take : c.take?.id;
    const i = c.takes.findIndex((x) => x.id === playing);
    if (c.takes.length < 2 || i < 0) return setNote(c.takes.length ? `Clip ${n} has one take` : `Clip ${n} has no take yet`);
    const to = c.takes[i + by];
    if (!to) return setNote(`Clip ${n} plays its ${by < 0 ? "first" : "last"} take already`);
    askedTake.current = { clip: c.id, take: to.id, at: performance.now() };
    setPreview(null);
    patch.mutate({ clip: c.id, patch: { take: to.id } });
    setNote(`Clip ${n} plays take ${i + by + 1} of ${c.takes.length}`);
  };
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
  }, [askedClip, t, shown]); // eslint-disable-line react-hooks/exhaustive-deps

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
  renderNow.current = () => {
    const c = clips.find((x) => x.id === selectedNow.current);
    if (c && c.kind === "video" && !c.job && !render.isPending) render.mutate({ clips: [c] });
  };
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
    split: (clip, atMs) => {
      const c = clips.find((x) => x.id === clip);
      if (c) splitAt(c, atMs);
    },
    stepTake,
    duplicate: (clip) => duplicate.mutate(clip),
    loop: (c) => loop.mutate(c),
    continueFrom,
    frame: (asset, at) => frame.mutate({ asset, at }),
    open: setOpened,
    slow: (factor, inMs, outMs) => rangeAct.mutate({ slow: factor, inMs, outMs }),
    remove: (clip) => remove.mutate(clip),
    move,
    picked,
    removeMany: (ids) => removeMany.mutate(ids),
  };
  const placing = {
    current, clips, recipes: recipes.data?.recipes ?? [], music: Boolean(t.music), inputsOf, editInputs, select,
    patch: (clip: string, p: { soundAsset: string }) => patch.mutate({ clip, patch: p }),
    edit: (p: Parameters<typeof edit.mutate>[0]) => edit.mutate(p),
    openMusic: () => setMusicOpen(true),
    add: (v: { asset: string; after?: string | null }) => add.mutate(v),
  };
  // the designer stays open from clip to clip: it is for the clip selected, each with its own conversation
  // a still, or a clip with no model, has nothing to write: its form shows, and the designer comes back on the next clip it can write for
  const designed = designing && current && current.kind !== "still" && recipes.data?.recipes.some((r) => r.id === current.recipe) ? current : undefined;
  const exportNow = () => setExp({ scale: 1, music: true, smooth: false, range: Boolean(range && !emptyRange), blend: true, match: true, fit: finishedSize ? "largest" : "timeline", web: 0, before: t.exported?.id ?? null, asked: Boolean(t.exporting) });
  openExport.current = exportNow;

  return (
    <div className="flex min-w-0 grow flex-col">
      <TimelineHeader
        t={t}
        clips={clips}
        total={total}
        saveFailed={saveFailed}
        onRetrySave={() => void save()}
        said={{ error: errorShown, note }}
        onHold={setHeld}
        undo={{ run: () => undo.mutate(), pending: undo.isPending }}
        redo={{ run: () => redo.mutate(), pending: redo.isPending }}
        missing={missing}
        allMs={allMs}
        picked={{ size: picked.size, renderable: clips.some(renderable) }}
        rendering={render.isPending}
        onRename={(name) => edit.mutate({ name })}
        onRenderMissing={() => render.mutate({ clips: missing })}
        onRenderPicked={() => { render.mutate({ clips: clips.filter(renderable) }); setPicked(new Set()); }}
        onFinish={() => setFin(true)}
        onExport={exportNow}
      />

      <div className="flex min-h-0 grow">
        {/* the media and the player side by side, and under both the row that plays: it starts at the left edge */}
        <div className="flex min-w-0 grow flex-col">
        <div className="relative flex min-h-0 grow">
        <MediaOverlay timeline={shown} placeItems={(a) => placeItems(a, placing)} />

        <main className="flex min-w-0 grow flex-col">
            <Player ref={player} timeline={t.id} clips={clips} music={t.music} frame={t.width && t.height ? { width: t.width, height: t.height } : null} playing={playing} onPlaying={setPlaying} onTime={onTime} preview={preview} live={liveShown} onStop={(job) => stop.mutate(job)} master={muted ? 0 : volume} screen={{ clock, total, playing, volume, muted, onToggle: toggle, onSeek: (ms) => player.current?.seek(ms), onVolume: (v) => { setVolume(v); setMuted(false); }, onMute: () => { if (volume === 0) { setVolume(1); setMuted(false); } else setMuted((x) => !x); }, onJump: jump, loop: range ? { on: loopRange, toggle: toggleLoop } : undefined }} onPickPreview={(take) => { if (current) patch.mutate({ clip: current.id, patch: { take: take.id } }); setPreview(null); }} />
        </main>
        </div>
          {range && <RangeBar range={range} emptyRange={emptyRange} clips={clips} snapQuiet={snapQuiet} onSnapQuiet={toggleSnapQuiet} items={rangeItems()} />}
          <Transport
            t={t}
            clock={clock}
            slots={slots}
            cursor={cursor}
            total={total}
            playing={playing}
            ranged={Boolean(range && !emptyRange)}
            loopRange={loopRange}
            volume={volume}
            muted={muted}
            adding={add.isPending}
            saving={frame.isPending}
            onJump={jump}
            onToggle={toggle}
            onToggleLoop={toggleLoop}
            onVolume={(v) => { setVolume(v); setMuted(false); }}
            onMute={() => { if (volume === 0) { setVolume(1); setMuted(false); } else setMuted((x) => !x); }}
            onFullscreen={() => player.current?.fullscreen()}
            onExtend={continueHere}
            onSaveFrame={() => {
              const here = player.current?.where();
              if (here?.clip.take) frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
              else if (here?.clip.still) setOpened(here.clip.still);
            }}
          />

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
          // a clip with nothing to play yet renders from the track itself, as from its menu
          renderOf={(c) => (c.kind === "video" && !c.job && ready(c).input && !render.isPending ? { run: () => render.mutate({ clips: [c] }), ms: takes(c) } : null)}
          busy={add.isPending}
          onSelect={(clipId) => select(clipId)}
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
            select(clip.id);
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
          onMusicEdit={(p) => edit.mutate(p)}
          onClipMusic={(clip, music) => patch.mutate({ clip: clip.id, patch: { music } })}
          range={range}
          onRange={setRange}
          onRangeMenu={(e) => rangeMenu.open(e, true)}
          snapQuiet={snapQuiet}
          keys={trackKeys}
        />
        </div>

        {musicOpen && t.music ? (
          <MusicPanel timeline={t} onEdit={(p) => edit.mutate(p)} onClose={() => setMusicOpen(false)} />
        ) : current ? (
          <Inspector
            key={current.id}
            onSelectClip={select}
            timeline={t}
            clip={current}
            index={clips.indexOf(current)}
            recipes={videoRecipes}
            stored={inputsOf(current)}
            whole={formOf(current)}
            why={why}
            takesMs={takes(current)}
            busy={render.isPending}
            // a render that failed for this clip, not for another one
            error={render.isError && render.variables?.clips.some((c) => c.id === current.id) ? render.error.message : null}
            onInputs={(next) => editInputs(current, next)}
            onRecipe={(recipe) => patch.mutate({ clip: current.id, patch: { recipe } })}
            onPatch={(p) => patch.mutate({ clip: current.id, patch: p })}
            onRender={(count) => render.mutate({ clips: [current], takes: count })}
            onRemove={() => {
              remove.mutate(current.id);
              setSelected(null);
            }}
            onRemoveTake={(takeId) => removeTake.mutate(takeId)}
            onStop={() => current.job && stop.mutate(current.job.id)}
            onDesigner={() => setDesigning((d) => (d ? null : current.id))}
            designer={designed ? (
              <ClipDesigner
                timeline={t}
                clip={designed}
                clips={clips}
                recipes={recipes.data?.recipes ?? []}
                setup={setup}
                settings={settings}
                inputsOf={inputsOf}
                sayOf={sayOf}
                turns={talks[designed.id]}
                onTurns={(turns) => setTalks((all) => ({ ...all, [designed.id]: turns }))}
                session={sessions[designed.id]}
                onSession={(session) => setSessions((all) => ({ ...all, [designed.id]: session }))}
                onApply={(changes) => editInputs(designed, { ...inputsOf(designed), ...changes })}
                onClose={() => setDesigning(null)}
              />
            ) : undefined}
            onClose={() => setSelected(null)}
            onPreview={setPreview}
            writing={writeBetween.isPending && writing === current.id}
            writeError={writeBetween.isError && writeBetween.variables?.clip === current.id && writeBetween.variables.force ? writeBetween.error.message : null}
            onWriteBetween={() => writeBetween.mutate({ clip: current.id, force: true })}
          />
        ) : (
          // as wide as the clip's panel, and widened the same way: the stage keeps its size from one to the other
          <aside style={{ width: panelWidth }} className="relative flex shrink-0 flex-col border-l border-line bg-panel text-ink-2">
            <PanelEdge side="left" />
            <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-5">
            <span className="text-[17px] font-bold text-ink">{clips.length ? t.name : "Start your video"}</span>
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
                renderable={(c) => c.kind === "video" && !c.job && Boolean(ready(c).input)}
                msOf={takes}
                onPick={(id) => select(id)}
                onMusic={() => setMusicOpen(true)}
                onCast={() => setCasting(true)}
                onFolder={(folder) => edit.mutate({ folder })}
                onFix={(f) => fix.mutate(f)}
                picked={picked}
                onRenderPicked={() => { render.mutate({ clips: clips.filter(renderable) }); setPicked(new Set()); }}
                rendering={render.isPending || fix.isPending}
              />
            ) : (
              <StartPanel busy={add.isPending} planning={plan.isPending} onPickImage={() => setPicking(true)} onPlan={(idea, count) => plan.mutate({ idea, clips: count })} onNewClip={() => newClip()} />
            )}
            </div>
          </aside>
        )}
      </div>

      {clipMenu.menu && <ContextMenu at={clipMenu.menu.at} label="Actions on this clip" head={clipHead(clipMenu.menu.subject)} items={clipMenuItems(clipMenu.menu.subject, clipActs)} onClose={clipMenu.close} />}
      {rangeMenu.menu && range && <ContextMenu at={rangeMenu.menu.at} label="Actions on the range" head={{ title: "Range", sub: <span className="font-mono">{mmss(range.inMs, { decimals: 1 })} – {mmss(range.outMs, { decimals: 1 })}</span> }} items={rangeItems()} onClose={rangeMenu.close} />}
      {soundMenu.menu && <ContextMenu at={soundMenu.menu.at} label="The audio of this clip" head={soundHead(shown.clips.find((x) => x.id === soundMenu.menu!.subject.id) ?? soundMenu.menu.subject)} items={soundMenuItems(shown.clips.find((x) => x.id === soundMenu.menu!.subject.id) ?? soundMenu.menu.subject, { patch: (clip, p) => patch.mutate({ clip, patch: p }), pick: setSoundPick, select })} onClose={soundMenu.close} />}
      {musicMenu.menu && <ContextMenu at={musicMenu.menu.at} label="The music" head={{ title: "Music", sub: t.music ? t.music.asset.name || "Sound" : "None yet" }} items={musicMenuItems(t.music, { pick: () => setMusicPick(true), open: () => { setSelected(null); setMusicOpen(true); }, edit: (p) => edit.mutate(p) })} onClose={musicMenu.close} />}
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
          // ComfyUI's upscale_models, as any recipe with an upscale model to pick lists them
          upscaleModels={setup.data?.recipes.find((r) => r.options.upscaleModel?.length)?.options.upscaleModel ?? []}
          onClose={() => setFin(false)}
          onQueued={(r) => {
            after();
            setFin(false);
            setNote(`${r.jobs.length} clip${r.jobs.length === 1 ? "" : "s"} finishing in the queue${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, `One job each; the finished takes arrive as they land.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `clip ${x.clip} (${x.why})`).join(", ")}.` : ""}`);
          }}
        />
      )}
      {casting && <CastDialog timeline={t} mood={mood} onMood={setMood} onEdit={(p) => edit.mutate(p)} onClose={() => setCasting(false)} />}
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
