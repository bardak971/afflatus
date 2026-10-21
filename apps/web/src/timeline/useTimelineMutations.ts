import { useCallback, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type Clip, type QueueStatus, type RecipeInfo, type Timeline, type TimelinePatch } from "../api";
import { timelineKey, useDraftMachine } from "../draftMachine";
import { severalMachines } from "../machines";
import { movingSeed, seedAfter, useSeedMode } from "../seedMode";
import type { Fix } from "./attention";
import type { ExportOptions } from "./ExportDialog";
import { pinInputs, type ShownPatch } from "./model";
import { sourceKey, type useClipEdits } from "./useClipEdits";
import { queryKeys } from "../queryKeys";
import { latestFailure } from "../sayFailed";

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
  edits: Pick<ReturnType<typeof useClipEdits>, "save" | "turn" | "ready" | "inputsOf" | "editInputs" | "dropEdits" | "savedElsewhere" | "sourceTyped">;
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
  const { save, turn, ready, inputsOf, editInputs, dropEdits, savedElsewhere, sourceTyped } = o.edits;
  const client = useQueryClient();
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: queryKeys.timelines.all() }), [client]);
  const after = () => {
    void refresh();
    void client.invalidateQueries({ queryKey: queryKeys.queue() });
  };
  // the same, a mutation pending until the timeline is read back: the trims wait for it before they take another one
  // (useOneTrim), the next one worked out from the change the last one made
  const readBack = () => Promise.all([refresh(), client.invalidateQueries({ queryKey: queryKeys.queue() })]);
  const render = useMutation({
    mutationFn: async (v: { clips: Clip[]; takes?: number; machine?: string }) => {
      await save();
      // a seed meant to move: the takes go out with the next seeds in a row, and the clip's form shows the one after them
      const mode = useSeedMode.getState().mode;
      const sent = v.clips.map((c) => ({ clip: c, input: ready(c).input ?? {} })).map((x) => ({ ...x, seedMode: movingSeed(x.input.seed, mode) }));
      // with several ComfyUIs, the machine picked for this timeline (New take's slice), or the one asked this once (Ctrl+K)
      const asked = v.machine ?? useDraftMachine.getState().of[timelineKey(id)];
      const machine = asked && severalMachines(client.getQueryData<QueueStatus>(queryKeys.queue())).some((m) => m.id === asked) ? asked : undefined;
      const made = await api.renderClips(id, sent.map(({ clip, input, seedMode }) => ({ id: clip.id, input, ...(v.takes && v.takes > 1 ? { takes: v.takes } : {}), ...(seedMode ? { seedMode } : {}) })), machine);
      for (const x of sent) {
        if (!x.seedMode) continue;
        const inputs = { ...inputsOf(x.clip), seed: seedAfter(x.input.seed as number, mode, v.takes ?? 1) };
        // in the forms' turn: a save of the clip's form typed meanwhile goes after it, never crossing it
        await turn(() => api.editClip(x.clip.id, { inputs }));
        // the form's own edit of the clip, if it has one, is this now: the read back that carries it drops it
        savedElsewhere(x.clip.id, inputs);
      }
      return made;
    },
    onSuccess: after,
  });
  // what was typed over the clip is saved first, then the patch, in the forms' turn: a pin's Mirror sent within half a
  // second of the pin was refused (no picture there yet on the server), or dropped by the inputs' save that came after it
  const patch = useMutation({
    mutationFn: async (v: { clip: string; patch: ShownPatch }) => {
      await save(v.clip);
      return turn(() => api.editClip(v.clip, v.patch));
    },
    onSuccess: after,
  });
  // what Needs attention mends: the patches one after the other (each its own Undo step), then one render of the clips left.
  // Each as `patch` sends one: what was typed over the clip first, then the patch in the forms' turn, so that a save of
  // its form never crosses it
  const fix = useMutation({
    mutationFn: async (v: Omit<Fix, "ms">) => {
      for (const p of v.patches) {
        await save(p.clip);
        await turn(() => api.editClip(p.clip, p.patch));
      }
      const clips = (o.clipsNow.current ?? []).filter((c) => v.render.includes(c.id));
      if (clips.length) await render.mutateAsync({ clips });
    },
    onSuccess: after,
  });
  const edit = useMutation({ mutationFn: (p: TimelinePatch) => api.editTimeline(id, p), onSuccess: after });
  /**
   * The source lane's stretch made into clips (their ids, to send to render once the timeline is read again). The server
   * makes them from the source's form it has: what was typed in it is saved first, else the clips were queued to render
   * with the form as it was before. A save that failed keeps what was typed, said in the header: nothing is made then.
   */
  const makeSource = useMutation({
    mutationFn: async () => {
      await save(sourceKey(id));
      if (sourceTyped(id)) throw new Error("The source's form is not saved: nothing was made.");
      return api.makeFromSource(id);
    },
    onSuccess: after,
  });
  /** The source cut again into its clips (its window or its scene cuts changed): those rendered at its start are kept. */
  const cutSource = useMutation({ mutationFn: () => api.makeFromSource(id, true), onSuccess: after });
  /** A recording's Lip sync clips trimmed (Timelines.trimRecording). */
  const trimRecording = useMutation({ mutationFn: (v: { asset: string; fromMs: number; toMs: number }) => api.trimRecording(id, v.asset, v.fromMs, v.toMs), onSuccess: readBack });
  /** The source's stretch trimmed after Make (Timelines.trimSource). */
  const trimSource = useMutation({ mutationFn: (v: { fromMs: number; toMs: number }) => api.trimSource(id, v.fromMs, v.toMs), onSuccess: readBack });
  /** A voice recording made into Lip sync clips (their ids, the first opened once the timeline is read again). */
  const recording = useMutation({ mutationFn: (v: { asset: string; clip?: string }) => api.makeFromRecording(id, v.asset, v.clip), onSuccess: after });
  /** The source given another windowed form: its windows and takes kept on the same grid, else made anew (Timelines.sourceForm). */
  const sourceForm = useMutation({ mutationFn: (recipe: string) => api.sourceForm(id, recipe), onSuccess: after });
  /** The source split at a moment of it: the part before plays as it is, a clip of its own. */
  const splitSource = useMutation({ mutationFn: (atMs: number) => api.splitSource(id, atMs), onSuccess: after });
  const add = useMutation({
    mutationFn: (v: NewClip) => api.addClip(id, v),
    onSuccess: (r) => {
      client.setQueryData(queryKeys.timelines.one(id), r.timeline);
      o.on.select(r.clip);
      after();
    },
  });
  // what was typed over a clip is saved before it is removed, in the forms' turn: its save sent after the removal was
  // answered 404 (and Undo brings the clip back with what was typed)
  const removeClip = async (clip: string) => {
    await save(clip);
    await turn(() => api.deleteClip(clip));
  };
  // pending until the timeline is read again without them: Delete pressed again meanwhile sent the removal of a clip
  // already gone (editorKeys.ts waits for it)
  const readAgain = () => {
    void client.invalidateQueries({ queryKey: queryKeys.queue() });
    return refresh();
  };
  const remove = useMutation({ mutationFn: removeClip, onSuccess: readAgain });
  // the clips picked with Ctrl + click, removed one after the other (each comes back with Undo)
  const removeMany = useMutation({ mutationFn: async (ids: string[]) => { for (const id of ids) await removeClip(id); }, onSuccess: () => { o.on.unpick(); return readAgain(); } });
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
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
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
      const end = pins.end;
      if (!end) return;
      const stored = inputsOf(c);
      const flows = (o.clipsNow.current?.indexOf(c) ?? 0) > 0 && c.joined === "continue";
      const opening = !flows && pins.start && typeof stored[pins.start] === "string" ? (stored[pins.start] as string) : null;
      if (opening) return editInputs(c, { ...stored, [end]: opening });
      if (!c.take) return;
      const first = await api.frame(c.take.asset.id, c.take.startMs + 20, id);
      // over the form as it stands once the frame is saved: what was typed while ffmpeg took it stays
      editInputs(c, (was) => ({ ...was, ...(pins.start && !flows ? { [pins.start]: first.id } : {}), [end]: first.id }));
      o.on.note("It will loop from the next take: it now ends on its own first frame.");
    },
  });
  /** A scene in a few words, written as clips by the designer and put on the timeline. Nothing is rendered. */
  const plan = useMutation({
    mutationFn: async (v: { idea: string; clips: number }) => {
      // a source's window is made from its driving video, never written from an idea
      const recipe = o.clipsNow.current?.find((c) => c.recipe && !o.recipes.find((r) => r.id === c.recipe)?.traits?.windows)?.recipe ?? o.firstRecipe();
      if (!recipe) throw new Error("There is no video model to plan clips for yet.");
      const made = await api.designerPlan({ recipe, idea: v.idea.trim(), clips: v.clips, look: o.timeline?.look ?? null, mood: o.timeline?.mood });
      if (!made.clips.length) throw new Error(made.note || "The designer returned no clips.");
      return api.planTimeline(id, recipe, made.clips);
    },
    onSuccess: (r) => {
      // the scene typed goes with the start panel, which the clips replace
      client.setQueryData(queryKeys.timelines.one(id), r.timeline);
      o.on.select(r.clips[0] ?? null);
      after();
    },
  });
  // the latest that failed, not the first of the list: an old error does not hide a new one
  // (with when it was asked, `errorAt`, for the editor to weigh it against its own range actions')
  const { error, at: errorAt } = latestFailure([plan, loop, render, fix, patch, edit, makeSource, cutSource, sourceForm, recording, trimSource, trimRecording, splitSource, add, remove, removeMany, removeTake, stop, undo, redo, exportIt, frame, split, duplicate]);
  return { after, render, patch, fix, edit, makeSource, cutSource, sourceForm, recording, trimSource, trimRecording, splitSource, add, remove, removeMany, split, writeBetween, removeTake, stop, undo, redo, duplicate, exportIt, frame, loop, plan, error, errorAt };
}
