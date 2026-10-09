import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Clip, type Timeline } from "../api";
import type { useModelSettings, useRecipes, useSetup } from "../data";
import { formDefaults } from "../form";
import { notReady } from "../format";

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
  // ---- the clips' forms: shown at once, saved half a second after the last change. A save that fails
  // keeps the form in `unsaved`, says so in the header, and is sent again by the next save or by Retry
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const unsaved = useRef(new Map<string, Record<string, unknown>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const save = useCallback(async (only?: string) => {
    const ids = only ? [only] : [...unsaved.current.keys()];
    let failed: string | null = null;
    await Promise.all(
      ids.map(async (clipId) => {
        const inputs = unsaved.current.get(clipId);
        clearTimeout(timers.current.get(clipId));
        timers.current.delete(clipId);
        if (!inputs) return;
        try {
          await api.editClip(clipId, { inputs });
          // what was sent is saved; a change typed meanwhile is still waiting
          if (unsaved.current.get(clipId) === inputs) unsaved.current.delete(clipId);
        } catch (err) {
          failed = (err as Error).message;
        }
      }),
    );
    setSaveFailed(failed);
  }, []);
  useEffect(() => () => void save(), [save]);
  const inputsOf = useCallback((c: Clip) => edits[c.id] ?? c.inputs, [edits]);
  // what was typed stays over the clip until the timeline read back carries it (or the clip is gone)
  useEffect(() => {
    if (!t) return;
    setEdits((e) => {
      const next = { ...e };
      for (const id of Object.keys(e)) {
        if (unsaved.current.has(id)) continue;
        const c = t.clips.find((x) => x.id === id);
        if (!c || JSON.stringify(c.inputs) === JSON.stringify(e[id])) delete next[id];
      }
      return Object.keys(next).length === Object.keys(e).length ? e : next;
    });
  }, [t]);
  const editInputs = (c: Clip, next: Record<string, unknown>) => {
    setEdits((e) => ({ ...e, [c.id]: next }));
    unsaved.current.set(c.id, next);
    clearTimeout(timers.current.get(c.id));
    timers.current.set(c.id, setTimeout(() => void save(c.id), 500));
  };
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
      const input: Record<string, unknown> = { ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored };
      for (const i of recipe.inputs) if (input[i.id] === undefined || i.type === "clip") delete input[i.id];
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
    }),
    [recipes.data, setup.data, setup.isSuccess, comfyOnline, inputsOf, settings.data, clips],
  );

  return { edits, dropEdits, saveFailed, save, inputsOf, editInputs, shown, formOf, ready };
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
