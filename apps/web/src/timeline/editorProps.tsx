import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { api, type Asset, type Clip } from "../api";
import type { Inspector } from "./Inspector";
import type { OverviewColumn } from "./EditorColumns";
import type { Player } from "./Player";
import type { SoundMenus } from "./SoundMenus";
import type { Track } from "./Track";
import type { TimelineHeader, Transport } from "./EditorBars";
import { ClipDesigner } from "./ClipDesigner";
import { PIN_WORDS, pinInputs, pinMirrorOf } from "./model";
import { pinMenuItems, placeItems, type ClipMenuActions } from "./menus";
import type { ContextMenu } from "../ContextMenu";
import type { LoadedEditor } from "./useTimelineEditor";
import { carriedOf, sameWindowGrid } from "@afflatus/core";
import { windowed } from "./track/SourceLane";
import { voiceInput } from "./track/RecordingBand";
import { failedBanner } from "../sayFailed";
import { clipSourceOf, trackSourceProps } from "./sourceProps";
import { clipRecordingOf, stageEndOf, trackRecordingProps } from "./recordingProps";

// What each part of the timeline editor is drawn with, from what the editor holds (useTimelineEditor): the wiring
// that would otherwise fill the editor's layout, one builder a part.

export function headerProps(e: LoadedEditor): ComponentProps<typeof TimelineHeader> {
  const { t, clips, selection: { picked }, actions: { render, undo, redo, edit } } = e;
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
    onFinish: () => e.finish.setFin(true),
    onExport: () => e.finish.exportNow(t),
  };
}

/** What a picture or a video dropped on the media overlay can become here: a clip, its sound, the music, a pinned frame. */
export const placeItemsOf = (e: LoadedEditor) => (a: Asset) => placeItems(a, {
  current: e.selection.current, clips: e.clips, recipes: e.recipes.data?.recipes ?? [], music: Boolean(e.t.music), inputsOf: e.inputsOf, editInputs: e.editInputs, select: e.selection.select,
  patch: (clip: string, p: { soundAsset: string }) => e.actions.patch.mutate({ clip, patch: p }),
  edit: (p: Parameters<typeof e.actions.edit.mutate>[0]) => e.actions.edit.mutate(p),
  openMusic: () => e.selection.setMusicOpen(true),
  add: (v: { asset: string; after?: string | null }) => e.actions.add.mutate(v),
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
    onStop: (job) => e.actions.stop.mutate(job),
    master: muted ? 0 : volume,
    screen: { clock: e.playhead.clock, total: e.total, playing: e.playhead.playing, volume, muted, onToggle: e.toggle, onSeek: (ms) => player.current?.seek(ms), onVolume: e.playhead.onVolume, onMute: e.playhead.onMute, onJump: e.jump, loop: range ? { on: e.loopRange, toggle: e.toggleLoop } : undefined },
    onPickPreview: (take) => { if (e.selection.current) e.actions.patch.mutate({ clip: e.selection.current.id, patch: { take: take.id } }); e.setPreview(null); },
  };
}

/** How long the transport runs: the clips, or the source or the recording as far as it reaches when the stage plays it. */
const runOf = (e: LoadedEditor) => Math.max(e.total, stageEndOf(e) ?? 0);

export function transportProps(e: LoadedEditor): ComponentProps<typeof Transport> {
  const { player } = e;
  return {
    t: e.t,
    clock: e.playhead.clock,
    slots: e.slots,
    cursor: e.playhead.cursor,
    total: runOf(e),
    source: e.selection.sourceOpen ? e.sourceLane.place : e.recordings.recordingAt ? { atMs: e.recordings.recordingAt.toTrack(0), lengthMs: e.recordings.recordingAt.lengthMs, label: "Recording", at: e.recordings.recordingAt.toRecording } : null,
    playing: e.playhead.playing,
    ranged: Boolean(e.range && !e.emptyRange),
    loopRange: e.loopRange,
    volume: e.playhead.volume,
    muted: e.playhead.muted,
    adding: e.actions.add.isPending,
    saving: e.actions.frame.isPending,
    onJump: e.jump,
    onToggle: e.toggle,
    onToggleLoop: e.toggleLoop,
    onVolume: e.playhead.onVolume,
    onMute: e.playhead.onMute,
    onFullscreen: () => player.current?.fullscreen(),
    onExtend: e.continueHere,
    onSaveFrame: () => {
      const here = player.current?.where();
      if (here?.clip.take) e.actions.frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
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
  const { t, selection: { musicOpen }, actions: { patch, edit, add, render } } = e;
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
    onStop: (job) => e.actions.stop.mutate(job),
    // a clip with nothing to play yet renders from the track itself, as from its menu
    renderOf: (c) => (c.kind === "video" && !c.job && e.ready(c).input && !render.isPending ? { run: () => render.mutate({ clips: [c] }), ms: e.takes(c) } : null),
    busy: add.isPending,
    onSelect: (clipId) => e.selection.select(clipId),
    // the music's panel: opening it closes a recording open (useEditorPanels), the source's keeps the column, as it did
    onSelectMusic: () => e.selection.setMusicOpen(true),
    cursorMs: e.playhead.cursor,
    onSeek: (ms, trackMs) => {
      // the stage plays the source or a recording: the playhead stands in the track's own time
      e.player.current?.seek((e.selection.sourceOpen || e.recordings.recordingAt) && trackMs !== undefined ? trackMs : ms);
      // after the seek, which says where the player is: the playhead stays exactly where it was put
      if (trackMs !== undefined) e.playhead.setCursor(trackMs);
    },
    // its answer tells the track whether to keep the order dropped (until the timeline says it) or glide back
    onMove: (clip, afterId) => patch.mutateAsync({ clip, patch: { after: afterId } }),
    onJoin: (clip, joined) => patch.mutate({ clip: clip.id, patch: { joined } }),
    onOpenJoin: (clip) => e.selection.openJoin(clip.id),
    // its Audio cell, its menu: the clip opened on its form, the recording in its Recording field
    onVoice: (clip, asset) => {
      setVoice(e, clip, asset);
      e.selection.select(clip.id);
    },
    // a clip not rendered yet given another model, as its Model field does for one the source did not make
    onRecipe: (clip, recipe) => patch.mutate({ clip: clip.id, patch: { recipe } }),
    onSourceSettings: () => e.selection.openSource(),
    // a removed part's mark on its band or the Source lane: its clips back, before the clip it was kept with
    onBringBack: (before) => e.actions.bringBack.mutate(before),
    // a recording's band: clicked, dragged, the clips made from it (recordingProps.ts)
    ...trackRecordingProps(e),
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

export function inspectorProps(e: LoadedEditor, current: Clip): ComponentProps<typeof Inspector> {
  const { t, clips, recipes, designed, actions: { render, patch, writeBetween } } = e;
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
      if (made && clipSourceOf(e, current) && e.keptToClip(current.id) && sameWindowGrid(of, next)) return e.actions.windowForm.mutate({ clip: current.id, recipe });
      // the source's form, every window with it: on the same grid in place, its takes kept; else made anew, asked first (sourceForm)
      if (made && clipSourceOf(e, current)) return e.sourceLane.sourceForm.run(recipe);
      if (made && e.sourceLane.place?.made && !current.take && !current.job) return e.sourceLane.cutSource.run({ recipe, clip: current.id });
      patch.mutate({ clip: current.id, patch: { recipe } });
    },
    onPatch: (p) => patch.mutate({ clip: current.id, patch: p }),
    onRender: (count) => render.mutate({ clips: [current], takes: count }),
    onMenu: (ev) => e.clipMenu.open(ev, current),
    onOpen: e.setOpened,
    onRemoveTake: (takeId) => e.actions.removeTake.mutate(takeId),
    onStop: () => current.job && e.actions.stop.mutate(current.job.id),
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
  const { clips, actions: { render, add, plan } } = e;
  return {
    t: e.t,
    clips,
    checks: e.checks,
    width: e.panelWidth,
    picked: e.selection.picked,
    rendering: render.isPending || e.actions.fix.isPending,
    onEdit: (p) => e.actions.edit.mutate(p),
    onPick: (id) => e.selection.select(id),
    onVoice: (id, asset) => {
      const clip = e.shown.clips.find((c) => c.id === id);
      if (clip) setVoice(e, clip, asset);
    },
    onMusic: () => e.selection.setMusicOpen(true),
    onCast: () => e.setCasting(true),
    onFix: (f) => e.actions.fix.mutate(f),
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
      mirror: (on) => e.actions.patch.mutate({ clip: clip.id, patch: { pinMirror: { [pin.input]: on } } }),
      open: asset ? () => e.setOpened(asset) : undefined,
      remove: () => e.editInputs(clip, Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== pin.input))),
    }),
    onClose: e.pinMenu.close,
  };
}

/** What a clip's menu reaches: the editor's mutations, by name. */
export function clipActs(e: LoadedEditor): ClipMenuActions {
  const { clips, rangeAct, actions: { render, split, duplicate, loop, add, frame, remove, removeMany, patch } } = e;
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
      e.actions.edit.mutate({ source: { asset: c.take.asset.id, atMs: c.atMs - c.take.startMs, fromMs: c.take.startMs, toMs: c.take.endMs, clip: c.id } });
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
    onPatch: (clip, p) => e.actions.patch.mutate({ clip, patch: p }),
    onEdit: (p) => e.actions.edit.mutate(p),
    select: e.selection.select,
    openMusic: () => { e.selection.setSelected(null); e.selection.setMusicOpen(true); },
    showMusic: () => e.selection.setMusicOpen(true),
  };
}
