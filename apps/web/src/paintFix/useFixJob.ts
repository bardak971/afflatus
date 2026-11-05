import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RegionValue } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { uploadMask } from "../maskName";
import { useSendJob, type QueuedJob } from "../queueVariation";
import { queryKeys } from "../queryKeys";
import { latestFailure } from "../sayFailed";
import { outpaintsByFrame, useVersionDrafts } from "./useStageMode";
import type { FrameSides } from "../stageLayer/useFrameTool";
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

/** Whether the recipe has a row of this id (a family's form may not take a grow, a prompt or a denoise). */
const takes = (tool: RecipeInfo, id: string) => tool.inputs.some((i) => i.id === id);

/** The prompt as the bar sends it: an empty one keeps the picture's own (carried with it), only what is written replaces it. */
const promptOf = (tool: RecipeInfo, prompt: string) => (prompt.trim() && takes(tool, "prompt") ? { prompt: prompt.trim() } : {});

/** The inpaint recipe's own slots: its mask's, and whether it takes a grow and a prompt (a family's form may not). */
export function fixInputs(tool: RecipeInfo, ask: Omit<FixAsk, "count">, mask: string): Record<string, unknown> {
  const slot = tool.inputs.find((i) => i.type === "image" && i.role === "mask")!;
  return {
    [slot.id]: mask,
    ...promptOf(tool, ask.prompt),
    ...(takes(tool, "strength") ? { strength: ask.strength } : {}),
    ...(takes(tool, "maskGrow") ? { maskGrow: ask.grow } : {}),
    // its 0 means "picked from the size of the part", a blur over the whole mask again: with a feathered mask the feather is the edge
    ...(ask.soft && takes(tool, "maskBlur") ? { maskBlur: 1 } : {}),
    ...ask.tuned,
  };
}

type OutpaintAsk = Omit<FixAsk, "strength" | "grow"> & { sides: FrameSides };

/** The outpaint's inputs: the sides, what the added parts show when written, the ⚙ rows. */
export function outInputs(tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "tuned">, sides: FrameSides): Record<string, unknown> {
  return { ...sides, ...promptOf(tool, ask.prompt), ...ask.tuned };
}

/** An edit's inputs: the instruction when written, img2img's denoise when it takes one, the ⚙ rows. */
function editInputs(tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "strength" | "tuned">): Record<string, unknown> {
  return { ...promptOf(tool, ask.prompt), ...(takes(tool, "strength") ? { strength: ask.strength } : {}), ...ask.tuned };
}

/**
 * Edit in box's inputs (card #284): the boxes as the recipe takes them (each its place and its instruction, nothing of a
 * region's cast or LoRA), then the ⚙ rows.
 */
export function boxInputs(boxes: readonly RegionValue[], tuned: Record<string, unknown>): Record<string, unknown> {
  return { boxes: boxes.map((b) => ({ id: b.id, box: b.box, prompt: b.prompt.trim() })), ...tuned };
}

/** The recipe a job needs, or why there is none to queue. */
function need<T>(recipe: T | undefined, what: string): T {
  if (!recipe) throw new Error(`No ${what} model is installed.`);
  return recipe;
}

/**
 * Paint and fix's Fix: the mask painted on the Stage uploaded (named after its picture, kept out of the library), then the
 * picture's inpaint queued with it as versions of the picture, ×N on new seeds. "Open the full form" makes the same job a
 * draft instead, whose renders come back as versions too (useVersionDrafts). Outpaint, Edit and Edit in box the same way.
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
  /** The job a bar queues, as ⚙'s rows start on it: the recipe's stored inputs, as a version of the picture shown. */
  const jobFor = (recipe: RecipeInfo, label: string): QueuedJob => ({ recipe, stored: toolInput(recipe), label, from: a.id, versionOf: a.id });
  /** The job queued with the bar's inputs over the stored ones, ×`count`, its versions under the picture. */
  const queueVersion = (recipe: RecipeInfo, label: string, inputs: Record<string, unknown>, count?: number) => {
    const job = jobFor(recipe, label);
    return send({ ...job, stored: { ...job.stored, ...inputs }, ...(count ? { count } : {}) });
  };
  /**
   * The full form opened with the bar's inputs: its renders are versions of the picture, marked as the draft opens, before
   * the viewer (and this hook) goes.
   */
  const openVersionForm = (recipe: RecipeInfo, inputs: Record<string, unknown>) => {
    const picture = a.id;
    return openTool.mutateAsync({ id: recipe.id, with: inputs, opened: (d) => useVersionDrafts.getState().mark(d.id, picture) });
  };
  /** A queued job's end: the queue read again. Why one failed is said in the bar it came from (`failure`), not in a banner. */
  const queued = { onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }) };
  const upload = async (png: Blob) => (await uploadMask(a.id, png)).id;

  const fix = useMutation({
    mutationFn: async ({ png, ...ask }: FixAsk & { png: Blob }) => {
      const t = need(tool, "inpaint");
      await queueVersion(t, "Inpaint", fixInputs(t, ask, await upload(png)), ask.count);
    },
    ...queued,
  });
  const fullForm = useMutation({
    mutationFn: async ({ png, ...ask }: Omit<FixAsk, "count"> & { png: Blob | null }) => {
      const t = need(tool, "inpaint");
      // an empty mask goes as none: the form's painter opens on the picture
      const mask = png ? await upload(png) : null;
      await openVersionForm(t, mask ? fixInputs(t, ask, mask) : {});
    },
  });
  /** Outpaint by the frame dragged out: the sides as the recipe's Custom shape, versions of the picture like a fix. */
  const outpaint = useMutation({
    mutationFn: async ({ sides, ...ask }: OutpaintAsk) => {
      const t = need(out, "outpaint");
      await queueVersion(t, "Outpaint", outInputs(t, ask, sides), ask.count);
    },
    ...queued,
  });
  const outForm = useMutation({
    mutationFn: async ({ sides, ...ask }: Omit<OutpaintAsk, "count">) => {
      const t = need(out, "outpaint");
      await openVersionForm(t, outInputs(t, ask, sides));
    },
  });
  /** Edit from the bar: the instruction (or img2img's prompt and denoise) on the whole picture, as versions of it. */
  const edit = useMutation({
    mutationFn: async (ask: FixAsk) => {
      const t = need(editTool, "edit");
      await queueVersion(t, "Edit", editInputs(t, ask), ask.count);
    },
    ...queued,
  });
  const editForm = useMutation({
    mutationFn: async (ask: Omit<FixAsk, "count">) => {
      const t = need(editTool, "edit");
      await openVersionForm(t, editInputs(t, ask));
    },
  });
  /** Edit in box: each box's instruction done there by the editor picked, one after another, into one version of the picture. */
  const boxEdit = useMutation({
    mutationFn: async ({ recipe, boxes, tuned }: { recipe: RecipeInfo; boxes: RegionValue[]; tuned: Record<string, unknown> }) => {
      await queueVersion(recipe, "Edit in box", boxInputs(boxes, tuned));
    },
    ...queued,
  });
  // the bar says what failed under it, in its place, until the next try: a banner over the Stage stayed until closed and
  // covered the strip's Size, Feather and Grow (card #317). The newest try only: an older failure is no news
  const tries = [
    ["The fix could not be queued", fix], ["The full form could not be opened", fullForm], ["The outpaint could not be queued", outpaint],
    ["The full form could not be opened", outForm], ["The edit could not be queued", edit], ["The full form could not be opened", editForm],
    ["The edit in box could not be queued", boxEdit],
  ] as const;
  const newest = Math.max(0, ...tries.map(([, m]) => m.submittedAt));
  const said = latestFailure(tries, newest);
  const failure = said.error ? { what: said.what, error: said.error } : null;
  return { tool, fix, fullForm, out, outpaint, outForm, editTool, edit, editForm, boxEdit, jobFor, failure };
}
