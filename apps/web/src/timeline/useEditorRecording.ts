import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Clip, RecipeInfo, Timeline } from "../api";
import type { layout } from "./model";
import { recordingPlace } from "./recordingPlace";
import { droppedRemovedTakes } from "./removedDropped";
import { clipsOfRecording } from "./track/RecordingBand";
import type { useClipEdits } from "./useClipEdits";
import type { EditorSelection } from "./useEditorPanels";
import type { useOneTrim } from "./useOneTrim";
import type { useTimelineMutations } from "./useTimelineMutations";

/**
 * The timeline's voice recordings in the editor (useTimelineEditor's `recordings`): the one open on the stage and where it
 * plays on the track, and their runs (made into clips, trimmed, cut again, what their clips share given to all), each asked
 * first when it leaves rendered takes behind. The clips they make are sent on through the editor's `toRender`, which the
 * source's runs share.
 */
export function useEditorRecording({ t, clips, slots, videoRecipes, selection, recordingOpenNow, m, save, turn, oneTrim, setToRender, trimmed }: {
  t: Timeline | undefined;
  clips: Clip[];
  slots: ReturnType<typeof layout>;
  videoRecipes: RecipeInfo[];
  selection: EditorSelection;
  /** The recording open as the latest render has it, for what is asked or made after a render of this one. */
  recordingOpenNow: RefObject<string | null>;
  m: ReturnType<typeof useTimelineMutations>;
  save: ReturnType<typeof useClipEdits>["save"];
  turn: ReturnType<typeof useClipEdits>["turn"];
  oneTrim: ReturnType<typeof useOneTrim>;
  setToRender(v: { ids: string[]; render: boolean }): void;
  /** The clips a trim or a cut made anew, sent on (nothing renders). */
  trimmed(clips: string[]): void;
}) {
  const { recordingOpen, setRecordingOpen, select } = selection;
  const { recording: recordingMut, cutRecording: cutRecordingMut, recordingForm: recordingFormMut, trimRecording: trimRecordingMut } = m;
  /** The recording open on the stage: its clips' parts, and where each moment of it plays on the track. */
  const openedRecording = t?.recordings?.find((r) => r.asset.id === recordingOpen) ?? null;
  const recordingAt = useMemo(
    () => (openedRecording ? recordingPlace(slots, videoRecipes, openedRecording.asset.id, openedRecording.asset.durationMs) : null),
    [slots, videoRecipes, openedRecording],
  );
  // the recording open taken off the timeline (an Undo, its clips removed, another tab): the clips' player again
  useEffect(() => {
    if (recordingOpen && t && !recordingAt) setRecordingOpen(null);
  }, [recordingOpen, t, recordingAt, setRecordingOpen]);
  const runs = useRef<{ recordingTrim: typeof recordingTrim; clips: Clip[]; videoRecipes: RecipeInfo[] }>(null!);

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
      const rec = t?.recordings?.find((r) => r.asset.id === asset);
      // with the takes a trim set aside, and those of a part removed before the new In (droppedRemovedTakes)
      const rendered = mine.filter((c) => c.take).length + (rec?.parkedTakes ?? 0) + droppedRemovedTakes(rec?.removed, fromMs, toMs);
      // asked in the first clip's Recording chapter, opened so the question is in view (its band dragged on the Audio row);
      // in the recording's own panel when it is open
      if (!sure && rendered > 0 && Math.abs(fromMs - startMs) > 20) {
        setRecordingAsk({ asset, fromMs, toMs, rendered, clips: mine.length });
        if (recordingOpenNow.current !== asset) select(mine[0]!.id);
        return Promise.resolve(false);
      }
      setRecordingAsk(null);
      return oneTrim.run(trimRecordingMut.mutate, { asset, fromMs, toMs }, trimmed);
    },
    keep: () => setRecordingAsk(null),
  };
  runs.current = { recordingTrim, clips, videoRecipes };

  /**
   * A recording's clips cut again from its panel (Clip length ± its window): asked first when that leaves rendered takes
   * behind (`ask`: Change or Keep), as its moved start is. What was typed in its clips is saved first: they are made anew
   * with their forms as the server has them.
   */
  const [cutAsk, setCutAsk] = useState<{ asset: string; seconds: number; within: number; rendered: number; clips: number } | null>(null);
  // under way from the click on, not from the cut's request: while what was typed is saved first, a window typed sent a
  // second cut with the Clip length from before the first
  const [cutting, setCutting] = useState(false);
  const recordingCut = {
    pending: cutting || cutRecordingMut.isPending,
    ask: cutAsk,
    run: (asset: string, seconds: number, within: number, sure = false) => {
      const mine = clipsOfRecording(clips, videoRecipes, asset);
      const rec = t?.recordings?.find((r) => r.asset.id === asset);
      // cut again over the stretch its clips use: a part removed past the last one (kept with a clip a trim set aside) goes
      const last = mine.at(-1);
      const fromMs = Number(mine[0]?.inputs.recordingStart ?? 0) * 1000;
      const toMs = last ? (Number(last.inputs.recordingStart ?? 0) + Number(last.inputs.recordingSeconds ?? 0)) * 1000 : fromMs;
      const rendered = mine.filter((c) => c.take).length + (rec?.parkedTakes ?? 0) + droppedRemovedTakes(rec?.removed, fromMs, toMs);
      if (!sure && rendered > 0) return setCutAsk({ asset, seconds, within, rendered, clips: mine.length });
      setCutAsk(null);
      setCutting(true);
      // a failure is the mutation's own, said with the editor's others (latestFailure); a save that failed is said by the autosave
      void save()
        .then(() => cutRecordingMut.mutateAsync({ asset, seconds, window: within }).then((r) => trimmed(r.clips)))
        .catch(() => {})
        .finally(() => setCutting(false));
    },
    keep: () => setCutAsk(null),
  };
  /**
   * What a recording's clips share given to all of them (its panel), after what was typed in them is saved: under way from
   * that save on, for its fields to keep what was typed until it is in the clips' forms. Counted: with two shares out, the
   * first one's end is not the end of sharing, the second's field would else be reset to the first one's text.
   */
  const [sharing, setSharing] = useState(0);
  const recordingShared = {
    pending: sharing > 0 || recordingFormMut.isPending,
    run: (asset: string, inputs: Record<string, unknown>) => {
      setSharing((n) => n + 1);
      // a failure is the mutation's own, said with the editor's others (latestFailure)
      // in the forms' turn: a clip's save sent while the share is out went before it on the server's side and after it
      // here, and wrote the old shared text back; waiting its turn, it goes with the share laid over it (savedElsewhere)
      void save().then(() => turn(() => recordingFormMut.mutateAsync({ asset, inputs }))).catch(() => {}).finally(() => setSharing((n) => n - 1));
    },
  };

  /** A voice recording made into Lip sync clips, the first one opened (nothing renders: its scene is to be written first). */
  const recording = {
    pending: recordingMut.isPending,
    run: (asset: string, clip?: string) => recordingMut.mutate({ asset, clip }, { onSuccess: (r) => setToRender({ ids: r.clips, render: false }) }),
  };
  return { recordingAt, recordingTrim, recordingCut, recordingShared, recording };
}
