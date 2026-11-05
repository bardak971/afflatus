import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { sameWindowGrid } from "@afflatus/core";
import type { RecipeInfo, Timeline } from "../api";
import { useMaskPreview, type ClipMask } from "./maskPreview";
import type { layout } from "./model";
import { droppedRemovedTakes } from "./removedDropped";
import { useSourceMarks } from "./sourceMarks";
import { madeFromSource, sourcePlace } from "./track/SourceLane";
import type { useClipEdits } from "./useClipEdits";
import type { EditorSelection } from "./useEditorPanels";
import type { useOneTrim } from "./useOneTrim";
import type { useTimelineMutations } from "./useTimelineMutations";

/** A change to the source that cuts it again (its window, scene cuts, run-up, or a window's form): useEditorSource's cutSource. */
type SourceCut = { windowMs?: number; withinMs?: number; inputs?: Record<string, unknown>; recipe?: string; clip?: string };

/**
 * The timeline's source in the editor (useTimelineEditor's `sourceLane`): where it lies on the track, the moment a drag on
 * its lane shows, the person a swap replaces being picked, each swap clip's mask, and its runs (made into clips, cut again,
 * given another form, its stretch trimmed, taken away), each asked first when it leaves rendered takes behind. The clips
 * they make are sent on through `toRender`, the editor's, which a recording's runs share.
 */
export function useEditorSource({ t, slots, videoRecipes, selection, m, save, oneTrim, toRender, setToRender, trimmed }: {
  t: Timeline | undefined;
  slots: ReturnType<typeof layout>;
  videoRecipes: RecipeInfo[];
  selection: EditorSelection;
  m: ReturnType<typeof useTimelineMutations>;
  save: ReturnType<typeof useClipEdits>["save"];
  oneTrim: ReturnType<typeof useOneTrim>;
  toRender: unknown;
  setToRender(v: { ids: string[]; render: boolean }): void;
  /** The clips a trim made anew, sent on as the clips a cut makes are (nothing renders). */
  trimmed(clips: string[]): void;
}) {
  const { sourceOpen, setSourceOpen, select, current } = selection;
  const { readBack, edit, makeSource: makeSourceMut, cutSource: cutSourceMut, sourceForm: sourceFormMut, trimSource: trimSourceMut } = m;
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
  // the selected clip's Show the mask, followed until its video is made (the stage draws it over the source)
  const maskOfCurrent = useMaskPreview(current?.id, current ? masks[current.id]?.job : undefined);
  /** Where the source lies on the track (the track's own time), the clips Make will add, whether they are made. */
  const sourceMarks = useSourceMarks(t?.source);
  const place = useMemo(() => (t ? sourcePlace(t, slots, videoRecipes, sourceMarks) : null), [t, slots, videoRecipes, sourceMarks]);
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
  /** The source's stretch made into clips, sent to render in order (each waits for the one it carries on from). */
  const makeSource = {
    pending: makeSourceMut.isPending || Boolean(toRender),
    run: (andRender = true) => makeSourceMut.mutate(undefined, { onSuccess: (r) => setToRender({ ids: r.clips, render: andRender }) }),
  };
  /**
   * The source's clip length, its ± or run-up changed (a swap clip's Source chapter): the change saved, then the source cut again,
   * its rendered clips at the start kept and the first new one opened. Nothing renders. What is set aside past its end goes
   * (the windows a trim set aside, a part removed kept with one of them: droppedRemovedTakes): asked first when that holds
   * rendered takes (`ask`: Change or Keep, card #114).
   */
  const [cutSourceAsk, setCutSourceAsk] = useState<{ change: SourceCut; rendered: number } | null>(null);
  const cutSource = {
    pending: edit.isPending || cutSourceMut.isPending,
    ask: cutSourceAsk,
    // what was typed over the windows and the source's form saved first: the windows not rendered are made anew from what
    // the server has, and a save still waiting would go to a window no longer there
    run: (change: SourceCut, sure = false) => {
      // asked only when it is cut again: not when every window is rendered or in the queue, nor with a rendered one after
      // one that is not (the server refuses both, and keeps what is set aside), unless an empty clip is cut for
      const free = (t ? madeFromSource(t, videoRecipes) : []).map((c) => !c.take && !c.job);
      const cuts = Boolean(t?.source?.clip) || (free.includes(true) && free.slice(free.indexOf(true)).every(Boolean));
      const lost = t?.source && cuts ? (t.source.parkedTakes ?? 0) + droppedRemovedTakes(t.source.removed, t.source.fromMs, t.source.toMs) : 0;
      if (!sure && lost > 0) return setCutSourceAsk({ change, rendered: lost });
      setCutSourceAsk(null);
      void save().then(() => edit.mutate({ source: change }, { onSuccess: () => cutSourceMut.mutate(undefined, { onSuccess: (r) => setToRender({ ids: r.clips, render: false }) }) }));
    },
    keep: () => setCutSourceAsk(null),
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
      // made anew on another grid, the windows a trim set aside go too, and every part removed is made anew with the new
      // model (still removed): their takes go
      const rendered = made.filter((c) => c.take).length + (t?.source ? (t.source.parkedTakes ?? 0) + (t.source.removed ?? []).reduce((n, p) => n + p.takes, 0) : 0);
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
  /** The stretch's run as the latest render has it: a trim waiting for the one on its way is run from the timeline read back. */
  const stretchNow = useRef<typeof stretch>(null!);
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
      if (oneTrim.busy) return oneTrim.later("source", () => stretchNow.current.run(fromMs, toMs, sure));
      // the rendered windows a trim set aside are left behind too, and those of a part removed before the new In: counted
      // with those on the track (a part removed after it stays removed, its takes kept: droppedRemovedTakes)
      const rendered = made.filter((c) => c.take).length + (t.source.parkedTakes ?? 0) + droppedRemovedTakes(t.source.removed, fromMs, toMs);
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
  stretchNow.current = stretch;
  return { place, sourceMarks, sourcePeek, setSourcePeek, masks, setMasks, maskOfCurrent, whoPicking, setWhoPicking, removeSource, makeSource, cutSource, sourceForm, stretch };
}
