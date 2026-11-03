import type { ComponentProps } from "react";
import type { Clip, RecipeInfo } from "../api";
import { CUT_WINDOW } from "@afflatus/core";
import type { Track } from "./Track";
import type { LoadedEditor } from "./useTimelineEditor";
import type { ClipRecording } from "./inspector/clipRecording";
import type { RecordingPanelProps } from "./inspector/recording";
import { clipsOfRecording, playsOver, recordingInput } from "./track/RecordingBand";
import { stageEnd } from "./recordingPlace";
import { recordingFormOptions, recordingForms } from "./recordingForms";

// What the parts of the editor that show a voice recording are drawn with (useEditorRecording's `recordings`): its band
// on the track, a clip's Recording chapter, and the recording's own panel. editorProps.tsx hands them over with the rest.

/** Where what the stage plays in place of the clips ends on the track (stageEnd); null when it plays the clips. */
export const stageEndOf = (e: LoadedEditor) => stageEnd(e.selection.sourceOpen, e.sourceLane.place, e.recordings.recordingAt);

/** A recording's part of the track: its band clicked, dragged, the clips made from it, the stretch the stage shows. */
export function trackRecordingProps(e: LoadedEditor): Pick<ComponentProps<typeof Track>, "onRecording" | "onRecordingTrim" | "recordingOpen" | "stageEndMs" | "onView" | "onOpenRecording"> {
  return {
    onRecording: (asset, clip) => e.recordings.recording.run(asset, clip),
    // its band on the Audio row dragged: trimmed as its Recording chapter's In and Out trim it
    onRecordingTrim: (asset, fromMs, toMs) => e.recordings.recordingTrim.run(asset, clipsOfRecording(e.clips, e.videoRecipes, asset), fromMs, toMs),
    // its band clicked: the recording on the stage and in the column, as the source lane opens
    recordingOpen: e.selection.recordingOpen,
    stageEndMs: e.recordings.recordingAt ? stageEndOf(e) : null,
    onView: e.recordings.recordingAt ? e.trackView.set : undefined,
    onOpenRecording: (asset, atMs) => e.openRecordingAt(asset, atMs),
  };
}

/**
 * A clip under a recording (its form's recording, part by part), whatever its form, as its panel takes it: the Recording
 * chapter, the recording's stretch over all its clips. Undefined for any other clip.
 */
export function clipRecordingOf(e: LoadedEditor, current: Clip): ClipRecording | undefined {
  const w = recordingInput(e.videoRecipes.find((r) => r.id === current.recipe));
  if (!w) return undefined;
  const asset = current.inputs[w.id];
  if (typeof asset !== "string" || !asset) return undefined;
  // as shown, with what is typed and not read back yet (the band reads them so): a voice just given, its part worked out.
  // Every clip under it, whatever its form (card #72): Lip sync and those it plays over make one stretch
  const mine = clipsOfRecording(e.shown.clips, e.videoRecipes, asset);
  const at = (c: Clip) => Math.round(Number(c.inputs[w.start] ?? 0) * 1000);
  const end = (c: Clip) => at(c) + Math.round(Number(c.inputs[w.seconds] ?? 0) * 1000);
  const ask = e.recordings.recordingTrim.ask?.asset === asset ? e.recordings.recordingTrim.ask : null;
  return {
    count: mine.length,
    over: playsOver(current, e.videoRecipes),
    part: { startMs: at(current), seconds: Number(current.inputs[w.seconds] ?? 0) },
    fromMs: mine.length ? at(mine[0]!) : 0,
    toMs: mine.length ? end(mine.at(-1)!) : 0,
    onUses: (fromMs, toMs) => e.recordings.recordingTrim.run(asset, mine, fromMs, toMs),
    ask: ask ? { fromMs: ask.fromMs, rendered: ask.rendered, clips: ask.clips, change: () => e.recordings.recordingTrim.run(asset, mine, ask.fromMs, ask.toMs, true), keep: e.recordings.recordingTrim.keep } : null,
    trimming: e.recordings.recordingTrim.pending || e.recordings.recordingTrim.waits(asset),
  };
}

/**
 * The recording open in the column, as its panel takes it (inspector/recording.tsx): the edits go through the paths the
 * band and a clip's Recording chapter use (the recording trim), the cut and the shared settings through their own, its
 * first clip's join through the clip's patch, its clips with nothing to play rendered as Render all renders them.
 */
export function recordingPanelProps(e: LoadedEditor, place: NonNullable<LoadedEditor["recordings"]["recordingAt"]>): RecordingPanelProps | null {
  const recording = e.t.recordings?.find((r) => r.asset.id === e.selection.recordingOpen);
  const first = place.parts[0]!.clip;
  const recipe = e.videoRecipes.find((r) => r.id === first.recipe);
  const input = recordingInput(recipe);
  if (!recording || !recipe || !input) return null;
  const asset = recording.asset.id;
  const mine = place.parts.map((p) => p.clip);
  const ids = new Set(mine.map((c) => c.id));
  const left = e.missing.filter((c) => ids.has(c.id));
  const trimAsk = e.recordings.recordingTrim.ask?.asset === asset ? e.recordings.recordingTrim.ask : null;
  const cutAsk = e.recordings.recordingCut.ask?.asset === asset ? e.recordings.recordingCut.ask : null;
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
    onUses: (fromMs, toMs) => void e.recordings.recordingTrim.run(asset, mine, fromMs, toMs),
    trimAsk: trimAsk ? { fromMs: trimAsk.fromMs, rendered: trimAsk.rendered, clips: trimAsk.clips, change: () => void e.recordings.recordingTrim.run(asset, mine, trimAsk.fromMs, trimAsk.toMs, true), keep: e.recordings.recordingTrim.keep } : null,
    trimming: e.recordings.recordingTrim.pending || e.recordings.recordingTrim.waits(asset),
    cut: {
      seconds,
      within,
      leastMs: input.leastMs,
      mostMs: input.mostMs,
      stepMs: recipe.traits?.frameGrid && recipe.traits.fps ? (recipe.traits.frameGrid.step * 1000) / recipe.traits.fps : null,
      run: (s, w) => e.recordings.recordingCut.run(asset, s, w),
      ask: cutAsk ? { rendered: cutAsk.rendered, clips: cutAsk.clips, change: () => e.recordings.recordingCut.run(asset, cutAsk.seconds, cutAsk.within, true), keep: e.recordings.recordingCut.keep } : null,
      pending: e.recordings.recordingCut.pending,
    },
    onSelectClip: (id) => e.selection.select(id),
    opens: { before: at > 0 ? at : null, joined: first.joined, onJoined: (joined) => e.patch.mutate({ clip: first.id, patch: { joined } }) },
    shared,
    onShared: (inputs) => e.recordings.recordingShared.run(asset, inputs),
    sharing: e.recordings.recordingShared.pending,
    render: (() => {
      // with nothing to play and not sent: those that cannot render yet are said, with the first one's reason
      const waiting = mine.filter((c) => !c.take && !c.job && !left.includes(c));
      return { left: left.length, queued: mine.filter((c) => c.job).length, waiting: waiting.length, why: left.length ? null : (waiting.map((c) => e.ready(c).why).find(Boolean) ?? null), run: () => e.render.mutate({ clips: left }), rendering: e.render.isPending };
    })(),
  };
}
