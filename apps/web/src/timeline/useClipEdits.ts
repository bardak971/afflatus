import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, raw, type Clip, type Timeline } from "../api";
import { KEEPALIVE_MAX, useKeyedAutosave } from "../autosave";
import type { useModelSettings, useRecipes, useSetup } from "../data";
import { wholeForm } from "../form";
import { notReady } from "../format";
import { queryKeys } from "../queryKeys";

/**
 * The key the source lane's form is kept under among the clips' forms: saved as they are (after the last change, as the
 * editor is left, as the tab closes, before Undo), not by its panel, which closing within a moment of typing lost it.
 */
export const sourceKey = (timelineId: string) => `source:${timelineId}`;
/** The timeline whose source form a key is, or null for a clip's. */
const sourceOf = (key: string) => (key.startsWith("source:") ? key.slice("source:".length) : null);

/**
 * The clips' forms as the editor holds them: what was typed over each clip, its saving, and what a clip's
 * whole form comes to (ready to render, or why not).
 */
export function useClipEdits({ timeline: t, clips, recipes, setup, settings, comfyOnline }: {
  timeline: Timeline | undefined;
  clips: Clip[];
  recipes: ReturnType<typeof useRecipes>;
  setup: ReturnType<typeof useSetup>;
  /** The models' own settings, folded into every form's defaults. */
  settings: ReturnType<typeof useModelSettings>;
  comfyOnline: boolean;
}) {
  // ---- the clips' forms: shown at once, saved half a second after the last change, one save at a time, and as the tab
  // closes by a request that outlives the page (autosave.ts, as drafts are). A save that fails keeps the form pending,
  // says so in the header, is sent again by the next save or by Retry, and the browser asks before the tab closes
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  // the clips of a source whose changes are kept to them ("This clip"), read as each save goes: a clip left out shares
  // what changes in it with the source's other clips (the server's sameForm)
  const [own, setOwn] = useState<ReadonlySet<string>>(() => new Set());
  const ownRef = useRef(own);
  ownRef.current = own;
  const shareOf = (key: string) => (ownRef.current.has(key) ? { share: "apart" as const } : {});
  const client = useQueryClient();
  const autosave = useKeyedAutosave<Record<string, unknown>>({
    save: async (key, inputs) => {
      const source = sourceOf(key);
      if (!source) return void (await api.editClip(key, { inputs, ...shareOf(key) }));
      await api.editTimeline(source, { source: { inputs } });
      // read again for its Undo; the source panel keeps what is typed over what is read until it is saved
      void client.invalidateQueries({ queryKey: queryKeys.timelines.all() });
    },
    keepalive: (key, inputs) => {
      const source = sourceOf(key);
      void raw("PATCH", source ? `/timelines/${source}` : `/clips/${key}`, source ? { source: { inputs } } : { inputs, ...shareOf(key) }, { keepalive: true }).catch(() => {});
    },
    goesWhole: (_, inputs) => JSON.stringify({ inputs }).length <= KEEPALIVE_MAX,
    gone: clipGone,
  });
  const { pending: unsaved, flush, queue, turn } = autosave;
  const saveFailed = autosave.state === "failed" ? autosave.failure : null;
  /** What was typed over one clip (over all of them when left out) is saved now, after any save already out. */
  const save = useCallback((only?: string) => flush(only), [flush]);
  const inputsOf = useCallback((c: Clip) => edits[c.id] ?? c.inputs, [edits]);
  // what was typed stays over the clip until the timeline read back carries it (or the clip is gone)
  useEffect(() => {
    if (!t) return;
    setEdits((e) => settleEdits(e, t.clips, unsaved));
  }, [t, unsaved]);
  /**
   * The server was given a clip's inputs by another way than the form's save (a render moving the seed on): the edit over
   * the clip becomes them, so that the read back that carries them drops it. Left as it was, it no longer matched what the
   * server has, and stayed over the clip all session: the old seed shown and sent with every render after.
   */
  const savedElsewhere = useCallback((clipId: string, inputs: Record<string, unknown>) => {
    setEdits((e) => withServerInputs(e, clipId, inputs, unsaved));
  }, [unsaved]);
  // the forms and the clips as they stand now: a change that lands after an await (a file uploaded onto a pin, a loop's
  // frame saved) is made over the form as it is then, not over the one it began with, which put back what was typed meanwhile
  const latest = useRef({ edits, clips });
  latest.current = { edits, clips };
  /** A clip's form changed: to these inputs, or to what `next` makes of its inputs as they stand at this moment. */
  const editInputs = (c: Clip, next: Record<string, unknown> | ((was: Record<string, unknown>) => Record<string, unknown>)) => {
    const was = latest.current.edits[c.id] ?? latest.current.clips.find((x) => x.id === c.id)?.inputs ?? c.inputs;
    const value = typeof next === "function" ? next(was) : next;
    latest.current.edits = { ...latest.current.edits, [c.id]: value };
    setEdits((e) => ({ ...e, [c.id]: value }));
    queue(c.id, value);
  };
  /** The source lane's form typed (its panel's), saved as a clip's form is. */
  const typeSource = useCallback((timelineId: string, inputs: Record<string, unknown>) => queue(sourceKey(timelineId), inputs), [queue]);
  /** The source lane's form as typed and not saved yet (on its way, or failed), or undefined when the server has it. */
  const sourceTyped = useCallback((timelineId: string) => unsaved.get(sourceKey(timelineId)), [unsaved]);
  /** Whether a clip's changes are kept to it ("This clip") or go to every clip of its source; what is typed is saved first, under the choice it was typed with. */
  const keptToClip = useCallback((clipId: string) => own.has(clipId), [own]);
  const keepToClip = useCallback((clipId: string, on: boolean) => {
    void flush(clipId).finally(() => setOwn((x) => {
      const next = new Set(x);
      if (on) next.add(clipId); else next.delete(clipId);
      return next;
    }));
  }, [flush]);
  /** Every edit dropped: what the server has now is what counts (after an undo or a redo, which saved first). */
  const dropEdits = () => setEdits({});
  /** The timeline as it is on screen: with what was typed and is not saved yet. */
  const shown = useMemo(() => (t ? { ...t, clips: clips.map((c) => (edits[c.id] ? { ...c, inputs: edits[c.id]! } : c)) } : undefined), [t, clips, edits]);

  /** The whole form of a clip as a render would send it, whether it is ready to render or not (its models are told from it). */
  const formOf = useMemo(
    () => once((c: Clip): Record<string, unknown> | null => {
      const recipe = c.kind === "still" ? undefined : recipes.data?.recipes.find((r) => r.id === c.recipe);
      if (!recipe) return null;
      const status = setup.data?.recipes.find((r) => r.id === recipe.id);
      if (setup.isSuccess && notReady(status, comfyOnline)) return null;
      const stored = inputsOf(c);
      const input = wholeForm(recipe, status, settings.data?.items ?? [], stored);
      for (const i of recipe.inputs) if (input[i.id] === undefined || (i.type === "clip" && i.role !== "source")) delete input[i.id];
      return input;
    }),
    [recipes.data, setup.data, setup.isSuccess, comfyOnline, inputsOf, settings.data],
  );

  /** The whole form of a clip as it would be sent, or why it cannot be rendered yet. */
  const ready = useMemo(
    () => once((c: Clip): { input?: Record<string, unknown>; why?: string } => {
      if (c.kind === "still") return { why: "A still is not rendered." };
      const recipe = recipes.data?.recipes.find((r) => r.id === c.recipe);
      if (!recipe) return { why: c.recipe ? "The model this clip was generated with is no longer here. Choose another one." : "Choose a model for this clip." };
      const status = setup.data?.recipes.find((r) => r.id === recipe.id);
      const blocked = setup.isSuccess ? notReady(status, comfyOnline) : null;
      if (blocked) return { why: blocked };
      const stored = inputsOf(c);
      const input = wholeForm(recipe, status, settings.data?.items ?? [], stored);
      for (const i of recipe.inputs) if (input[i.id] === undefined || (i.type === "clip" && i.role !== "source")) delete input[i.id];
      const at = clips.findIndex((x) => x.id === c.id);
      const before = at > 0 ? clips[at - 1] : undefined;
      const carries = Boolean(before) && c.joined === "continue";
      for (const i of recipe.inputs) {
        if (i.type === "prompt" && ((!i.optional && i.default === undefined) || i.example) && !String(input[i.id] ?? "").trim()) return { why: `Write ${i.label.toLowerCase()} first.` };
        // a clip that picks up from the last frame of the one before, or opens on the picture before it, needs no opening picture of its own
        const given = carries && i.type === "image" && i.role === "start" && (recipe.traits?.continues === "frame" || before?.kind === "still");
        if (i.type === "image" && !i.optional && !input[i.id] && !given) return { why: `Choose the ${i.label.toLowerCase()} first.` };
        // a source video (Motion transfer's driving video) comes from the timeline's source lane
        if (i.type === "clip" && i.role === "source" && !i.optional && !input[i.id]) return { why: `It has no ${i.label.toLowerCase()}: drop one on the Source lane under the track.` };
      }
      return { input };
    }),
    [recipes.data, setup.data, setup.isSuccess, comfyOnline, inputsOf, settings.data, clips],
  );

  return { edits, dropEdits, saveFailed, save, turn, inputsOf, editInputs, savedElsewhere, typeSource, sourceTyped, shown, formOf, ready, keptToClip, keepToClip };
}

/** A clip's save answered 404: the clip was removed (here, by Undo, in another tab), and its form has nowhere to go. */
export const clipGone = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/** The edits left once the server's clips are read back: a saved edit the server carries is dropped, as is one whose clip is gone. */
export function settleEdits(edits: Record<string, Record<string, unknown>>, clips: Array<Pick<Clip, "id" | "inputs">>, unsaved: { has(id: string): boolean }): Record<string, Record<string, unknown>> {
  const next = { ...edits };
  for (const id of Object.keys(edits)) {
    if (unsaved.has(id)) continue;
    const c = clips.find((x) => x.id === id);
    if (!c || JSON.stringify(c.inputs) === JSON.stringify(edits[id])) delete next[id];
  }
  return Object.keys(next).length === Object.keys(edits).length ? edits : next;
}

/**
 * The edits once the server was given a clip's inputs by another way than the form's save: a saved edit over that clip
 * becomes them. One typed since and not saved yet is the newer: it stays, and its save sends it.
 */
export function withServerInputs(edits: Record<string, Record<string, unknown>>, clipId: string, inputs: Record<string, unknown>, unsaved: { has(id: string): boolean }): Record<string, Record<string, unknown>> {
  if (!edits[clipId] || unsaved.has(clipId)) return edits;
  return { ...edits, [clipId]: inputs };
}

/**
 * A clip's answer worked out once for each state of the forms (a new one each time what it depends on changes): the
 * track, the header, the overview and the inspector all ask it, several times a draw.
 */
function once<T>(of: (c: Clip) => T): (c: Clip) => T {
  const seen = new WeakMap<Clip, T>();
  return (c) => {
    if (seen.has(c)) return seen.get(c)!;
    const v = of(c);
    seen.set(c, v);
    return v;
  };
}
