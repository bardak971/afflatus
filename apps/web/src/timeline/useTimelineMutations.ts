import { useCallback, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type Clip, type RecipeInfo, type Timeline, type TimelinePatch } from "../api";
import { movingSeed, seedAfter, useSeedMode } from "../seedMode";
import type { Fix } from "./attention";
import type { ExportOptions } from "./ExportDialog";
import { pinInputs, type ShownPatch } from "./model";
import type { useClipEdits } from "./useClipEdits";

/** A new clip as the server takes it; `stopAtMs`: the clip it goes after stops being seen there first, in the same step. */
type NewClip = Parameters<typeof api.addClip>[1];

/**
 * What the timeline editor does to its timeline, as mutations: each reads the timeline and the queue again when it is done.
 * Undo and Redo save what was typed first; a render sends each clip's whole form.
 */
export function useTimelineMutations(id: string, o: {
  timeline: Timeline | undefined;
  /** The clips as they are on screen now (read when a designer's reply comes back). */
  clipsNow: RefObject<Clip[]>;
  recipes: RecipeInfo[];
  edits: Pick<ReturnType<typeof useClipEdits>, "save" | "ready" | "inputsOf" | "editInputs" | "dropEdits">;
  /** The model a first clip is given. */
  firstRecipe(): string | undefined;
  on: {
    /** A line in the header, and what more there is to it (behind its "?"). */
    note(text: string, more?: string): void;
    /** A clip selected (its panel open in place of the music's), or none. */
    select(clip: string | null): void;
    /** The clips picked with Ctrl + click, dropped. */
    unpick(): void;
    /** The clip the designer is writing for, or none. */
    writing(clip: string | null): void;
    /** The viewer, on this item (a frame just saved). */
    open(asset: Asset): void;
  };
}) {
  const { save, ready, inputsOf, editInputs, dropEdits } = o.edits;
  const client = useQueryClient();
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ["timelines"] }), [client]);
  const after = () => {
    void refresh();
    void client.invalidateQueries({ queryKey: ["queue"] });
  };
  const render = useMutation({
    mutationFn: async (v: { clips: Clip[]; takes?: number }) => {
      await save();
      // a seed meant to move: the takes go out with the next seeds in a row, and the clip's form shows the one after them
      const mode = useSeedMode.getState().mode;
      const sent = v.clips.map((c) => ({ clip: c, input: ready(c).input ?? {} })).map((x) => ({ ...x, seedMode: movingSeed(x.input.seed, mode) }));
      const made = await api.renderClips(id, sent.map(({ clip, input, seedMode }) => ({ id: clip.id, input, ...(v.takes && v.takes > 1 ? { takes: v.takes } : {}), ...(seedMode ? { seedMode } : {}) })));
      for (const x of sent) if (x.seedMode) await api.editClip(x.clip.id, { inputs: { ...inputsOf(x.clip), seed: seedAfter(x.input.seed as number, mode, v.takes ?? 1) } });
      return made;
    },
    onSuccess: after,
  });
  const patch = useMutation({ mutationFn: (v: { clip: string; patch: ShownPatch }) => api.editClip(v.clip, v.patch), onSuccess: after });
  // what Needs attention mends: the patches one after the other (each its own Undo step), then one render of the clips left
  const fix = useMutation({
    mutationFn: async (v: Omit<Fix, "ms">) => {
      for (const p of v.patches) await api.editClip(p.clip, p.patch);
      const clips = (o.clipsNow.current ?? []).filter((c) => v.render.includes(c.id));
      if (clips.length) await render.mutateAsync({ clips });
    },
    onSuccess: after,
  });
  const edit = useMutation({ mutationFn: (p: TimelinePatch) => api.editTimeline(id, p), onSuccess: after });
  const add = useMutation({
    mutationFn: (v: NewClip) => api.addClip(id, v),
    onSuccess: (r) => {
      client.setQueryData(["timelines", id], r.timeline);
      o.on.select(r.clip);
      after();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteClip, onSuccess: after });
  // the clips picked with Ctrl + click, removed one after the other (each comes back with Undo)
  const removeMany = useMutation({ mutationFn: async (ids: string[]) => { for (const id of ids) await api.deleteClip(id); }, onSuccess: () => { o.on.unpick(); after(); } });
  const split = useMutation({ mutationFn: (v: { clip: string; atMs: number }) => api.splitClip(v.clip, v.atMs), onSuccess: after });
  // the designer writing a clip put between two others: its texts go into the form unless something was typed there meanwhile
  const writeBetween = useMutation({
    mutationFn: async (v: { clip: string; force: boolean; arrive?: string }) => {
      o.on.writing(v.clip);
      return { ...(await api.writeBetween(v.clip, v.arrive)), ...v };
    },
    onSuccess: (r) => {
      const c = o.clipsNow.current?.find((x) => x.id === r.clip);
      if (!c) return;
      const current = inputsOf(c);
      const kept = Object.fromEntries(Object.entries(r.changes).filter(([k]) => r.force || String(current[k] ?? "") === String(r.was[k] ?? "")));
      if (Object.keys(kept).length) editInputs(c, { ...current, ...kept });
      if (r.note) o.on.note("The designer left a note", r.note);
    },
    onSettled: () => o.on.writing(null),
  });
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
      dropEdits();
      o.on.note(`Undone: ${r.undone}.`);
      after();
    },
  });
  const redo = useMutation({
    mutationFn: async () => {
      await save();
      return api.redoTimeline(id);
    },
    onSuccess: (r) => {
      dropEdits();
      o.on.note(`Redone: ${r.redone}.`);
      after();
    },
  });
  const duplicate = useMutation({ mutationFn: api.duplicateClip, onSuccess: (r) => { after(); o.on.select(r.clip); } });
  const exportIt = useMutation({ mutationFn: (v: ExportOptions) => api.exportTimeline(id, v), onSuccess: after });
  const frame = useMutation({ mutationFn: (v: { asset: string; at: number }) => api.frame(v.asset, v.at, id), onSuccess: (a) => o.on.open(a) });
  /**
   * A loop ends where the clip begins: on its opening picture when it has one, else on the first frame
   * that plays of its take (saved as a picture, and pinned as the opening picture too unless the clip
   * flows on from the one before).
   */
  const loop = useMutation({
    mutationFn: async (c: Clip) => {
      const pins = pinInputs(o.recipes.find((r) => r.id === c.recipe));
      if (!pins.end) return;
      const stored = inputsOf(c);
      const flows = (o.clipsNow.current?.indexOf(c) ?? 0) > 0 && c.joined === "continue";
      const opening = !flows && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
      if (opening) return editInputs(c, { ...stored, [pins.end]: opening });
      if (!c.take) return;
      const first = await api.frame(c.take.asset.id, c.take.startMs + 20, id);
      editInputs(c, { ...stored, ...(pins.start && !flows ? { [pins.start]: first.id } : {}), [pins.end]: first.id });
      o.on.note("It will loop from the next take: it now ends on its own first frame.");
    },
  });
  /** A scene in a few words, written as clips by the designer and put on the timeline. Nothing is rendered. */
  const plan = useMutation({
    mutationFn: async (v: { idea: string; clips: number }) => {
      const recipe = o.clipsNow.current?.find((c) => c.recipe)?.recipe ?? o.firstRecipe();
      if (!recipe) throw new Error("There is no video model to plan clips for yet.");
      const made = await api.designerPlan({ recipe, idea: v.idea.trim(), clips: v.clips, look: o.timeline?.look ?? null, mood: o.timeline?.mood });
      if (!made.clips.length) throw new Error(made.note || "The designer returned no clips.");
      return api.planTimeline(id, recipe, made.clips);
    },
    onSuccess: (r) => {
      // the scene typed goes with the start panel, which the clips replace
      client.setQueryData(["timelines", id], r.timeline);
      o.on.select(r.clips[0] ?? null);
      after();
    },
  });
  // the latest that failed, not the first of the list: an old error does not hide a new one
  // (with when it was asked, `errorAt`, for the editor to weigh it against its own range actions')
  const { error, at: errorAt } = [plan, loop, render, fix, patch, edit, add, remove, removeMany, removeTake, stop, undo, redo, exportIt, frame, split, duplicate]
    .filter((x) => x.error)
    .reduce<{ error: Error | null; at: number }>((last, x) => (x.submittedAt >= last.at ? { error: x.error, at: x.submittedAt } : last), { error: null, at: -1 });
  return { after, render, patch, fix, edit, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan, error, errorAt };
}
