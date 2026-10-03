import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Camera, Copy, Download, Eye, ImagePlus, Link2, Magnet, Pause, Play, Plus, RefreshCw, Repeat, Scissors, SkipBack, SkipForward, Split, Trash2, Undo2, Users, Volume2, VolumeX, Wand2, X } from "lucide-react";
import { api, fileUrl, type Asset, type Clip, type ClipPatch, type DesignerSession, type RecipeInfo, type Take, type TimelinePatch } from "../api";
import { useEntities, useEstimates, useFamilies, useModelSettings, useQueue, useRecipes, useSetup, useTimeline } from "../data";
import { Designer, type DesignerTurn } from "../Designer";
import { LookBar, lookWords } from "../LookBar";
import { estimateFor } from "../estimate";
import { formDefaults } from "../form";
import { aboutMs, notReady } from "../format";
import { Picker } from "../PictureField";
import { Select } from "../Select";
import { Inspector, MusicPanel } from "../timeline/Inspector";
import { layout, otherShape, pinInputs, placeOf, SHAPES, shapeOf, stamp, ZOOM, type Shape } from "../timeline/model";
import { Player, type PlayerHandle } from "../timeline/Player";
import { Shelf } from "../timeline/Shelf";
import { Track, type TimeRange } from "../timeline/Track";
import { AutoText, Button, cx, ErrorNote, Segmented, Toggle } from "../ui";
import { Viewer } from "../Viewer";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { useBanners } from "../store";

/** The range bar's words for its actions: the menu says them in full. */
const SHORT: Record<string, string> = { "Play range": "Play", "Loop: on": "Loop", "Loop: off": "Loop", "Regenerate range": "Regenerate", "Insert a clip here": "Insert clip", "Split at In and Out": "Split at In / Out", "Remove range": "Remove", "Copy to library": "Copy" };

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
  const [musicOpen, setMusicOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
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
  /** What a clip says happens, in a few words, for the designer: its main text, or what it is. */
  const sayOf = (c: Clip) => {
    if (c.kind === "still") return `(a picture held on screen for ${(c.lengthMs / 1000).toFixed(1)} s${c.still?.name ? `: ${c.still.name}` : ""})`;
    const main = recipes.data?.recipes.find((r) => r.id === c.recipe)?.inputs.find((i) => i.type === "prompt" && !i.optional);
    return main ? String(inputsOf(c)[main.id] ?? "") : "(a video that was added as it is)";
  };
  const [idea, setIdea] = useState("");
  const [planned, setPlanned] = useState(4);
  const entities = useEntities();
  const [note, setNote] = useState<string | null>(null);
  /** The export box: open, what was asked, and the export that was there before (to tell the new one). */
  const [exp, setExp] = useState<{ scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range: boolean; blend: boolean; match: boolean; before: string | null; asked: boolean } | null>(null);
  const player = useRef<PlayerHandle>(null);

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

  // ---- the clips' forms: shown at once, saved half a second after the last change
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const unsaved = useRef(new Map<string, Record<string, unknown>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const save = useCallback(async (only?: string) => {
    const ids = only ? [only] : [...unsaved.current.keys()];
    await Promise.all(
      ids.map(async (clipId) => {
        const inputs = unsaved.current.get(clipId);
        clearTimeout(timers.current.get(clipId));
        timers.current.delete(clipId);
        if (!inputs) return;
        unsaved.current.delete(clipId);
        await api.editClip(clipId, { inputs }).catch(() => {});
      }),
    );
  }, []);
  useEffect(() => () => void save(), [save]);
  const inputsOf = useCallback((c: Clip) => edits[c.id] ?? c.inputs, [edits]);
  const editInputs = (c: Clip, next: Record<string, unknown>) => {
    setEdits((e) => ({ ...e, [c.id]: next }));
    unsaved.current.set(c.id, next);
    clearTimeout(timers.current.get(c.id));
    timers.current.set(c.id, setTimeout(() => void save(c.id), 500));
  };
  /** The timeline as it is on screen: with what was typed and is not saved yet. */
  const shown = useMemo(() => (t ? { ...t, clips: clips.map((c) => (edits[c.id] ? { ...c, inputs: edits[c.id]! } : c)) } : undefined), [t, clips, edits]);

  /** The whole form of a clip as a render would send it, whether it is ready to render or not (its models are told from it). */
  const formOf = useCallback(
    (c: Clip): Record<string, unknown> | null => {
      const recipe = c.kind === "still" ? undefined : recipes.data?.recipes.find((r) => r.id === c.recipe);
      if (!recipe) return null;
      const status = setup.data?.recipes.find((r) => r.id === recipe.id);
      if (setup.isSuccess && notReady(status, comfyOnline)) return null;
      const stored = inputsOf(c);
      const input: Record<string, unknown> = { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored };
      for (const i of recipe.inputs) if (input[i.id] === undefined || i.type === "clip") delete input[i.id];
      return input;
    },
    [recipes.data, setup.data, setup.isSuccess, comfyOnline, inputsOf, settings.data],
  );

  /** The whole form of a clip as it would be sent, or why it cannot be rendered yet. */
  const recipeOf = (c: Clip) => recipes.data?.recipes.find((r) => r.id === c.recipe);
  const ready = useCallback(
    (c: Clip): { input?: Record<string, unknown>; why?: string } => {
      if (c.kind === "still") return { why: "A still is not rendered." };
      const recipe = recipes.data?.recipes.find((r) => r.id === c.recipe);
      if (!recipe) return { why: c.recipe ? "The model this clip was generated with is no longer here. Choose another one." : "Choose a model for this clip." };
      const status = setup.data?.recipes.find((r) => r.id === recipe.id);
      const blocked = setup.isSuccess ? notReady(status, comfyOnline) : null;
      if (blocked) return { why: blocked };
      const stored = inputsOf(c);
      const input: Record<string, unknown> = { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored };
      for (const i of recipe.inputs) if (input[i.id] === undefined || i.type === "clip") delete input[i.id];
      const at = clips.findIndex((x) => x.id === c.id);
      const before = at > 0 ? clips[at - 1] : undefined;
      const carries = Boolean(before) && c.joined === "continue";
      for (const i of recipe.inputs) {
        if (i.type === "prompt" && ((!i.optional && i.default === undefined) || i.example) && !String(input[i.id] ?? "").trim()) return { why: `Write ${i.label.toLowerCase()} first.` };
        // a clip that picks up from the last frame of the one before, or opens on the picture before it, needs no opening picture of its own
        const given = carries && i.type === "image" && i.role === "start" && (recipe.traits?.continues === "frame" || before?.kind === "still");
        if (i.type === "image" && !i.optional && !input[i.id] && !given) return { why: `Choose the ${i.label.toLowerCase()} first.` };
      }
      return { input };
    },
    [recipes.data, setup.data, setup.isSuccess, comfyOnline, inputsOf, settings.data, clips],
  );

  const after = () => {
    void refresh();
    void client.invalidateQueries({ queryKey: ["queue"] });
  };
  const render = useMutation({
    mutationFn: async (v: { clips: Clip[]; fit?: boolean; takes?: number }) => {
      await save();
      return api.renderClips(id, v.clips.map((c) => ({ id: c.id, input: ready(c).input ?? {}, ...(v.fit === undefined ? {} : { fit: v.fit }), ...(v.takes && v.takes > 1 ? { takes: v.takes } : {}) })));
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
  const say = useBanners((b) => b.push);
  const split = useMutation({ mutationFn: (v: { clip: string; atMs: number }) => api.splitClip(v.clip, v.atMs), onSuccess: after });
  // ---- the range: In and Out on the clock of what plays; what is done with it
  const [range, setRange] = useState<TimeRange | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [loopRange, setLoopRange] = useState(false);
  // In and Out snap to quiet moments of the clips; off with the magnet, remembered per browser
  const [snapQuiet, setSnapQuiet] = useState(() => {
    try {
      return localStorage.getItem("afflatus.timeline.snapQuiet") !== "off";
    } catch {
      return true;
    }
  });
  const toggleSnapQuiet = () => {
    setSnapQuiet((on) => {
      try {
        localStorage.setItem("afflatus.timeline.snapQuiet", on ? "off" : "on");
      } catch {
        // not remembered, nothing more
      }
      return !on;
    });
  };
  const loopRef = useRef(loopRange);
  loopRef.current = loopRange;
  /** Playing the range: it stops at Out (or goes back to In). */
  const playingRange = useRef(false);
  const emptyRange = Boolean(range && range.outMs - range.inMs < 40);
  // the designer writing a clip put between two others: its texts go into the form unless something was typed there meanwhile
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  const [writing, setWriting] = useState<string | null>(null);
  const writeBetween = useMutation({
    mutationFn: async (v: { clip: string; force: boolean }) => {
      setWriting(v.clip);
      return { ...(await api.writeBetween(v.clip)), ...v };
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
  const rangeAct = useMutation({
    mutationFn: (action: "split" | "remove" | "regenerate" | "copy") => api.timelineRange(id, { inMs: range!.inMs, outMs: range!.outMs, action }),
    onSuccess: (r, action) => {
      after();
      if (action === "regenerate" && "clip" in r) {
        setSelected(r.clip);
        setMusicOpen(false);
        setRange(null);
        const { start, end } = r.context;
        const how =
          start === "clip" && end === "clip" ? "it extends the clip before and ends where the clip after begins, so the motion carries across"
          : start === "clip" ? (end === "frame" ? "it extends the clip before and ends on the frame at Out" : "it extends the clip before; nothing rendered plays after Out")
          : end === "clip" ? "it opens on the frame at In and ends where the clip after begins"
          : start === "none" ? "it ends on the frame at Out; nothing plays before In"
          : end === "none" ? "it opens on the frame at In; nothing rendered plays after Out, so only that frame is pinned"
          : "it is pinned to the frames at In and Out: the frames will match, the motion may not";
        setNote(`The new clip is selected: ${how}. Change what happens in it, then render it. Undo takes the range back.`);
        // with a clip after to arrive at, the designer writes the stretch; without a language model nothing happens
        if (end !== "none") writeBetween.mutate({ clip: r.clip, force: false });
      } else if (action === "remove") setRange(null);
      else if (action === "copy") say({ id: `copy:${Date.now()}`, tone: "good", title: "Copying the range to your library", text: "One video of that part of the timeline, without the music. It runs in the queue.", href: "/queue", go: "Open queue" });
    },
  });
  // the right-click menu of a clip: what the Inspector offers on it, at the pointer
  const clipMenu = useMenu<Clip>();
  /** Where the playhead stands on a clip, when it stands on this one. */
  const onClip = (c: Clip) => {
    const here = player.current?.where();
    return here && here.clip.id === c.id ? here : null;
  };
  /** Split the clip at the playhead: on when the playhead stands inside what it plays. */
  const splitHere = (c: Clip): MenuItem => {
    const take = c.take!;
    const here = player.current?.where();
    const onIt = here && here.clip.id === c.id ? here : null;
    const at = onIt?.assetMs ?? 0;
    const inPlay = Boolean(onIt) && at >= take.startMs + 40 && at <= take.endMs - 40;
    return { label: "Split clip at playhead", icon: <Split size={14} />, disabled: !inPlay || split.isPending, note: !onIt ? "put the playhead on this clip" : !inPlay ? "move the playhead inside the clip" : "two clips, the second from the playhead on", run: () => split.mutate({ clip: c.id, atMs: at }) };
  };
  const clipMenuItems = (c: Clip): MenuItem[] => {
    const index = (shown?.clips ?? []).findIndex((x) => x.id === c.id);
    const recipe = recipes.data?.recipes.find((r) => r.id === c.recipe);
    const canCarry = Boolean(recipe && index > 0 && recipe.inputs.some((i) => (i.type === "clip" && i.role === "previous") || (i.type === "image" && i.role === "start")));
    const video = c.take?.asset ?? null;
    return [
      ...(c.kind === "video" && recipe ? [{ label: c.take ? "New take" : "Render this clip", key: "Ctrl + Enter", icon: <Wand2 size={14} />, disabled: Boolean(c.job) || render.isPending, run: () => render.mutate({ clips: [c] }) }] : []),
      ...(canCarry ? [c.joined === "continue"
        ? { label: "Make it a cut", icon: <Scissors size={14} />, note: `from clip ${index}`, run: () => patch.mutate({ clip: c.id, patch: { joined: "cut" } }) }
        : { label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "carries its motion on", run: () => patch.mutate({ clip: c.id, patch: { joined: "continue" } }) }]
        // said rather than hidden: an imported workflow with no first-frame or previous-clip input cannot extend
        : c.kind === "video" && recipe && index > 0 ? [{ label: `Extend clip ${index}`, icon: <Link2 size={14} />, note: "this model cannot extend a clip", disabled: true, run: () => {} }] : []),
      "—" as const,
      { label: "Set range to this clip", key: "I  O", icon: <Scissors size={14} />, disabled: c.lengthMs <= 0, note: c.lengthMs > 0 ? "In at its start, Out at its end" : "nothing plays yet", run: () => setRange({ inMs: c.atMs, outMs: c.atMs + c.lengthMs }) },
      ...(c.take ? [splitHere(c)] : []),
      ...(c.lengthMs > 0 ? [
        { label: "Extend from this frame", icon: <Link2 size={14} />, disabled: !onClip(c) || add.isPending, note: onClip(c) ? "cuts it here; a new clip carries on" : "put the playhead on this clip", run: () => { const here = onClip(c); if (here) void continueFrom(c, here.localMs); } },
        { label: "Save frame", icon: <Camera size={14} />, disabled: !onClip(c) || frame.isPending, note: onClip(c) ? "the frame at the playhead, to your library" : "put the playhead on this clip", run: () => { const here = onClip(c); if (!here) return; if (c.take) frame.mutate({ asset: c.take.asset.id, at: Math.round(here.assetMs) }); else if (c.still) setOpened(c.still); } },
      ] : []),
      ...(video ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer, with Trim", run: () => setOpened(video) }] : []),
      // a still has no sound of its own to mute
      ...(c.kind === "video" ? ["—" as const, c.sound === "muted"
        ? { label: "Unmute", icon: <Volume2 size={14} />, run: () => patch.mutate({ clip: c.id, patch: { sound: "own" } }) }
        : { label: "Mute", icon: <VolumeX size={14} />, run: () => patch.mutate({ clip: c.id, patch: { sound: "muted" } }) }] : []),
      "—" as const,
      { label: "Remove clip", key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings it back", run: () => remove.mutate(c.id) },
    ];
  };
  /** Play from In; at Out it stops, or goes back to In when Loop is on. */
  const playRange = () => {
    if (!range || emptyRange) return;
    playingRange.current = true;
    player.current?.seek(range.inMs);
    setPlaying(true);
  };
  const rangeMenu = useMenu<true>();
  /** What can be done with the range: the bar under the video and the right-click on the band show the same list. */
  const rangeItems = (): MenuItem[] => {
    if (!range) return [];
    const busy = rangeAct.isPending;
    return [
      { label: "Play range", key: "Space", icon: <Play size={14} />, disabled: emptyRange, note: emptyRange ? "In and Out are the same moment" : undefined, run: playRange },
      { label: loopRange ? "Loop: on" : "Loop: off", key: "L", icon: <Repeat size={14} />, disabled: emptyRange, note: "back to In at Out", run: () => toggleLoop() },
      "—" as const,
      { label: emptyRange ? "Insert a clip here" : "Regenerate range", icon: <RefreshCw size={14} />, disabled: busy, note: emptyRange ? "a clip between the two, pinned to their frames" : "a new clip pinned to the frames at In and Out; it replaces what is between", run: () => rangeAct.mutate("regenerate") },
      { label: "Split at In and Out", icon: <Split size={14} />, disabled: emptyRange || busy, note: "the clips under them become two", run: () => rangeAct.mutate("split") },
      { label: "Remove range", icon: <Scissors size={14} />, danger: true, disabled: emptyRange || busy, note: "the clips after close the gap; Undo brings it back", run: () => rangeAct.mutate("remove") },
      { label: "Copy to library", icon: <Copy size={14} />, disabled: emptyRange || busy, note: "one video of this part, through the queue", run: () => rangeAct.mutate("copy") },
      "—" as const,
      { label: "Clear the range", key: "Esc", icon: <X size={14} />, run: () => setRange(null) },
    ];
  };
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
      setEdits({});
      setNote(`Undone: ${r.undone}.`);
      after();
    },
  });
  const exportIt = useMutation({ mutationFn: (v: { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend: boolean; match: boolean }) => api.exportTimeline(id, v), onSuccess: after });
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
    mutationFn: async () => {
      const recipe = clips.find((c) => c.recipe)?.recipe ?? firstRecipe();
      if (!recipe) throw new Error("There is no video model to plan clips for yet.");
      const made = await api.designerPlan({ recipe, idea: idea.trim(), clips: planned, look: t?.look ?? null, mood: t?.mood });
      if (!made.clips.length) throw new Error(made.note || "The designer returned no clips.");
      return api.planTimeline(id, recipe, made.clips);
    },
    onSuccess: (r) => {
      client.setQueryData(["timelines", id], r.timeline);
      setSelected(r.clips[0] ?? null);
      setIdea("");
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
  const onTime = useCallback((ms: number) => {
    setTime(ms);
    setCursor(null);
    const r = rangeRef.current;
    if (playingRange.current && r && ms >= r.outMs - 15) {
      if (loopRef.current && r.outMs - r.inMs >= 40) player.current?.seek(r.inMs);
      else {
        playingRange.current = false;
        setPlaying(false);
      }
    }
  }, []);
  const toggle = useCallback(() => {
    const r = rangeRef.current;
    if (playing) playingRange.current = false;
    else if (r && r.outMs - r.inMs >= 40) {
      // with a range, Play plays it: from the playhead when it stands inside, else from In; it stops at Out
      playingRange.current = true;
      if (time < r.inMs || time >= r.outMs - 15) player.current?.seek(r.inMs);
    } else if (t && time >= t.durationMs - 30) player.current?.seek(0);
    setPlaying((p) => !p);
  }, [playing, t, time]);
  /** Loop on or off; turning it on while stopped starts the range. */
  const toggleLoop = useCallback(() => {
    const r = rangeRef.current;
    setLoopRange((on) => !on);
    if (!loopRef.current && !playing && r && r.outMs - r.inMs >= 40) toggle();
  }, [playing, toggle]);
  const toggleLoopNow = useRef(toggleLoop);
  toggleLoopNow.current = toggleLoop;
  // the range stays within what plays when the timeline changes under it
  const durationMs = t?.durationMs ?? 0;
  useEffect(() => {
    setRange((r) => (r && r.outMs > durationMs ? (r.inMs >= durationMs ? null : { ...r, outMs: durationMs }) : r));
  }, [durationMs]);
  const timeRef = useRef(time);
  timeRef.current = time;
  const totalRef = useRef(durationMs);
  totalRef.current = durationMs;
  /** One frame of the clip under the playhead, in ms (24 a second when it is not known). */
  const frameMs = () => {
    const c = clips.find((x) => x.lengthMs > 0 && time >= x.atMs && time < x.atMs + x.lengthMs);
    return 1000 / Math.max(1, c?.take?.asset.fps ?? 24);
  };
  const frameRef = useRef(frameMs);
  frameRef.current = frameMs;
  const undoNow = undo.mutate;
  const removeNow = remove.mutate;
  const selectedNow = useRef<string | null>(null);
  selectedNow.current = current?.id ?? null;
  const canUndo = Boolean(t?.undo);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = Boolean(el.closest("input, textarea, select, [contenteditable]"));
      if (e.code === "Space" && !typing && !el.closest("button, [role=listbox], [role=dialog]")) {
        e.preventDefault();
        toggle();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing && canUndo) {
        e.preventDefault();
        undoNow();
      }
      const open = Boolean(document.querySelector("[role=dialog], [role=listbox], [role=menu]"));
      const plain = !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open;
      // I and O: In and Out at the playhead (one alone reaches to the end, or from the start)
      // I and O: In and Out at the playhead (one alone reaches to the end, or from the start); with Shift: go to In / Out
      if (plain && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        if (e.shiftKey) {
          if (rangeRef.current) player.current?.seek(rangeRef.current.inMs);
          return;
        }
        const at = timeRef.current;
        setRange((r) => (r ? { inMs: at, outMs: Math.max(at, r.outMs) } : { inMs: at, outMs: totalRef.current }));
        return;
      }
      if (plain && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        if (e.shiftKey) {
          if (rangeRef.current) player.current?.seek(rangeRef.current.outMs);
          return;
        }
        const at = timeRef.current;
        setRange((r) => (r ? { inMs: Math.min(at, r.inMs), outMs: at } : { inMs: 0, outMs: at }));
        return;
      }
      if (plain && (e.key === "l" || e.key === "L") && rangeRef.current) {
        e.preventDefault();
        toggleLoopNow.current();
        return;
      }
      if (e.key === "Escape" && !typing && !open && rangeRef.current) {
        e.preventDefault();
        setRange(null);
        return;
      }
      // one frame back or forward (Shift: ten); , and . do the same
      const step = e.key === "ArrowLeft" || e.key === "," ? -1 : e.key === "ArrowRight" || e.key === "." ? 1 : 0;
      if (step && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !el.closest("[role=listbox], [role=slider][aria-label=In], [role=slider][aria-label=Out]")) {
        e.preventDefault();
        const by = step * frameRef.current() * (e.shiftKey && e.key.startsWith("Arrow") ? 10 : 1);
        player.current?.seek(Math.max(0, Math.min(totalRef.current, timeRef.current + by)));
        return;
      }
      // Delete takes the selected clip off the timeline; Undo brings it back
      if (e.key === "Delete" && !typing && selectedNow.current && !open) {
        e.preventDefault();
        removeNow(selectedNow.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undoNow, canUndo, removeNow]);

  const jump = (by: -1 | 1) => {
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
  const head = placeOf(slots, time);
  const shape: Shape | "own" | "first" = !t.width || !t.height ? "first" : (Object.keys(SHAPES) as Shape[]).find((k) => SHAPES[k].width === t.width && SHAPES[k].height === t.height) ?? "own";
  const misfits = clips.filter((c) => otherShape(c, t) && !c.fill).length;
  const exportDone = exp?.asked && !t.exporting && t.exported && t.exported.id !== exp.before ? t.exported : null;
  const exportSize = (scale: number) => (t.width && t.height ? `${Math.round((t.width * scale) / 2) * 2} × ${Math.round((t.height * scale) / 2) * 2}` : "");
  const playable = clips.filter((c) => c.lengthMs > 0).length;

  return (
    <div className="flex min-w-0 grow flex-col">
      <header className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line px-3">
        <Link href="/timelines" aria-label="Back to the timelines" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><ArrowLeft size={17} /></Link>
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
        <div className="w-44 shrink-0" title={t.width && t.height ? `The video is ${t.width} × ${t.height}. Click to change its aspect ratio.` : "The first clip that is rendered decides the aspect ratio. Click to choose one."}>
        <Select
          size="sm"
          label="Aspect ratio"
          value={shape}
          onChange={(v) => edit.mutate(v === "first" ? { width: null, height: null } : v === "own" ? {} : { width: SHAPES[v as Shape].width, height: SHAPES[v as Shape].height })}
          options={[
            ...(Object.keys(SHAPES) as Shape[]).map((k) => ({ value: k as string, label: SHAPES[k].label, note: `${SHAPES[k].width} × ${SHAPES[k].height}` })),
            ...(shape === "own" ? [{ value: "own", label: SHAPES[shapeOf(t.width!, t.height!)].label, note: `${t.width} × ${t.height}` }] : []),
            { value: "first", label: "The first clip decides", detail: "The video takes the aspect ratio of the first clip that is rendered." },
          ]}
        />
        </div>
        <Button size="sm" className="h-8 max-w-64" title="Who is in the video and how it looks: used by every clip that has no cast of its own." onClick={() => setCasting(true)}>
          <Users size={14} className="shrink-0" />
          <span className="truncate">{lookWords(t.look, entities.data?.items ?? []) || "Cast and places"}</span>
        </Button>
        <span className="grow" />
        {(error || note) && <span className={error ? "max-w-sm truncate text-warn-ink" : "max-w-sm truncate text-ink-2"} title={error?.message}>{error?.message ?? note}</span>}
        <Button className="px-3" disabled={!t.undo || undo.isPending} title={t.undo ? `Undo: ${t.undo}` : "Nothing to undo"} onClick={() => undo.mutate()}>
          <Undo2 size={15} /> Undo
        </Button>
        {missing.length > 0 && (
          <Button tone="primary" disabled={render.isPending} title="Renders the clips that have no take yet and redoes the ones that no longer follow the clip before them, in order." onClick={() => render.mutate({ clips: missing })}>
            Render all ({missing.length}){allMs ? ` · ${aboutMs(allMs)}` : ""}
          </Button>
        )}
        <Button disabled={!t.durationMs} onClick={() => setExp({ scale: 1, music: true, smooth: false, range: Boolean(range && !emptyRange), blend: true, match: true, before: t.exported?.id ?? null, asked: Boolean(t.exporting) })}>
          <Download size={15} /> {t.exporting ? "Exporting…" : "Export video"}
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        {/* the media and the player side by side, and under both the row that plays: it starts at the left edge */}
        <div className="flex min-w-0 grow flex-col">
        <div className="flex min-h-0 grow">
        <Shelf
          selected={Boolean(current)}
          onAdd={(a) => {
            if (a.kind !== "audio") return add.mutate({ asset: a.id });
            if (current) patch.mutate({ clip: current.id, patch: { soundAsset: a.id } });
            else setNote("Select a clip first, or drag the audio onto a clip or onto the music track.");
          }}
        />

        <main className="flex min-w-0 grow flex-col">
            <Player ref={player} clips={clips} music={t.music} frame={t.width && t.height ? { width: t.width, height: t.height } : null} playing={playing} onPlaying={setPlaying} onTime={onTime} preview={preview} live={liveShown} onStop={(job) => stop.mutate(job)} />
        </main>
        </div>
          {range && (() => {
            const spanned = clips.filter((c) => c.lengthMs > 0 && c.atMs < Math.max(range.outMs, range.inMs + 1) && c.atMs + c.lengthMs > range.inMs).map((c) => clips.indexOf(c) + 1);
            const where = emptyRange ? "a cut" : spanned.length <= 1 ? `clip ${spanned[0] ?? "?"}` : `clips ${spanned[0]}–${spanned.at(-1)}`;
            return (
              <div role="toolbar" aria-label="Range" className="flex h-10 shrink-0 items-center gap-1.5 overflow-hidden border-t border-line bg-accent-wash/40 px-3 text-sm whitespace-nowrap">
                <span className="shrink-0 font-semibold text-accent">Range</span>
                <span className="shrink-0 font-mono">{stamp(range.inMs)} <span className="text-ink-3">→</span> {stamp(range.outMs)}</span>
                <span className="min-w-0 truncate text-ink-2">· {emptyRange ? "" : `${((range.outMs - range.inMs) / 1000).toFixed(1)} s · `}{where}</span>
                <button type="button" aria-label="Snap to quiet moments" aria-pressed={snapQuiet} title={snapQuiet ? "In and Out snap to quiet moments of the clips (the ticks under the ruler), to cuts and to the playhead. Click to snap to cuts and the playhead only." : "Snapping to quiet moments is off: In and Out snap to cuts and to the playhead. Click to snap to quiet moments too."} onClick={toggleSnapQuiet} className={cx("ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", snapQuiet ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink")}><Magnet size={14} /></button>
                <span className="grow" />
                {rangeItems().filter((it): it is Exclude<MenuItem, "—"> => it !== "—" && it.label !== "Play range" && !it.label.startsWith("Loop")).map((it, i) =>
                  it.label === "Clear the range" ? (
                    <button key={i} type="button" aria-label="Clear the range (Esc)" title="Clear the range (Esc)" onClick={it.run} className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
                  ) : (
                    <Button key={i} size="sm" aria-label={it.label} disabled={it.disabled} title={[it.label, it.note].filter(Boolean).join(" · ")} onClick={it.run} className="shrink-0">
                      {it.icon} {SHORT[it.label] ?? it.label}
                    </Button>
                  ),
                )}
              </div>
            );
          })()}
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
            <button type="button" aria-label="Previous clip" title="Previous clip" disabled={!t.durationMs} onClick={() => jump(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipBack size={15} /></button>
            <button type="button" aria-label={playing ? "Pause" : range && !emptyRange ? "Play the range" : "Play"} title={range && !emptyRange ? "Play the range: from the playhead inside it, else from In; stops at Out (Space)" : "Play / pause (Space)"} disabled={!t.durationMs} onClick={toggle} className={cx("flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40", range && !emptyRange ? "bg-accent text-accent-ink" : "bg-ink text-ground")}>
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
            </button>
            <button type="button" aria-label="Next clip" title="Next clip" disabled={!t.durationMs} onClick={() => jump(1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipForward size={15} /></button>
            {range && !emptyRange && (
              <button type="button" aria-label="Loop the range" aria-pressed={loopRange} title={loopRange ? "Loop is on: back to In at Out (L)" : "Loop the range (L)"} onClick={toggleLoop} className={cx("flex h-8 w-8 items-center justify-center rounded-lg", loopRange ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover hover:text-ink")}><Repeat size={15} /></button>
            )}
            <span className="ml-1 font-mono">{stamp(cursor ?? head?.layoutMs ?? 0)} <span className="text-ink-3">/ {stamp(total)}</span></span>
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
            onLoop={() => loop.mutate(current)}
            onDesigner={() => setDesigning(current.id)}
            onPreview={setPreview}
            writing={writeBetween.isPending && writing === current.id}
            writeError={writeBetween.isError && writeBetween.variables?.clip === current.id && writeBetween.variables.force ? writeBetween.error.message : null}
            onWriteBetween={() => writeBetween.mutate({ clip: current.id, force: true })}
          />
        ) : (
          <aside className="flex w-[400px] shrink-0 flex-col gap-3 border-l border-line bg-panel p-5 text-ink-2">
            <span className="text-base font-semibold text-ink">{clips.length ? "Select a clip" : "Start your video"}</span>
            {clips.length ? (
              <span>Click a clip on the timeline to see its generation parameters, change them, or render another take. Click the music to set its volume.</span>
            ) : (
              <>
                <span>A timeline plays clips one after the other. Each clip can extend the previous clip: the motion and the voices continue across the join.</span>
                <span className="font-semibold text-ink">Start from an image</span>
                <span>It becomes the first frame of your video.</span>
                <span><Button onClick={() => setPicking(true)} disabled={add.isPending}><ImagePlus size={15} /> Choose an image</Button></span>
                <span className="font-semibold text-ink">Or describe a scene</span>
                <span>Write what should happen. The designer splits it into clips you can change before anything is rendered.</span>
                <AutoText rows={3} aria-label="Scene" value={idea} placeholder="A woman has coffee on a terrace at sunset, walks to the railing and waves at a boat." onChange={(e) => setIdea(e.target.value)} className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-ink placeholder:text-ink-3" />
                <span className="flex items-center gap-2">
                  <span className="w-28"><Select size="sm" label="How many clips" value={String(planned)} onChange={(v) => setPlanned(Number(v))} options={[2, 3, 4, 5, 6, 8].map((n) => ({ value: String(n), label: `${n} clips` }))} /></span>
                  <Button tone="primary" onClick={() => plan.mutate()} disabled={!idea.trim() || plan.isPending}>{plan.isPending ? "Planning…" : "Plan the clips"}</Button>
                </span>
                <span className="font-semibold text-ink">Or write it yourself</span>
                <span><Button onClick={() => newClip()} disabled={add.isPending}><Plus size={15} strokeWidth={2.6} /> Add the first clip</Button></span>
              </>
            )}
          </aside>
        )}
      </div>

      <Track
        timeline={shown}
        recipes={videoRecipes}
        pps={pps}
        onZoom={setPps}
        selected={musicOpen ? null : selected}
        musicSelected={musicOpen}
        time={time}
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
        onInsert={(asset, afterId) => add.mutate({ after: afterId, asset })}
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
        range={range}
        onRange={setRange}
        onRangeMenu={(e) => rangeMenu.open(e, true)}
        snapQuiet={snapQuiet}
      />
      {clipMenu.menu && <ContextMenu at={clipMenu.menu.at} label="Actions on this clip" items={clipMenuItems(clipMenu.menu.subject)} onClose={clipMenu.close} />}
      {rangeMenu.menu && range && <ContextMenu at={rangeMenu.menu.at} label="Actions on the range" items={rangeItems()} onClose={rangeMenu.close} />}

      {exp && (
        <div role="dialog" aria-modal="true" aria-label="Export video" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/85 p-8" onClick={() => setExp(null)}>
          <div className="flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <span className="text-base font-semibold">Export video</span>
            <span className="text-ink-2">{exp.range && range ? `${stamp(range.inMs)} → ${stamp(range.outMs)} · ${((range.outMs - range.inMs) / 1000).toFixed(1)} s of ${stamp(t.durationMs)}` : `${stamp(t.durationMs)} · ${playable} clip${playable > 1 ? "s" : ""}`} · one MP4 in your library</span>
            {exportDone ? (
              <>
                <span>Done. <span className="font-semibold text-ink">{exportDone.name}</span> is in your library{exportDone.width ? `, ${exportDone.width} × ${exportDone.height}` : ""}{exportDone.durationMs ? `, ${stamp(exportDone.durationMs)}` : ""}.</span>
                <div className="flex flex-wrap gap-2">
                  <a href={fileUrl(exportDone.id)} download={`${(exportDone.name || t.name).replace(/[:<>"/\|?*]/g, ".")}.mp4`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 font-semibold text-accent-ink"><Download size={15} /> Download</a>
                  <Button onClick={() => { setOpened(exportDone); setExp(null); }}>Open</Button>
                  <Button tone="quiet" onClick={() => setExp(null)}>Close</Button>
                </div>
              </>
            ) : t.exporting || exportIt.isPending ? (
              <>
                <span>{t.exporting?.status === "queued" ? "Queued, after the renders that were asked for before it." : "Exporting."} It runs in the queue, you can keep working.</span>
                <div><Button tone="quiet" onClick={() => setExp(null)}>Close</Button></div>
              </>
            ) : (
              <>
                {exp.asked && t.exportFailed && <ErrorNote>The export failed: {t.exportFailed}</ErrorNote>}
                <div className="flex flex-col gap-1.5">
                  <span className="flex items-baseline justify-between text-xs font-semibold"><span>Resolution</span><span className="font-normal text-ink-2">{exportSize(exp.scale)}</span></span>
                  <Segmented<"1" | "1.5" | "2"> label="Resolution" value={String(exp.scale) as "1" | "1.5" | "2"} onChange={(v) => setExp({ ...exp, scale: Number(v) as 1 | 1.5 | 2 })} options={[{ value: "1", label: "As rendered" }, { value: "1.5", label: "1.5× upscale" }, { value: "2", label: "2× upscale" }]} />
                  <span className="text-xs text-ink-2">Upscaling is done by ffmpeg (lanczos, then a light unsharp), not by a model: every frame is resized and a little sharper. The clips are not rendered again, so it works on a small card.</span>
                </div>
                {range && !emptyRange && <Toggle on={exp.range} onChange={(only) => setExp({ ...exp, range: only })} label="Only the range" note={`In ${stamp(range.inMs)} to Out ${stamp(range.outMs)}`} />}
                {t.music && (exp.range && range ? <span className="text-xs text-ink-2">The music is left out of a range: it would start from its beginning, not from In.</span> : <Toggle on={exp.music} onChange={(music) => setExp({ ...exp, music })} label="Include the music" />)}
                {Math.max(0, ...clips.map((c) => c.take?.asset.fps ?? 0)) < 47 && (
                  <div className="flex flex-col gap-1">
                    <Toggle on={exp.smooth} onChange={(smooth) => setExp({ ...exp, smooth })} label="Frame interpolation" note="48 fps, ffmpeg minterpolate" />
                    <span className="text-xs text-ink-2">The frames in between are worked out by your processor, not by a model: slow (minutes for a short video), and fast motion can smear. Frame interpolation at render time (RIFE, in the clip's form) is better.</span>
                  </div>
                )}
                {clips.some((c, i) => i > 0 && c.joined === "continue" && c.take && c.take.headMs > c.take.trimStartMs) && (
                  <Toggle on={exp.blend} onChange={(blend) => setExp({ ...exp, blend })} label="Blend joins" note="a clip that extends the one before is crossfaded in over the frames they share (up to 0.4 s), with its sound" />
                )}
                {playable > 1 && <Toggle on={exp.match} onChange={(match) => setExp({ ...exp, match })} label="Match colours at joins" note="each clip's brightness and tint nudged to the clip before, a few steps at most" />}
                {misfits > 0 && <span className="text-xs text-ink-2">{misfits} clip{misfits > 1 ? "s have" : " has"} another aspect ratio and will be letterboxed (shown with bars).</span>}
                <div className="flex flex-wrap gap-2">
                  <Button tone="primary" onClick={() => { setExp({ ...exp, asked: true, before: t.exported?.id ?? null }); exportIt.mutate({ scale: exp.scale, music: exp.music, smooth: exp.smooth, range: exp.range && range ? { inMs: range.inMs, outMs: range.outMs } : undefined, blend: exp.blend, match: exp.match }); }}>Export</Button>
                  <Button tone="quiet" onClick={() => setExp(null)}>Close</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {casting && (
        <div role="dialog" aria-modal="true" aria-label="Cast and places" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/85 p-8" onClick={() => setCasting(false)}>
          <div className="flex w-full max-w-lg flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <span className="text-base font-semibold">Cast and places</span>
            <span className="text-ink-2">Who is in the video, where it happens and how it looks. Set once here, used by every clip, unless a clip is given its own. It counts from the next take of each clip.</span>
            <LookBar title="In this video" look={t.look} onChange={(look) => edit.mutate({ look })} />
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold">Look and mood</span>
              <AutoText
                rows={1}
                value={mood ?? t.mood}
                placeholder="warm evening light, calm, film grain"
                onChange={(e) => setMood(e.target.value)}
                onBlur={() => {
                  if (mood !== null && mood.trim() !== t.mood) edit.mutate({ mood: mood.trim() });
                  setMood(null);
                }}
                className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3"
              />
              <span className="text-xs text-ink-2">A few words every clip keeps: they are added to what happens in each clip, and the designer writes with them in mind.</span>
            </label>
            <div><Button tone="quiet" onClick={() => setCasting(false)}>Close</Button></div>
          </div>
        </div>
      )}
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
          <Designer
            // on the left, over the media: the clip's own settings, on the right, stay in view and are seen to change
            side="left"
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
