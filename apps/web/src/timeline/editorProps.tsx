import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { api, type Asset, type Clip, type RecipeInfo } from "../api";
import type { ExportDialog } from "./ExportDialog";
import type { FinishDialog } from "./Finish";
import type { Inspector } from "./Inspector";
import type { OverviewColumn } from "./EditorColumns";
import type { Player } from "./Player";
import type { SoundMenus } from "./SoundMenus";
import type { Track } from "./Track";
import type { TimelineHeader, Transport } from "./EditorBars";
import { ClipDesigner } from "./ClipDesigner";
import { AttentionNote } from "./Overview";
import { PIN_WORDS, pinInputs, pinMirrorOf } from "./model";
import { pinMenuItems, placeItems, type ClipMenuActions } from "./menus";
import type { ContextMenu } from "../ContextMenu";
import type { LoadedEditor } from "./useTimelineEditor";
import { plural } from "../format";
import { carriedOf, CUT_WINDOW, sameWindowGrid } from "@afflatus/core";
import { windowed } from "./track/SourceLane";
import type { ClipRecording } from "./inspector/clipRecording";
import type { RecordingPanelProps } from "./inspector/recording";
import { clipsOfRecording, playsOver, recordingInput, voiceInput } from "./track/RecordingBand";
import { stageEnd } from "./recordingPlace";
import { recordingFormOptions, recordingForms } from "./recordingForms";
import { failedBanner } from "../sayFailed";
import { clipSourceOf, trackSourceProps } from "./sourceProps";

// What each part of the timeline editor is drawn with, from what the editor holds (useTimelineEditor): the wiring
// that would otherwise fill the editor's layout, one builder a part.

export function headerProps(e: LoadedEditor): ComponentProps<typeof TimelineHeader> {
  const { t, clips, render, undo, redo, edit, selection: { picked } } = e;
  return {
    t,
    clips,
    total: e.total,
    saveFailed: e.saveFailed,
    onRetrySave: () => void e.save(),
    said: { error: e.errorShown, note: e.note },
    onHold: e.setHeld,
    undo: { run: () => undo.mutate(), pending: undo.isPending },
    redo: { run: () => redo.mutate(), pending: redo.isPending },
    missing: e.missing,
    allMs: e.allMs,
    allOn: e.allOn,
    allBlocked: e.allBlocked,
    picked: { size: picked.size, renderable: clips.some(e.renderable) },
    rendering: render.isPending,
    onRename: (name) => edit.mutate({ name }),
    onRenderMissing: () => render.mutate({ clips: e.missing }),
    onRenderPicked: () => { render.mutate({ clips: clips.filter(e.renderable) }); e.selection.setPicked(new Set()); },
    onFinish: () => e.setFin(true),
    onExport: () => e.exportNow(t),
  };
}

/** What a picture or a video dropped on the media overlay can become here: a clip, its sound, the music, a pinned frame. */
export const placeItemsOf = (e: LoadedEditor) => (a: Asset) => placeItems(a, {
  current: e.selection.current, clips: e.clips, recipes: e.recipes.data?.recipes ?? [], music: Boolean(e.t.music), inputsOf: e.inputsOf, editInputs: e.editInputs, select: e.selection.select,
  patch: (clip: string, p: { soundAsset: string }) => e.patch.mutate({ clip, patch: p }),
  edit: (p: Parameters<typeof e.edit.mutate>[0]) => e.edit.mutate(p),
  openMusic: () => e.selection.setMusicOpen(true),
  add: (v: { asset: string; after?: string | null }) => e.add.mutate(v),
});

export function playerProps(e: LoadedEditor): ComponentPropsWithoutRef<typeof Player> {
  const { t, player, range, playhead: { muted, volume } } = e;
  return {
    timeline: t.id,
    clips: e.clips,
    music: t.music,
    frame: t.width && t.height ? { width: t.width, height: t.height } : null,
    playing: e.playhead.playing,
    onPlaying: e.playhead.setPlaying,
    onTime: e.playhead.onTime,
    stopAt: e.playhead.stopAt,
    playhead: e.playhead.now,
    preview: e.preview,
    live: e.liveShown,
    onStop: (job) => e.stop.mutate(job),
    master: muted ? 0 : volume,
    screen: { clock: e.playhead.clock, total: e.total, playing: e.playhead.playing, volume, muted, onToggle: e.toggle, onSeek: (ms) => player.current?.seek(ms), onVolume: e.playhead.onVolume, onMute: e.playhead.onMute, onJump: e.jump, loop: range ? { on: e.loopRange, toggle: e.toggleLoop } : undefined },
    onPickPreview: (take) => { if (e.selection.current) e.patch.mutate({ clip: e.selection.current.id, patch: { take: take.id } }); e.setPreview(null); },
  };
}

/** How long the transport runs: the clips, or the source or the recording as far as it reaches when the stage plays it. */
const runOf = (e: LoadedEditor) => Math.max(e.total, stageEndOf(e) ?? 0);
/** Where what the stage plays in place of the clips ends on the track (stageEnd); null when it plays the clips. */
const stageEndOf = (e: LoadedEditor) => stageEnd(e.selection.sourceOpen, e.sourceLane.place, e.recordingAt);

export function transportProps(e: LoadedEditor): ComponentProps<typeof Transport> {
  const { player } = e;
  return {
    t: e.t,
    clock: e.playhead.clock,
    slots: e.slots,
    cursor: e.playhead.cursor,
    total: runOf(e),
    source: e.selection.sourceOpen ? e.sourceLane.place : e.recordingAt ? { atMs: e.recordingAt.toTrack(0), lengthMs: e.recordingAt.lengthMs, label: "Recording", at: e.recordingAt.toRecording } : null,
    playing: e.playhead.playing,
    ranged: Boolean(e.range && !e.emptyRange),
    loopRange: e.loopRange,
    volume: e.playhead.volume,
    muted: e.playhead.muted,
    adding: e.add.isPending,
    saving: e.frame.isPending,
    onJump: e.jump,
    onToggle: e.toggle,
    onToggleLoop: e.toggleLoop,
    onVolume: e.playhead.onVolume,
    onMute: e.playhead.onMute,
    onFullscreen: () => player.current?.fullscreen(),
    onExtend: e.continueHere,
    onSaveFrame: () => {
      const here = player.current?.where();
      if (here?.clip.take) e.frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
      else if (here?.clip.still) e.setOpened(here.clip.still);
    },
  };
}

/**
 * A Lip sync clip's voice set from outside its form (its Audio cell on the track, its menu, its Needs a look row), as its
 * Recording field sets it: over the form as it stands, what was typed meanwhile kept.
 */
function setVoice(e: LoadedEditor, clip: Clip, asset: string) {
  const input = voiceInput(e.videoRecipes.find((r) => r.id === clip.recipe));
  if (input) e.editInputs(clip, (was) => ({ ...was, [input.id]: asset }));
}

export function trackProps(e: LoadedEditor): ComponentProps<typeof Track> {
  const { t, patch, edit, add, render, selection: { musicOpen } } = e;
  return {
    timeline: e.shown,
    recipes: e.videoRecipes,
    pps: e.pps,
    onZoom: e.setPps,
    selected: musicOpen ? null : e.selection.selected,
    musicSelected: musicOpen,
    picked: e.selection.picked,
    onPick: e.selection.togglePick,
    clock: e.playhead.clock,
    running: e.running,
    onStop: (job) => e.stop.mutate(job),
    // a clip with nothing to play yet renders from the track itself, as from its menu
    renderOf: (c) => (c.kind === "video" && !c.job && e.ready(c).input && !render.isPending ? { run: () => render.mutate({ clips: [c] }), ms: e.takes(c) } : null),
    busy: add.isPending,
    onSelect: (clipId) => e.selection.select(clipId),
    // the music's panel: opening it closes a recording open (useEditorPanels), the source's keeps the column, as it did
    onSelectMusic: () => e.selection.setMusicOpen(true),
    cursorMs: e.playhead.cursor,
    onSeek: (ms, trackMs) => {
      // the stage plays the source or a recording: the playhead stands in the track's own time
      e.player.current?.seek((e.selection.sourceOpen || e.recordingAt) && trackMs !== undefined ? trackMs : ms);
      // after the seek, which says where the player is: the playhead stays exactly where it was put
      if (trackMs !== undefined) e.playhead.setCursor(trackMs);
    },
    // its answer tells the track whether to keep the order dropped (until the timeline says it) or glide back
    onMove: (clip, afterId) => patch.mutateAsync({ clip, patch: { after: afterId } }),
    onJoin: (clip, joined) => patch.mutate({ clip: clip.id, patch: { joined } }),
    onOpenJoin: (clip) => e.selection.openJoin(clip.id),
    onRecording: (asset, clip) => e.recording.run(asset, clip),
    // its Audio cell, its menu: the clip opened on its form, the recording in its Recording field
    onVoice: (clip, asset) => {
      setVoice(e, clip, asset);
      e.selection.select(clip.id);
    },
    // a clip not rendered yet given another model, as its Model field does for one the source did not make
    onRecipe: (clip, recipe) => patch.mutate({ clip: clip.id, patch: { recipe } }),
    onSourceSettings: () => e.selection.openSource(),
    // its band on the Audio row dragged: trimmed as its Recording chapter's In and Out trim it
    onRecordingTrim: (asset, fromMs, toMs) => e.recordingTrim.run(asset, clipsOfRecording(e.clips, e.videoRecipes, asset), fromMs, toMs),
    // a removed part's mark on its band or the Source lane: its clips back, before the clip it was kept with
    onBringBack: (before) => e.bringBack.mutate(before),
    // its band clicked: the recording on the stage and in the column, as the source lane opens
    recordingOpen: e.selection.recordingOpen,
    stageEndMs: e.recordingAt ? stageEndOf(e) : null,
    onView: e.recordingAt ? e.trackView.set : undefined,
    onOpenRecording: (asset, atMs) => e.openRecordingAt(asset, atMs),
    // the source lane: a video dropped on it, the lane clicked, dragged and split (sourceProps.ts)
    ...trackSourceProps(e),
    onTransition: (clip, transition) => {
      patch.mutate({ clip, patch: { transition } });
      e.selection.openJoin(clip);
    },
    onInsert: (asset, afterId) => add.mutate({ after: afterId, asset }),
    onUpload: (file, reuse) =>
      api.upload(file, { folder: t.folderId ?? undefined, project: t.projectId ?? null, reuse })
        .then((a) => ({ id: a.id, kind: a.kind }))
        .catch((err: unknown) => {
          e.say(failedBanner({ id: "upload", here: true }, `${file.name} could not be added`, err));
          return null;
        }),
    onPin: (clip, where, asset, atS) => {
      const pins = pinInputs(e.recipes.data?.recipes.find((r) => r.id === clip.recipe));
      const input = pins[where];
      if (!input) return;
      // over the form as it stands when the file lands: a file from the computer is uploaded first, and what was typed
      // over the clip meanwhile stays
      e.editInputs(clip, (was) => ({ ...was, [input]: asset, ...(where === "mid" && pins.midAt && atS ? { [pins.midAt]: atS } : {}) }));
      e.selection.select(clip.id);
    },
    onClipSound: (clip, asset) => patch.mutate({ clip, patch: { soundAsset: asset } }),
    onMusic: (asset) => {
      edit.mutate({ music: { asset } });
      e.selection.setMusicOpen(true);
    },
    onTrim: (clip, p) => patch.mutate({ clip: clip.id, patch: p }),
    onNewClip: (afterId) => e.newClip(afterId),
    onMenu: (clip, ev) => e.clipMenu.open(ev, clip),
    onSoundMenu: (clip, ev) => e.soundMenu.open(ev, clip),
    onPinMenu: (clip, where, ev) => e.pinMenu.open(ev, { clip, where }),
    onMusicMenu: (ev) => e.musicMenu.open(ev, true),
    // (its failure is said in the header as edit's; the lane lets go of what it drew)
    onMusicEdit: (p) => edit.mutateAsync(p),
    onClipMusic: (clip, music) => patch.mutate({ clip: clip.id, patch: { music } }),
    range: e.range,
    onRange: e.setRange,
    onRangeMenu: (ev) => e.rangeMenu.open(ev, true),
    snapQuiet: e.snapQuiet,
    keys: e.trackKeys,
  };
}

/**
 * A clip under a recording (its form's recording, part by part), whatever its form, as its panel takes it: the Recording
 * chapter, the recording's stretch over all its clips. Undefined for any other clip.
 */
function clipRecordingOf(e: LoadedEditor, current: Clip): ClipRecording | undefined {
  const w = recordingInput(e.videoRecipes.find((r) => r.id === current.recipe));
  if (!w) return undefined;
  const asset = current.inputs[w.id];
  if (typeof asset !== "string" || !asset) return undefined;
  // as shown, with what is typed and not read back yet (the band reads them so): a voice just given, its part worked out.
  // Every clip under it, whatever its form (card #72): Lip sync and those it plays over make one stretch
  const mine = clipsOfRecording(e.shown.clips, e.videoRecipes, asset);
  const at = (c: Clip) => Math.round(Number(c.inputs[w.start] ?? 0) * 1000);
  const end = (c: Clip) => at(c) + Math.round(Number(c.inputs[w.seconds] ?? 0) * 1000);
  const ask = e.recordingTrim.ask?.asset === asset ? e.recordingTrim.ask : null;
  return {
    count: mine.length,
    over: playsOver(current, e.videoRecipes),
    part: { startMs: at(current), seconds: Number(current.inputs[w.seconds] ?? 0) },
    fromMs: mine.length ? at(mine[0]!) : 0,
    toMs: mine.length ? end(mine.at(-1)!) : 0,
    onUses: (fromMs, toMs) => e.recordingTrim.run(asset, mine, fromMs, toMs),
    ask: ask ? { fromMs: ask.fromMs, rendered: ask.rendered, clips: ask.clips, change: () => e.recordingTrim.run(asset, mine, ask.fromMs, ask.toMs, true), keep: e.recordingTrim.keep } : null,
    trimming: e.recordingTrim.pending || e.recordingTrim.waits(asset),
  };
}

/**
 * The recording open in the column, as its panel takes it (inspector/recording.tsx): the edits go through the paths the
 * band and a clip's Recording chapter use (the recording trim), the cut and the shared settings through their own, its
 * first clip's join through the clip's patch, its clips with nothing to play rendered as Render all renders them.
 */
export function recordingPanelProps(e: LoadedEditor, place: NonNullable<LoadedEditor["recordingAt"]>): RecordingPanelProps | null {
  const recording = e.t.recordings?.find((r) => r.asset.id === e.selection.recordingOpen);
  const first = place.parts[0]!.clip;
  const recipe = e.videoRecipes.find((r) => r.id === first.recipe);
  const input = recordingInput(recipe);
  if (!recording || !recipe || !input) return null;
  const asset = recording.asset.id;
  const mine = place.parts.map((p) => p.clip);
  const ids = new Set(mine.map((c) => c.id));
  const left = e.missing.filter((c) => ids.has(c.id));
  const trimAsk = e.recordingTrim.ask?.asset === asset ? e.recordingTrim.ask : null;
  const cutAsk = e.recordingCut.ask?.asset === asset ? e.recordingCut.ask : null;
  const seconds = recording.seconds ?? 5;
  const within = recording.window ?? CUT_WINDOW;
  // what the clips share: the scene and how they look, as each clip's form holds it now (what was typed with it); of every
  // form its clips are in (card #72), each field read off the clips whose form has it
  const formsIn = [...new Set(mine.map((c) => c.recipe))].map((id) => e.videoRecipes.find((r) => r.id === id)).filter((r): r is RecipeInfo => Boolean(r));
  const fields = formsIn.flatMap((r) => r.inputs).filter((i, k, all) => i.type === "prompt" && (!i.optional || i.holds === "subject") && all.findIndex((x) => x.id === i.id) === k);
  const shared = fields.map((i) => {
    const values = mine.filter((c) => e.videoRecipes.find((r) => r.id === c.recipe)?.inputs.some((x) => x.id === i.id)).map((c) => String(e.inputsOf(c)[i.id] ?? ""));
    return { id: i.id, label: i.label, value: values.every((v) => v === values[0]) ? (values[0] ?? "") : null, placeholder: i.type === "prompt" ? i.placeholder : undefined };
  });
  const at = e.clips.indexOf(first);
  const families = e.recipes.data?.families;
  // each clip's form, changed in place, as its model list offers the forms under a recording (each says how it meets the
  // clip before); named by their titles in the list's rows, the family the same for all
  const formOptions = (c: Clip) => {
    const k = e.clips.indexOf(c);
    const before = k > 0 ? e.clips[k - 1] : undefined;
    const prior = before?.kind === "video" && before.recipe ? e.videoRecipes.find((r) => r.id === before.recipe) : undefined;
    return recordingFormOptions(e.videoRecipes, families, prior, { short: true });
  };
  const newForm = recording.form ?? recordingForms(e.videoRecipes)[0]?.id ?? recipe.id;
  return {
    timelineId: e.t.id,
    recording: recording.asset,
    place,
    newClips: { value: newForm, options: recordingFormOptions(e.videoRecipes, families, undefined), onChange: (to) => e.m.recordingNewClips.mutate({ asset, recipe: to }), pending: e.m.recordingNewClips.isPending },
    forms: { of: formOptions, change: (clip, to) => e.patch.mutate({ clip, patch: { recipe: to } }) },
    clock: e.playhead.clock,
    onClose: () => e.selection.setRecordingOpen(null),
    onUses: (fromMs, toMs) => void e.recordingTrim.run(asset, mine, fromMs, toMs),
    trimAsk: trimAsk ? { fromMs: trimAsk.fromMs, rendered: trimAsk.rendered, clips: trimAsk.clips, change: () => void e.recordingTrim.run(asset, mine, trimAsk.fromMs, trimAsk.toMs, true), keep: e.recordingTrim.keep } : null,
    trimming: e.recordingTrim.pending || e.recordingTrim.waits(asset),
    cut: {
      seconds,
      within,
      leastMs: input.leastMs,
      mostMs: input.mostMs,
      stepMs: recipe.traits?.frameGrid && recipe.traits.fps ? (recipe.traits.frameGrid.step * 1000) / recipe.traits.fps : null,
      run: (s, w) => e.recordingCut.run(asset, s, w),
      ask: cutAsk ? { rendered: cutAsk.rendered, clips: cutAsk.clips, change: () => e.recordingCut.run(asset, cutAsk.seconds, cutAsk.within, true), keep: e.recordingCut.keep } : null,
      pending: e.recordingCut.pending,
    },
    onSelectClip: (id) => e.selection.select(id),
    opens: { before: at > 0 ? at : null, joined: first.joined, onJoined: (joined) => e.patch.mutate({ clip: first.id, patch: { joined } }) },
    shared,
    onShared: (inputs) => e.recordingShared.run(asset, inputs),
    sharing: e.recordingShared.pending,
    render: (() => {
      // with nothing to play and not sent: those that cannot render yet are said, with the first one's reason
      const waiting = mine.filter((c) => !c.take && !c.job && !left.includes(c));
      return { left: left.length, queued: mine.filter((c) => c.job).length, waiting: waiting.length, why: left.length ? null : (waiting.map((c) => e.ready(c).why).find(Boolean) ?? null), run: () => e.render.mutate({ clips: left }), rendering: e.render.isPending };
    })(),
  };
}

export function inspectorProps(e: LoadedEditor, current: Clip): ComponentProps<typeof Inspector> {
  const { t, clips, recipes, render, patch, designed, writeBetween } = e;
  return {
    fromSource: clipSourceOf(e, current),
    fromRecording: clipRecordingOf(e, current),
    onSelectClip: e.selection.select,
    timeline: t,
    clip: current,
    index: clips.indexOf(current),
    recipes: e.videoRecipes,
    stored: e.inputsOf(current),
    whole: e.formOf(current),
    why: e.ready(current).why ?? null,
    takesMs: e.takes(current),
    takesOn: (m) => e.takesOn(current, m),
    busy: render.isPending,
    // a render that failed for this clip, not for another one
    error: render.isError && render.variables?.clips.some((c) => c.id === current.id) ? render.error.message : null,
    // the run-up of a clip the source made (Overlap frames, under All settings): the source's, every window
    // carrying on from that many frames, so the source is cut again for it (its rendered clips at the start kept)
    onInputs: (next) => {
      const src = clipSourceOf(e, current);
      const recipe = e.videoRecipes.find((r) => r.id === current.recipe);
      const runUp = recipe?.traits?.windows?.runUp?.input;
      // the count it carries on from, not the value written (the form also sends the 22 it starts on)
      if (src && runUp && carriedOf(recipe, next) !== carriedOf(recipe, e.inputsOf(current))) {
        return e.sourceLane.cutSource.run({ inputs: { ...src.source.inputs, [runUp]: next[runUp] } });
      }
      e.editInputs(current, next);
    },
    // a clip the source made, given another model that makes a source window by window: the source's model, its clips not
    // rendered made anew with it (a clip of another model in the line would no longer share its form)
    // An empty clip given one, on a timeline whose source is made: the source's next window, in that clip's place (cut again
    // from where its rendered clips end)
    onRecipe: (recipe) => {
      const made = windowed(e.videoRecipes.find((r) => r.id === recipe));
      // Apply to: This clip, a form of the source's grid: this window alone, in place (card #42: a swap again where the motion
      // drifts, or where the lips must follow the source), its takes kept
      const next = e.videoRecipes.find((r) => r.id === recipe);
      const of = e.videoRecipes.find((r) => r.id === e.t.source?.recipe);
      if (made && clipSourceOf(e, current) && e.keptToClip(current.id) && sameWindowGrid(of, next)) return e.m.windowForm.mutate({ clip: current.id, recipe });
      // the source's form, every window with it: on the same grid in place, its takes kept; else made anew, asked first (sourceForm)
      if (made && clipSourceOf(e, current)) return e.sourceLane.sourceForm.run(recipe);
      if (made && e.sourceLane.place?.made && !current.take && !current.job) return e.sourceLane.cutSource.run({ recipe, clip: current.id });
      patch.mutate({ clip: current.id, patch: { recipe } });
    },
    onPatch: (p) => patch.mutate({ clip: current.id, patch: p }),
    onRender: (count) => render.mutate({ clips: [current], takes: count }),
    onMenu: (ev) => e.clipMenu.open(ev, current),
    onOpen: e.setOpened,
    onRemoveTake: (takeId) => e.removeTake.mutate(takeId),
    onStop: () => current.job && e.stop.mutate(current.job.id),
    onDesigner: () => e.setDesigning((d) => (d ? null : current.id)),
    designer: designed ? (
      <ClipDesigner
        timeline={t}
        clip={designed}
        clips={clips}
        recipes={recipes.data?.recipes ?? []}
        setup={e.setup}
        settings={e.settings}
        inputsOf={e.inputsOf}
        sayOf={e.sayOf}
        turns={e.talks[designed.id]}
        onTurns={(turns) => e.setTalks((all) => ({ ...all, [designed.id]: turns }))}
        session={e.sessions[designed.id]}
        onSession={(session) => e.setSessions((all) => ({ ...all, [designed.id]: session }))}
        onApply={(changes) => e.editInputs(designed, { ...e.inputsOf(designed), ...changes })}
        onClose={() => e.setDesigning(null)}
      />
    ) : undefined,
    onClose: () => e.selection.setSelected(null),
    onPreview: e.setPreview,
    writing: writeBetween.isPending && e.writing === current.id,
    writeError: writeBetween.isError && writeBetween.variables?.clip === current.id && writeBetween.variables.force ? writeBetween.error.message : null,
    onWriteBetween: () => writeBetween.mutate({ clip: current.id, force: true }),
  };
}

export function overviewProps(e: LoadedEditor): ComponentProps<typeof OverviewColumn> {
  const { clips, render, add, plan } = e;
  return {
    t: e.t,
    clips,
    checks: e.checks,
    width: e.panelWidth,
    picked: e.selection.picked,
    rendering: render.isPending || e.fix.isPending,
    onEdit: (p) => e.edit.mutate(p),
    onPick: (id) => e.selection.select(id),
    onVoice: (id, asset) => {
      const clip = e.shown.clips.find((c) => c.id === id);
      if (clip) setVoice(e, clip, asset);
    },
    onMusic: () => e.selection.setMusicOpen(true),
    onCast: () => e.setCasting(true),
    onFix: (f) => e.fix.mutate(f),
    onRenderPicked: () => { render.mutate({ clips: clips.filter(e.renderable) }); e.selection.setPicked(new Set()); },
    start: { busy: add.isPending, planning: plan.isPending, onPickImage: () => e.setPicking(true), onPlan: (idea, count) => plan.mutate({ idea, clips: count }), onNewClip: () => e.newClip() },
  };
}

/**
 * The menu of a pinned frame right-clicked on the track: Mirror, Open (the viewer) and Remove, as the Inspector's row has them
 * (its Change is the Inspector's picker). Null when no such menu is open, or the frame is no longer pinned.
 */
export function pinMenuProps(e: LoadedEditor): ComponentProps<typeof ContextMenu> | null {
  const open = e.pinMenu.menu;
  if (!open) return null;
  const clip = e.shown.clips.find((c) => c.id === open.subject.clip.id) ?? open.subject.clip;
  const index = e.shown.clips.indexOf(clip);
  const recipe = e.recipes.data?.recipes.find((r) => r.id === clip.recipe);
  const inputs = e.inputsOf(clip);
  const pin = pinMirrorOf(clip, recipe, inputs, open.subject.where, index > 0 && clip.joined === "continue");
  if (!pin) return null;
  const asset = clip.pictures.find((p) => p.asset.id === pin.asset)?.asset;
  const words = PIN_WORDS[pin.where];
  return {
    at: open.at,
    label: `Actions on the ${words} of clip ${index + 1}`,
    head: { title: `Clip ${index + 1} · ${words}`, sub: pin.on ? "mirrored at render time" : "pinned", thumb: pin.asset },
    items: pinMenuItems(pin, {
      mirror: (on) => e.patch.mutate({ clip: clip.id, patch: { pinMirror: { [pin.input]: on } } }),
      open: asset ? () => e.setOpened(asset) : undefined,
      remove: () => e.editInputs(clip, Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== pin.input))),
    }),
    onClose: e.pinMenu.close,
  };
}

/** What a clip's menu reaches: the editor's mutations, by name. */
export function clipActs(e: LoadedEditor): ClipMenuActions {
  const { clips, render, split, duplicate, loop, add, frame, rangeAct, remove, removeMany, patch } = e;
  return {
    clips: e.shown.clips,
    recipes: e.recipes.data?.recipes ?? [],
    source: e.t.source,
    inputsOf: e.inputsOf,
    onClip: e.onClip,
    pending: { render: render.isPending, split: split.isPending, duplicate: duplicate.isPending, loop: loop.isPending, add: add.isPending, frame: frame.isPending, range: rangeAct.isPending },
    render: (c) => render.mutate({ clips: [c] }),
    patch: (clip, p) => patch.mutate({ clip, patch: p }),
    setRange: e.setRange,
    split: (clip, atMs) => {
      const c = clips.find((x) => x.id === clip);
      if (c) e.splitAt(c, atMs);
    },
    stepTake: e.stepTake,
    duplicate: (clip) => duplicate.mutate(clip),
    loop: (c) => loop.mutate(c),
    continueFrom: e.continueFrom,
    frame: (asset, at) => frame.mutate({ asset, at }),
    open: e.setOpened,
    slow: (factor, inMs, outMs) => rangeAct.mutate({ slow: factor, inMs, outMs }),
    remove: (clip) => remove.mutate(clip),
    move: e.move,
    openJoin: e.selection.openJoin,
    picked: e.selection.picked,
    removeMany: (ids) => removeMany.mutate(ids),
    toSource: (c) => {
      if (!c.take) return;
      // the source sits so that what the clip plays stays where it is; the clips made from it take its place
      e.edit.mutate({ source: { asset: c.take.asset.id, atMs: c.atMs - c.take.startMs, fromMs: c.take.startMs, toMs: c.take.endMs, clip: c.id } });
      e.selection.openSource();
    },
  };
}

export function soundMenusProps(e: LoadedEditor): ComponentProps<typeof SoundMenus> {
  return {
    t: e.t,
    clips: e.shown.clips,
    soundMenu: e.soundMenu,
    musicMenu: e.musicMenu,
    onPatch: (clip, p) => e.patch.mutate({ clip, patch: p }),
    onEdit: (p) => e.edit.mutate(p),
    select: e.selection.select,
    openMusic: () => { e.selection.setSelected(null); e.selection.setMusicOpen(true); },
    showMusic: () => e.selection.setMusicOpen(true),
  };
}

export function exportProps(e: LoadedEditor, exp: NonNullable<LoadedEditor["exp"]>): ComponentProps<typeof ExportDialog> {
  const { t, clips } = e;
  return {
    timeline: t,
    clips,
    ask: exp,
    onChange: e.setExp,
    range: e.range,
    emptyRange: e.emptyRange,
    finishedSize: e.finishedSize,
    misfits: e.misfits,
    exporting: e.exportIt.isPending,
    attention: <AttentionNote timeline={t} clips={clips} {...e.checks} onFixFirst={(plan) => e.fixFirst(plan, () => e.setExp(null))} />,
    onExport: (v) => e.exportIt.mutate(v),
    onFinishFirst: () => {
      e.setExp(null);
      e.setFin(true);
    },
    onOpen: e.setOpened,
    onClose: () => e.setExp(null),
  };
}

export function finishProps(e: LoadedEditor): ComponentProps<typeof FinishDialog> {
  const { t, clips, setNote } = e;
  return {
    timeline: e.id,
    clips,
    // ComfyUI's upscale_models, as any recipe with an upscale model to pick lists them
    upscaleModels: e.setup.data?.recipes.find((r) => r.options.upscaleModel?.length)?.options.upscaleModel ?? [],
    // and the files the H3 forms' Face refine and latent upscaler, and the SeedVR2 route, offer (card #159)
    models: {
      face: e.setup.data?.recipes.find((r) => r.id === "h3.video")?.options.faceRefineModel ?? [],
      latent: e.setup.data?.recipes.find((r) => r.id === "h3.video")?.options.upscaleLatentModel ?? [],
      seedvr: e.setup.data?.recipes.find((r) => r.options.seedvrModel?.length)?.options.seedvrModel ?? [],
    },
    attention: <AttentionNote timeline={t} clips={clips} {...e.checks} onFixFirst={(plan) => e.fixFirst(plan, () => e.setFin(false))} />,
    onClose: () => e.setFin(false),
    onQueued: (r) => {
      e.after();
      e.setFin(false);
      setNote(`${plural(r.jobs.length, "finish job")} in the queue${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, `One job a clip (two with Face refine before an upscale); the finished takes arrive as they land.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `clip ${x.clip} (${x.why})`).join(", ")}.` : ""}`);
    },
  };
}
