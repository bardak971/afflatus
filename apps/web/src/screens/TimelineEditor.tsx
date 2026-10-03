import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Camera, Copy, Download, Eye, ImagePlus, Link2, Pause, Play, Plus, RefreshCw, Scissors, SkipBack, SkipForward, Split, Trash2, Undo2, Users, Volume2, VolumeX, Wand2 } from "lucide-react";
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
import { Track } from "../timeline/Track";
import { AutoText, Button, ErrorNote, Segmented, Toggle } from "../ui";
import { Viewer } from "../Viewer";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { Trim, type Range } from "../Trim";
import { thumbUrl } from "../api";
import { useBanners } from "../store";

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
  const [exp, setExp] = useState<{ scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; before: string | null; asked: boolean } | null>(null);
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
    mutationFn: async (v: { clips: Clip[]; fit?: boolean }) => {
      await save();
      return api.renderClips(id, v.clips.map((c) => ({ id: c.id, input: ready(c).input ?? {}, ...(v.fit === undefined ? {} : { fit: v.fit }) })));
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
  // Trim on a clip: its take in place of the player, the range to play, a split, a part regenerated
  const [trimming, setTrimming] = useState<string | null>(null);
  const trimClip = trimming ? clips.find((c) => c.id === trimming) ?? null : null;
  const trimTake = trimClip?.take ?? null;
  useEffect(() => { if (trimming && !trimTake) setTrimming(null); }, [trimming, trimTake]);
  const say = useBanners((b) => b.push);
  const split = useMutation({ mutationFn: (v: { clip: string; atMs: number }) => api.splitClip(v.clip, v.atMs), onSuccess: after });
  const regenerate = useMutation({
    mutationFn: (v: { clip: Clip; range: Range; crf: number }) => api.regenerateClip(v.clip.id, { startMs: v.range.startMs, endMs: v.range.endMs, input: ready(v.clip).input ?? {}, crf: v.crf }),
    onSuccess: () => {
      after();
      say({ id: `regen:${Date.now()}`, tone: "good", title: "Regenerating the part", text: "A new clip renders between the range's edge frames; when it is done it is spliced back as a new take of the clip.", href: "/queue", go: "Open queue" });
    },
  });
  const copyRange = useMutation({
    mutationFn: (v: { asset: string; range: Range; crf: number }) => api.range(v.asset, { startMs: v.range.startMs, endMs: v.range.endMs, action: "copy", crf: v.crf }),
    onSuccess: () => say({ id: `copy:${Date.now()}`, tone: "good", title: "Copying the range to your library", href: "/queue", go: "Open queue" }),
  });
  const trimPlayer = useRef<HTMLVideoElement>(null);
  // the right-click menu of a clip: what the Inspector offers on it, at the pointer
  const clipMenu = useMenu<Clip>();
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
      ...(c.take ? [{ label: "Trim clip", key: "T", icon: <Scissors size={14} />, note: "play range, split, regenerate a part", run: () => setTrimming(c.id) }] : []),
      ...(video ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer", run: () => setOpened(video) }] : []),
      // a still has no sound of its own to mute
      ...(c.kind === "video" ? ["—" as const, c.sound === "muted"
        ? { label: "Unmute", icon: <Volume2 size={14} />, run: () => patch.mutate({ clip: c.id, patch: { sound: "own" } }) }
        : { label: "Mute", icon: <VolumeX size={14} />, run: () => patch.mutate({ clip: c.id, patch: { sound: "muted" } }) }] : []),
      "—" as const,
      { label: "Remove clip", key: "Del", icon: <Trash2 size={14} />, danger: true, note: "Undo brings it back", run: () => remove.mutate(c.id) },
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
  const exportIt = useMutation({ mutationFn: (v: { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean }) => api.exportTimeline(id, v), onSuccess: after });
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
  const error = plan.error ?? loop.error ?? render.error ?? patch.error ?? edit.error ?? add.error ?? remove.error ?? removeTake.error ?? stop.error ?? undo.error ?? exportIt.error ?? frame.error;
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
  }, []);
  const toggle = useCallback(() => {
    if (!playing && t && time >= t.durationMs - 30) player.current?.seek(0);
    setPlaying((p) => !p);
  }, [playing, t, time]);
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
      // Delete takes the selected clip off the timeline; Undo brings it back
      if ((e.key === "t" || e.key === "T") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && selectedNow.current && !document.querySelector("[role=dialog], [role=listbox], [role=menu]")) {
        e.preventDefault();
        setTrimming((cur) => (cur ? null : selectedNow.current));
        return;
      }
      if (e.key === "Delete" && !typing && selectedNow.current && !document.querySelector("[role=dialog], [role=listbox], [role=menu]")) {
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
    const left = here.clip.lengthMs - here.localMs;
    if (here.clip.take && left > 60 && here.localMs > 300) await api.editClip(here.clip.id, { trimEndMs: here.clip.take.trimEndMs + Math.round(left) });
    add.mutate({ after: here.clip.id, recipe: hasRecipe ? undefined : firstRecipe() });
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
        <Button disabled={!t.durationMs} onClick={() => setExp({ scale: 1, music: true, smooth: false, before: t.exported?.id ?? null, asked: Boolean(t.exporting) })}>
          <Download size={15} /> {t.exporting ? "Exporting…" : "Export video"}
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        {/* the media and the player side by side, and under both the row that plays: it starts at the left edge */}
        <div className="flex min-w-0 grow flex-col">
        <div className="flex min-h-0 grow">
        {!trimClip && <Shelf
          selected={Boolean(current)}
          onAdd={(a) => {
            if (a.kind !== "audio") return add.mutate({ asset: a.id });
            if (current) patch.mutate({ clip: current.id, patch: { soundAsset: a.id } });
            else setNote("Select a clip first, or drag the audio onto a clip or onto the music track.");
          }}
        />}

        <main className="flex min-w-0 grow flex-col">
          {trimClip && trimTake ? (
            <div data-stage className="flex min-h-0 grow flex-col items-center justify-center gap-3 bg-ground p-4">
              <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                <video key={trimTake.asset.id} ref={trimPlayer} src={fileUrl(trimTake.asset.id)} poster={thumbUrl(trimTake.asset.id)} className="min-h-0 max-h-full max-w-full rounded-lg" onClick={(e) => { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); }} />
              </div>
              <Trim
                key={`${trimClip.id}:${trimTake.id}`}
                asset={trimTake.asset}
                player={trimPlayer}
                initial={{ startMs: trimTake.startMs, endMs: trimTake.endMs }}
                compact
                busy={split.isPending || regenerate.isPending || patch.isPending}
                onFrame={(atMs) => frame.mutate({ asset: trimTake.asset.id, at: Math.round(atMs) })}
                onClose={() => setTrimming(null)}
                actions={({ range, at, crf }) => {
                  const total = trimTake.asset.durationMs ?? 0;
                  const isPlayRange = Math.abs(range.startMs - trimTake.startMs) < 1 && Math.abs(range.endMs - trimTake.endMs) < 1;
                  const inPlay = at >= trimTake.startMs + 40 && at <= trimTake.endMs - 40;
                  const can = ready(trimClip);
                  return (
                    <>
                      <Button size="sm" tone="primary" disabled={isPlayRange || patch.isPending} title={isPlayRange ? "This is already what plays." : "The clip plays only this range of its take (Undo takes it back)."} onClick={() => patch.mutate({ clip: trimClip.id, patch: { trimStartMs: Math.max(0, Math.round(range.startMs - trimTake.headMs)), trimEndMs: Math.max(0, Math.round(total - trimTake.tailMs - range.endMs)) } })}><Scissors size={13} /> Play only this range</Button>
                      <Button size="sm" disabled={!inPlay || split.isPending} title={inPlay ? "One clip becomes two at the playhead: the first plays up to it, the second from it on." : "Put the playhead inside the part that plays."} onClick={() => split.mutate({ clip: trimClip.id, atMs: at })}><Split size={13} /> Split clip here</Button>
                      <Button size="sm" disabled={regenerate.isPending || Boolean(can.why) || range.endMs - range.startMs < 200} title={can.why ?? "A new clip rendered between the frames at in and at out, with this clip's form; spliced back in place of the range as a new take."} onClick={() => regenerate.mutate({ clip: trimClip, range, crf })}><RefreshCw size={13} /> Regenerate this part</Button>
                      <span className="mx-1 h-5 border-l border-line" />
                      <Button size="sm" disabled={frame.isPending} title="The frame at the playhead, as an image in your library" onClick={() => frame.mutate({ asset: trimTake.asset.id, at: Math.round(at) })}><Camera size={13} /> Frame at playhead</Button>
                      <Button size="sm" disabled={copyRange.isPending} title="The range as a new video in your library" onClick={() => copyRange.mutate({ asset: trimTake.asset.id, range, crf })}><Copy size={13} /> Copy range to library</Button>
                    </>
                  );
                }}
              />
            </div>
          ) : (
            <Player ref={player} clips={clips} music={t.music} frame={t.width && t.height ? { width: t.width, height: t.height } : null} playing={playing} onPlaying={setPlaying} onTime={onTime} preview={preview} live={liveShown} onStop={(job) => stop.mutate(job)} />
          )}
        </main>
        </div>
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
            <button type="button" aria-label="Previous clip" title="Previous clip" disabled={!t.durationMs} onClick={() => jump(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipBack size={15} /></button>
            <button type="button" aria-label={playing ? "Pause" : "Play"} disabled={!t.durationMs} onClick={toggle} className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ground disabled:opacity-40">
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
            </button>
            <button type="button" aria-label="Next clip" title="Next clip" disabled={!t.durationMs} onClick={() => jump(1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"><SkipForward size={15} /></button>
            <span className="ml-1 font-mono">{stamp(cursor ?? head?.layoutMs ?? 0)} <span className="text-ink-3">/ {stamp(total)}</span></span>
            <span className="grow" />
            <Button size="sm" disabled={!t.durationMs || add.isPending} title="Cuts the clip on screen at this frame, and adds a new clip that extends from it." onClick={() => void continueHere()}>
              <Link2 size={13} /> Extend from this frame
            </Button>
            <Button
              size="sm"
              disabled={!t.durationMs || frame.isPending}
              title="Save the frame on screen as an image in your library."
              onClick={() => {
                const here = player.current?.where();
                if (here?.clip.take) frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
                else if (here?.clip.still) setOpened(here.clip.still);
              }}
            >
              <Camera size={13} /> Save frame
            </Button>
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
            takes={aboutMs(takes(current))}
            running={running?.clipId === current.id ? running : null}
            busy={render.isPending}
            error={render.isError ? render.error.message : null}
            onInputs={(next) => editInputs(current, next)}
            onRecipe={(recipe) => patch.mutate({ clip: current.id, patch: { recipe } })}
            onPatch={(p) => patch.mutate({ clip: current.id, patch: p })}
            onRender={(fit) => render.mutate({ clips: [current], fit })}
            onRemove={() => {
              remove.mutate(current.id);
              setSelected(null);
            }}
            onRemoveTake={(takeId) => removeTake.mutate(takeId)}
            onStop={() => current.job && stop.mutate(current.job.id)}
            onLoop={() => loop.mutate(current)}
            onDesigner={() => setDesigning(current.id)}
            onPreview={setPreview}
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
      />
      {clipMenu.menu && <ContextMenu at={clipMenu.menu.at} label="Actions on this clip" items={clipMenuItems(clipMenu.menu.subject)} onClose={clipMenu.close} />}

      {exp && (
        <div role="dialog" aria-modal="true" aria-label="Export video" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/85 p-8" onClick={() => setExp(null)}>
          <div className="flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <span className="text-base font-semibold">Export video</span>
            <span className="text-ink-2">{stamp(t.durationMs)} · {playable} clip{playable > 1 ? "s" : ""} · one MP4 in your library</span>
            {exportDone ? (
              <>
                <span>Done. The video is in your library{exportDone.width ? `, ${exportDone.width} × ${exportDone.height}` : ""}.</span>
                <div className="flex flex-wrap gap-2">
                  <a href={fileUrl(exportDone.id)} download={`${t.name}.mp4`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 font-semibold text-accent-ink"><Download size={15} /> Download</a>
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
                {t.music && <Toggle on={exp.music} onChange={(music) => setExp({ ...exp, music })} label="Include the music" />}
                {Math.max(0, ...clips.map((c) => c.take?.asset.fps ?? 0)) < 47 && (
                  <div className="flex flex-col gap-1">
                    <Toggle on={exp.smooth} onChange={(smooth) => setExp({ ...exp, smooth })} label="Frame interpolation" note="48 fps, ffmpeg minterpolate" />
                    <span className="text-xs text-ink-2">The frames in between are worked out by your processor, not by a model: slow (minutes for a short video), and fast motion can smear. Frame interpolation at render time (RIFE, in the clip's form) is better.</span>
                  </div>
                )}
                {misfits > 0 && <span className="text-xs text-ink-2">{misfits} clip{misfits > 1 ? "s have" : " has"} another aspect ratio and will be letterboxed (shown with bars).</span>}
                <div className="flex flex-wrap gap-2">
                  <Button tone="primary" onClick={() => { setExp({ ...exp, asked: true, before: t.exported?.id ?? null }); exportIt.mutate({ scale: exp.scale, music: exp.music, smooth: exp.smooth }); }}>Export</Button>
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
