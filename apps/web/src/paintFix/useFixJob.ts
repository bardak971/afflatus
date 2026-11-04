import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RegionValue } from "@afflatus/core";
import { api, type RecipeInfo } from "../api";
import { nameFor } from "../maskName";
import { useSendJob } from "../queueVariation";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { outpaintsByFrame, useVersionDrafts } from "./useStageMode";
import type { ViewerActions } from "../viewer/useViewerActions";

/** What the fix bar sends besides the mask: the prompt, the denoise, the grow, how many, and the ⚙ popover's rows. */
export interface FixAsk {
  prompt: string;
  /** The mask has a soft edge of its own (the layer's Feather): the recipe's own blend is kept to its least, not added on top. */
  soft?: boolean;
  strength: number;
  grow: number;
  count: number;
  /** The rows changed in ⚙ (TunePopover). */
  tuned: Record<string, unknown>;
}

/** The inpaint recipe's own slots: its mask's, and whether it takes a grow and a prompt (a family's form may not). */
export function fixInputs(tool: RecipeInfo, ask: Omit<FixAsk, "count">, mask: string): Record<string, unknown> {
  const has = (id: string) => tool.inputs.some((i) => i.id === id);
  const slot = tool.inputs.find((i) => i.type === "image" && i.role === "mask")!;
  return {
    [slot.id]: mask,
    // an empty prompt keeps the picture's own (carried with it): only what is written replaces it
    ...(ask.prompt.trim() && has("prompt") ? { prompt: ask.prompt.trim() } : {}),
    ...(has("strength") ? { strength: ask.strength } : {}),
    ...(has("maskGrow") ? { maskGrow: ask.grow } : {}),
    // its 0 means "picked from the size of the part", a blur over the whole mask again: with a feathered mask the feather is the edge
    ...(ask.soft && has("maskBlur") ? { maskBlur: 1 } : {}),
    ...ask.tuned,
  };
}

/** The frame's sides as the outpaint rows take them. */
export interface Sides {
  shape: "Custom";
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
}
export type OutpaintAsk = Omit<FixAsk, "strength" | "grow"> & { sides: Sides };

/** The outpaint's inputs: the sides, what the added parts show when written, the ⚙ rows. */
export function outInputs(tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "tuned">, sides: Sides): Record<string, unknown> {
  const has = (id: string) => tool.inputs.some((i) => i.id === id);
  return { ...sides, ...(ask.prompt.trim() && has("prompt") ? { prompt: ask.prompt.trim() } : {}), ...ask.tuned };
}

/** An edit's inputs: the instruction when written, img2img's denoise when it takes one, the ⚙ rows. */
export function editInputs(tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "strength" | "tuned">): Record<string, unknown> {
  const has = (id: string) => tool.inputs.some((i) => i.id === id);
  return { ...(ask.prompt.trim() && has("prompt") ? { prompt: ask.prompt.trim() } : {}), ...(has("strength") ? { strength: ask.strength } : {}), ...ask.tuned };
}

/**
 * Edit in box's inputs (card #284): the boxes as the recipe takes them (each its place and its instruction, nothing of a
 * region's cast or LoRA), then the ⚙ rows.
 */
export function boxInputs(boxes: readonly RegionValue[], tuned: Record<string, unknown>): Record<string, unknown> {
  return { boxes: boxes.map((b) => ({ id: b.id, box: b.box, prompt: b.prompt.trim() })), ...tuned };
}

/**
 * Paint and fix's Fix: the mask painted on the Stage uploaded (named after its picture, kept out of the library), then the
 * picture's inpaint queued with it as versions of the picture, ×N on new seeds. "Open the full form" makes the same job a
 * draft instead, whose renders come back as versions too (useVersionDrafts).
 */
export function useFixJob(acts: ViewerActions) {
  const { a, toolFor, toolInput, openTool } = acts;
  const tool = toolFor("i");
  // the outpaint by the frame's sides: every family's takes them (shape Custom), one that does not is left to its form
  const outTool = toolFor("r");
  const out = outpaintsByFrame(outTool) ? outTool : undefined;
  // Edit: the picture's instruction editor (Kontext, Qwen Edit, Klein) or its img2img, on the whole picture
  const editTool = toolFor("e");
  const send = useSendJob();
  const client = useQueryClient();
  const failed = useSayFailed({ here: true });
  const upload = async (png: Blob) => (await api.upload(new File([png], nameFor(a.id), { type: "image/png" }), { mask: true })).id;
  const fix = useMutation({
    mutationFn: async ({ png, ...ask }: FixAsk & { png: Blob }) => {
      if (!tool) throw new Error("No inpaint model is installed.");
      const mask = await upload(png);
      await send({ recipe: tool, stored: { ...toolInput(tool), ...fixInputs(tool, ask, mask) }, label: "Inpaint", from: a.id, versionOf: a.id, count: ask.count });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
    onError: failed("The fix could not be queued"),
  });
  /** Outpaint by the frame dragged out: the sides as the recipe's Custom shape, versions of the picture like a fix. */
  const outpaint = useMutation({
    mutationFn: async ({ sides, ...ask }: OutpaintAsk) => {
      if (!out) throw new Error("No outpaint model is installed.");
      await send({ recipe: out, stored: { ...toolInput(out), ...outInputs(out, ask, sides) }, label: "Outpaint", from: a.id, versionOf: a.id, count: ask.count });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
    onError: failed("The outpaint could not be queued"),
  });
  const outForm = useMutation({
    mutationFn: async ({ sides, ...ask }: Omit<OutpaintAsk, "count">) => {
      if (!out) throw new Error("No outpaint model is installed.");
      const picture = a.id;
      await openTool.mutateAsync({ id: out.id, with: outInputs(out, ask, sides), opened: (d) => useVersionDrafts.getState().mark(d.id, picture) });
    },
    onError: failed("The full form could not be opened"),
  });
  /** Edit from the bar: the instruction (or img2img's prompt and denoise) on the whole picture, as versions of it. */
  const edit = useMutation({
    mutationFn: async (ask: FixAsk) => {
      if (!editTool) throw new Error("No edit model is installed.");
      await send({ recipe: editTool, stored: { ...toolInput(editTool), ...editInputs(editTool, ask) }, label: "Edit", from: a.id, versionOf: a.id, count: ask.count });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
    onError: failed("The edit could not be queued"),
  });
  const editForm = useMutation({
    mutationFn: async (ask: Omit<FixAsk, "count">) => {
      if (!editTool) throw new Error("No edit model is installed.");
      const picture = a.id;
      await openTool.mutateAsync({ id: editTool.id, with: editInputs(editTool, ask), opened: (d) => useVersionDrafts.getState().mark(d.id, picture) });
    },
    onError: failed("The full form could not be opened"),
  });
  const fullForm = useMutation({
    mutationFn: async ({ png, ...ask }: Omit<FixAsk, "count"> & { png: Blob | null }) => {
      if (!tool) throw new Error("No inpaint model is installed.");
      // an empty mask goes as none: the form's painter opens on the picture
      const mask = png ? await upload(png) : null;
      const over = mask ? fixInputs(tool, ask, mask) : {};
      const picture = a.id;
      // its renders are versions of the picture: marked as the draft opens, before the viewer (and this hook) goes
      await openTool.mutateAsync({ id: tool.id, with: over, opened: (d) => useVersionDrafts.getState().mark(d.id, picture) });
    },
    onError: failed("The full form could not be opened"),
  });
  /** Edit in box: each box's instruction done there by the editor picked, one after another, into one version of the picture. */
  const boxEdit = useMutation({
    mutationFn: async ({ recipe, boxes, tuned }: { recipe: RecipeInfo; boxes: RegionValue[]; tuned: Record<string, unknown> }) => {
      await send({ recipe, stored: { ...toolInput(recipe), ...boxInputs(boxes, tuned) }, label: "Edit in box", from: a.id, versionOf: a.id });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
    onError: failed("The edit in box could not be queued"),
  });
  return { tool, fix, fullForm, out, outpaint, outForm, editTool, edit, editForm, boxEdit };
}
