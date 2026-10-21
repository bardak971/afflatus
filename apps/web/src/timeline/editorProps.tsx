import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { api, type Asset, type Clip } from "../api";
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
import { carriedOf, windowBounds } from "@afflatus/core";
import { madeFromSource, windowed } from "./track/SourceLane";
import type { ClipSource } from "./inspector/clipSource";
import { failedBanner } from "../sayFailed";

// What each part of the timeline editor is drawn with, from what the editor holds (useTimelineEditor): the wiring
// that would otherwise fill the editor's layout, one builder a part.

export function headerProps(e: LoadedEditor): ComponentProps<typeof TimelineHeader> {
  const { t, clips, picked, render, undo, redo, edit } = e;
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
    onRenderPicked: () => { render.mutate({ clips: clips.filter(e.renderable) }); e.setPicked(new Set()); },
    onFinish: () => e.setFin(true),
    onExport: () => e.exportNow(t),
  };
}

/** What a picture or a video dropped on the media overlay can become here: a clip, its sound, the music, a pinned frame. */
export const placeItemsOf = (e: LoadedEditor) => (a: Asset) => placeItems(a, {
  current: e.current, clips: e.clips, recipes: e.recipes.data?.recipes ?? [], music: Boolean(e.t.music), inputsOf: e.inputsOf, editInputs: e.editInputs, select: e.select,
  patch: (clip: string, p: { soundAsset: string }) => e.patch.mutate({ clip, patch: p }),
  edit: (p: Parameters<typeof e.edit.mutate>[0]) => e.edit.mutate(p),
  openMusic: () => e.setMusicOpen(true),
  add: (v: { asset: string; after?: string | null }) => e.add.mutate(v),
});

export function playerProps(e: LoadedEditor): ComponentPropsWithoutRef<typeof Player> {
  const { t, player, range, muted, volume } = e;
  return {
    timeline: t.id,
    clips: e.clips,
    music: t.music,
    frame: t.width && t.height ? { width: t.width, height: t.height } : null,
    playing: e.playing,
    onPlaying: e.setPlaying,
    onTime: e.onTime,
    preview: e.preview,
    live: e.liveShown,
    onStop: (job) => e.stop.mutate(job),
    master: muted ? 0 : volume,
    screen: { clock: e.clock, total: e.total, playing: e.playing, volume, muted, onToggle: e.toggle, onSeek: (ms) => player.current?.seek(ms), onVolume: e.onVolume, onMute: e.onMute, onJump: e.jump, loop: range ? { on: e.loopRange, toggle: e.toggleLoop } : undefined },
    onPickPreview: (take) => { if (e.current) e.patch.mutate({ clip: e.current.id, patch: { take: take.id } }); e.setPreview(null); },
  };
}

/** How long the transport runs: the clips, or the source as far as it reaches when the stage plays it. */
const runOf = (e: LoadedEditor) => (e.sourceOpen && e.place ? Math.max(e.total, e.place.atMs + e.place.lengthMs) : e.total);

export function transportProps(e: LoadedEditor): ComponentProps<typeof Transport> {
  const { player } = e;
  return {
    t: e.t,
    clock: e.clock,
    slots: e.slots,
    cursor: e.cursor,
    total: runOf(e),
    source: e.sourceOpen ? e.place : null,
    playing: e.playing,
    ranged: Boolean(e.range && !e.emptyRange),
    loopRange: e.loopRange,
    volume: e.volume,
    muted: e.muted,
    adding: e.add.isPending,
    saving: e.frame.isPending,
    onJump: e.jump,
    onToggle: e.toggle,
    onToggleLoop: e.toggleLoop,
    onVolume: e.onVolume,
    onMute: e.onMute,
    onFullscreen: () => player.current?.fullscreen(),
    onExtend: e.continueHere,
    onSaveFrame: () => {
      const here = player.current?.where();
      if (here?.clip.take) e.frame.mutate({ asset: here.clip.take.asset.id, at: Math.round(here.assetMs) });
      else if (here?.clip.still) e.setOpened(here.clip.still);
    },
  };
}

export function trackProps(e: LoadedEditor): ComponentProps<typeof Track> {
  const { t, patch, edit, add, render, musicOpen } = e;
  return {
    timeline: e.shown,
    recipes: e.videoRecipes,
    pps: e.pps,
    onZoom: e.setPps,
    selected: musicOpen ? null : e.selected,
    musicSelected: musicOpen,
    picked: e.picked,
    onPick: (id) => e.setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    clock: e.clock,
    running: e.running,
    onStop: (job) => e.stop.mutate(job),
    // a clip with nothing to play yet renders from the track itself, as from its menu
    renderOf: (c) => (c.kind === "video" && !c.job && e.ready(c).input && !render.isPending ? { run: () => render.mutate({ clips: [c] }), ms: e.takes(c) } : null),
    busy: add.isPending,
    onSelect: (clipId) => e.select(clipId),
    onSelectMusic: () => e.setMusicOpen(true),
    cursorMs: e.cursor,
    onSeek: (ms, trackMs) => {
      // the stage plays the source: the playhead stands in the track's own time
      e.player.current?.seek(e.sourceOpen && trackMs !== undefined ? trackMs : ms);
      // after the seek, which says where the player is: the playhead stays exactly where it was put
      if (trackMs !== undefined) e.setCursor(trackMs);
    },
    onMove: (clip, afterId) => patch.mutate({ clip, patch: { after: afterId } }),
    onJoin: (clip, joined) => patch.mutate({ clip: clip.id, patch: { joined } }),
    onOpenJoin: (clip) => e.openJoin(clip.id),
    onRecording: (asset, clip) => e.recording.run(asset, clip),
    onSource: (asset) => {
      // the model the windows are made with: that of an empty clip given one that makes a source window by window (the one
      // selected, else the first; the owner picked Swap motion on a new clip, then dropped the source, and got Swap
      // character's windows after it, 2026-10-20), its windows then in its place; else the source's model before; else the swap
      const of = (id: string | null | undefined) => e.videoRecipes.find((r) => r.id === id && windowed(r));
      const empty = (c: Clip) => !c.take && !c.job && Boolean(of(c.recipe));
      const chosen = (e.current && empty(e.current) ? e.current : undefined) ?? e.t.clips.find(empty);
      const model = of(chosen?.recipe) ?? of(e.t.source?.recipe) ?? of("h3.swap");
      if (!model) {
        edit.mutate({ source: { asset } });
        return e.openSource();
      }
      const source = { asset, recipe: model.id, ...(chosen ? { clip: chosen.id } : {}) };
      // a model with a Picture of its own (Motion transfer) waits for it in the source panel; a swap has no source form (the
      // owner, 2026-10-18): dropped, the video is made into its clips at once, nothing rendered, the first opened
      if (model.inputs.some((i) => i.type === "image" && i.role === "source")) {
        edit.mutate({ source });
        return e.openSource();
      }
      edit.mutate({ source }, { onSuccess: () => e.makeSource.run(false) });
    },
    sourceSelected: e.sourceOpen,
    // the source plays on the stage, as ever; once made, the column shows no form of its own but the clip made from it
    // where the playhead stands (else its first), its form every clip's (the owner, 2026-10-18)
    onSelectSource: () => {
      const made = e.place?.made ? madeFromSource(e.t, e.videoRecipes) : [];
      e.openSource();
      if (!made.length) return;
      const at = e.cursor ?? e.clock.get();
      e.setSelected((made.find((c) => at >= c.atMs && at < c.atMs + c.lengthMs) ?? made[0]!).id);
    },
    onOpenSource: e.setOpened,
    onRemoveSource: e.removeSource,
    // before Make its settings; after Make a trim (windows set aside or made anew: useTimelineEditor's stretch)
    onStretchSource: (fromMs, toMs) => e.stretch.run(fromMs, toMs),
    sourcePlace: e.place,
    onPeekSource: (ms) => {
      // the stage turns to the source as soon as it is dragged: its frame there shows as it moves
      if (ms !== null && !e.sourceOpen) e.openSource();
      e.setSourcePeek(ms);
    },
    sourceMode: e.sourceOpen && Boolean(e.place),
    sourceLabel: (() => {
      const r = e.videoRecipes.find((x) => x.id === e.t.source?.recipe);
      return r ? e.recipes.data?.families.find((f) => f.id === r.family)?.name ?? r.title : undefined;
    })(),
    onSplitSource: e.t.source && e.place && !e.place.made
      ? () => {
          const place = e.place!;
          const source = e.t.source!;
          // where the playhead stands on the source: the stage plays it in the track's own time
          const at = (e.sourceOpen ? e.cursor ?? e.clock.get() : e.cursor ?? -1) - place.atMs;
          if (at <= source.fromMs + 200 || at >= source.toMs - 1000) {
            e.setNote("Put the playhead inside the source's stretch (click the source lane: the stage plays it) to split it there.");
            return;
          }
          e.splitSource.mutate(at);
        }
      : undefined,
    onTransition: (clip, transition) => {
      patch.mutate({ clip, patch: { transition } });
      e.openJoin(clip);
    },
    onInsert: (asset, afterId) => add.mutate({ after: afterId, asset }),
    onUpload: (file) =>
      api.upload(file, { folder: t.folderId ?? undefined, project: t.projectId ?? null })
        .then((a) => ({ id: a.id, kind: a.kind }))
        .catch((err: unknown) => {
          e.say(failedBanner({ id: "upload" }, `${file.name} could not be added`, err));
          return null;
        }),
    onPin: (clip, where, asset, atS) => {
      const pins = pinInputs(e.recipes.data?.recipes.find((r) => r.id === clip.recipe));
      const input = pins[where];
      if (!input) return;
      // over the form as it stands when the file lands: a file from the computer is uploaded first, and what was typed
      // over the clip meanwhile stays
      e.editInputs(clip, (was) => ({ ...was, [input]: asset, ...(where === "mid" && pins.midAt && atS ? { [pins.midAt]: atS } : {}) }));
      e.select(clip.id);
    },
    onClipSound: (clip, asset) => patch.mutate({ clip, patch: { soundAsset: asset } }),
    onMusic: (asset) => {
      edit.mutate({ music: { asset } });
      e.setMusicOpen(true);
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

/** A clip made from the timeline's source, as its panel takes it: its Source chapter and where a change goes. */
function clipSourceOf(e: LoadedEditor, current: Clip): ClipSource | undefined {
  const source = e.t.source;
  const made = source ? madeFromSource(e.t, e.videoRecipes) : [];
  if (!source || !made.some((c) => c.id === current.id)) return undefined;
  const w = windowed(e.videoRecipes.find((r) => r.id === current.recipe), source?.inputs);
  const driving = w ? e.videoRecipes.find((r) => r.id === current.recipe)?.inputs.find((i) => i.id === w.driving) : undefined;
  const patchClip = (share: "inLine" | "toAll") => void e.save(current.id).then(() => e.patch.mutate({ clip: current.id, patch: { share } }));
  const recipe = e.videoRecipes.find((r) => r.id === current.recipe);
  const runUp = recipe?.traits?.windows?.runUp;
  const own = recipe?.traits?.windows?.own ?? [];
  const ownOf = (c: Clip) => JSON.stringify(own.map((k) => e.inputsOf(c)[k] ?? null));
  const ask = e.sourceForm.ask;
  return {
    source,
    // every window the source made, in order, as the Source chapter lists them (the mock's "each window's own")
    list: made.map((c) => {
      const inputs = e.inputsOf(c);
      return {
        id: c.id,
        number: e.clips.indexOf(c) + 1,
        startMs: w ? Number(inputs[w.start] ?? 0) * 1000 : 0,
        seconds: w ? Number(inputs[w.seconds] ?? 0) : 0,
        opens: c.joined === "cut",
        carried: recipe ? carriedOf(recipe, inputs) : 0,
        own: c !== made[0] && ownOf(c) !== ownOf(made[0]!),
        rendered: Boolean(c.take),
      };
    }),
    onSelectWindow: e.select,
    runUp: runUp ? { counts: runUp.counts, value: recipe ? carriedOf(recipe, e.inputsOf(current)) : runUp.counts[0]!, on: (n: number) => e.cutSource.run({ inputs: { ...source.inputs, [runUp.input]: String(n) } }) } : null,
    stretchAsk: e.stretch.ask ? { ...e.stretch.ask, change: () => e.stretch.run(e.stretch.ask!.fromMs, e.stretch.ask!.toMs, true), keep: e.stretch.keep } : null,
    onUses: (fromMs, toMs) => e.stretch.run(fromMs, toMs),
    formAsk: ask ? { title: e.videoRecipes.find((r) => r.id === ask.recipe)?.title ?? ask.recipe, rendered: ask.rendered, windows: ask.windows, change: () => e.sourceForm.run(ask.recipe, true), keep: e.sourceForm.keep } : null,
    count: made.length,
    first: made[0]?.id === current.id,
    apart: source.apart?.[current.id] ?? [],
    takesPick: driving?.type === "clip" && Boolean(driving.pick),
    // the window lengths the model takes, on the slider's steps (as the source panel had them)
    windows: (() => {
      const b = w ? windowBounds(w.shape) : { leastMs: 1000, mostMs: 5000 };
      const leastMs = Math.max(1000, Math.ceil(b.leastMs / 100) * 100);
      return { leastMs, mostMs: Math.max(leastMs, Math.floor(b.mostMs / 100) * 100) };
    })(),
    onCut: e.cutSource.run,
    mask: (() => {
      const asked = e.masks[current.id];
      const d = asked ? e.maskOfCurrent.data : undefined;
      const status: "none" | "waiting" | "ready" | "failed" = !asked ? "none" : !d || d.status === "queued" || d.status === "running" ? "waiting" : d.status === "done" && d.video ? "ready" : "failed";
      return { status, error: d?.error ?? null, shown: Boolean(asked?.shown) };
    })(),
    onShowMask: () => {
      // the form as a render sends it, saved first; the stage turns to the source, the clip's panel kept beside it
      const input = e.ready(current).input;
      if (!input) return;
      void e.save(current.id).then(() => api.maskPreview(current.id, input)).then((r) => {
        e.setMasks((m) => ({ ...m, [current.id]: { job: r.job, shown: true } }));
        e.openSource();
        e.setSelected(current.id);
      });
    },
    onMaskShown: (on) => {
      e.setMasks((m) => (m[current.id] ? { ...m, [current.id]: { ...m[current.id]!, shown: on } } : m));
      if (on) {
        e.openSource();
        e.setSelected(current.id);
      }
    },
    cutting: e.cutSource.pending,
    picking: e.whoPicking,
    onPicking: e.setWhoPicking,
    onClearPick: () => e.edit.mutate({ source: { pick: null } }),
    kept: e.keptToClip(current.id),
    onKept: (on) => e.keepToClip(current.id, on),
    onInLine: () => patchClip("inLine"),
    onToAll: () => patchClip("toAll"),
  };
}

export function inspectorProps(e: LoadedEditor, current: Clip): ComponentProps<typeof Inspector> {
  const { t, clips, recipes, render, patch, designed, writeBetween } = e;
  return {
    fromSource: clipSourceOf(e, current),
    onSelectClip: e.select,
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
    // the run-up of a clip the source made (Frames from the clip before, under All settings): the source's, every window
    // carrying on from that many frames, so the source is cut again for it (its rendered clips at the start kept)
    onInputs: (next) => {
      const src = clipSourceOf(e, current);
      const recipe = e.videoRecipes.find((r) => r.id === current.recipe);
      const runUp = recipe?.traits?.windows?.runUp?.input;
      // the count it carries on from, not the value written (the form also sends the 22 it starts on)
      if (src && runUp && carriedOf(recipe, next) !== carriedOf(recipe, e.inputsOf(current))) {
        return e.cutSource.run({ inputs: { ...src.source.inputs, [runUp]: next[runUp] } });
      }
      e.editInputs(current, next);
    },
    // a clip the source made, given another model that makes a source window by window: the source's model, its clips not
    // rendered made anew with it (a clip of another model in the line would no longer share its form)
    // An empty clip given one, on a timeline whose source is made: the source's next window, in that clip's place (cut again
    // from where its rendered clips end)
    onRecipe: (recipe) => {
      const made = windowed(e.videoRecipes.find((r) => r.id === recipe));
      // the source's form, every window with it: on the same grid in place, its takes kept; else made anew, asked first (sourceForm)
      if (made && clipSourceOf(e, current)) return e.sourceForm.run(recipe);
      if (made && e.place?.made && !current.take && !current.job) return e.cutSource.run({ recipe, clip: current.id });
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
    onClose: () => e.setSelected(null),
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
    picked: e.picked,
    rendering: render.isPending || e.fix.isPending,
    onEdit: (p) => e.edit.mutate(p),
    onPick: (id) => e.select(id),
    onMusic: () => e.setMusicOpen(true),
    onCast: () => e.setCasting(true),
    onFix: (f) => e.fix.mutate(f),
    onRenderPicked: () => { render.mutate({ clips: clips.filter(e.renderable) }); e.setPicked(new Set()); },
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
    picked: e.picked,
    removeMany: (ids) => removeMany.mutate(ids),
    toSource: (c) => {
      if (!c.take) return;
      // the source sits so that what the clip plays stays where it is; the clips made from it take its place
      e.edit.mutate({ source: { asset: c.take.asset.id, atMs: c.atMs - c.take.startMs, fromMs: c.take.startMs, toMs: c.take.endMs, clip: c.id } });
      e.openSource();
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
    select: e.select,
    openMusic: () => { e.setSelected(null); e.setMusicOpen(true); },
    showMusic: () => e.setMusicOpen(true),
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
    attention: <AttentionNote timeline={t} clips={clips} {...e.checks} onFixFirst={(plan) => e.fixFirst(plan, () => e.setFin(false))} />,
    onClose: () => e.setFin(false),
    onQueued: (r) => {
      e.after();
      e.setFin(false);
      setNote(`${plural(r.jobs.length, "clip")} finishing in the queue${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, `One job each; the finished takes arrive as they land.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `clip ${x.clip} (${x.why})`).join(", ")}.` : ""}`);
    },
  };
}
