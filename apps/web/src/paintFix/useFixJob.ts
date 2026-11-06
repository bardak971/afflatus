import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { RegionValue } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { uploadMask } from "../maskName";
import { useSendJob, type QueuedJob } from "../queueVariation";
import { queryKeys } from "../queryKeys";
import { passInputs, type FixAsk } from "../passes";
import { latestFailure } from "../sayFailed";
import { outpaintsByFrame } from "./useStageMode";
import { useVersionPass, type VersionAsk } from "./useVersionPass";
import type { FrameSides } from "../stageLayer/useFrameTool";
import type { ViewerActions } from "../viewer/useViewerActions";

type OutpaintAsk = Omit<FixAsk, "strength" | "grow"> & { sides: FrameSides };
/** Edit in box's ask: the editor the bar picked, the boxes drawn, the ⚙ rows. */
type BoxAsk = { recipe: RecipeInfo; boxes: RegionValue[]; tuned: Record<string, unknown> };

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
 * draft instead, whose renders come back as versions too (useVersionDrafts). Outpaint, Edit and Edit in box the same way;
 * the first three through their pass (useVersionPass), Edit in box by the editor its bar picked.
 */
export function useFixJob(acts: ViewerActions) {
  const { a, toolFor, toolInput } = acts;
  const tool = toolFor("i");
  // the outpaint by the frame's sides: every family's takes them (shape Custom), one that does not is left to its form
  const outTool = toolFor("r");
  const out = outpaintsByFrame(outTool) ? outTool : undefined;
  // Edit: the picture's instruction editor (Kontext, Qwen Edit, Klein) or its img2img, on the whole picture
  const editTool = toolFor("e");
  const inpaint = useVersionPass(acts, "i", tool);
  const outpaints = useVersionPass(acts, "r", out);
  const edits = useVersionPass(acts, "e", editTool);
  const send = useSendJob();
  const client = useQueryClient();
  /** The job a bar queues, as ⚙'s rows start on it: the recipe's stored inputs, as a version of the picture shown. */
  const jobFor = (recipe: RecipeInfo, label: string): QueuedJob => ({ recipe, stored: toolInput(recipe), label, from: a.id, versionOf: a.id });
  /**
   * One send at a time, held at once: a second ask while one is on its way is dropped. The bars' busy (isPending) comes a
   * tick late, after TanStack's notify, so two clicks in one frame both found Fix enabled and queued two batches (pod test
   * 2026-11-06, card #324). A dropped ask never reaches the mutation, which keeps the first one's failure to say. `ask`:
   * what the bar's ask is sent as.
   */
  const sending = useRef(false);
  const once = <V, W>(m: UseMutationResult<void, Error, W>, ask: (v: V) => W) => ({
    ...m,
    mutate: (v: V) => {
      if (sending.current) return;
      sending.current = true;
      m.mutate(ask(v), { onSettled: () => { sending.current = false; } });
    },
  });
  const upload = async (png: Blob) => (await uploadMask(a.id, png)).id;

  // the mask's PNG is made once the job is on its way, not before: the bar is busy while it encodes (a second Fix then is
  // no second batch), and a mask that cannot be made is said under the bar like any other failure
  const fix = once(inpaint.send, ({ png, ...ask }: FixAsk & { png(): Promise<Blob> }): VersionAsk =>
    ({ inputs: async (t) => passInputs("i", t, { ...ask, mask: await upload(await png()) }), count: ask.count }));
  // an empty mask goes as none: the form's painter opens on the picture
  const fullForm = once(inpaint.openForm, ({ png, ...ask }: Omit<FixAsk, "count"> & { png: (() => Promise<Blob>) | null }): VersionAsk =>
    ({ inputs: async (t) => (png ? passInputs("i", t, { ...ask, mask: await upload(await png()) }) : {}) }));
  /** Outpaint by the frame dragged out: the sides as the recipe's Custom shape, versions of the picture like a fix. */
  const outpaint = once(outpaints.send, ({ sides, ...ask }: OutpaintAsk): VersionAsk => ({ inputs: (t) => passInputs("r", t, { ...ask, sides }), count: ask.count }));
  const outForm = once(outpaints.openForm, ({ sides, ...ask }: Omit<OutpaintAsk, "count">): VersionAsk => ({ inputs: (t) => passInputs("r", t, { ...ask, sides }) }));
  /** Edit from the bar: the instruction (or img2img's prompt and denoise) on the whole picture, as versions of it. */
  const edit = once(edits.send, (ask: FixAsk): VersionAsk => ({ inputs: (t) => passInputs("e", t, ask), count: ask.count }));
  const editForm = once(edits.openForm, (ask: Omit<FixAsk, "count">): VersionAsk => ({ inputs: (t) => passInputs("e", t, ask) }));
  /** Edit in box: each box's instruction done there by the editor picked, one after another, into one version of the picture. */
  const boxes = useMutation({
    mutationFn: async ({ recipe, boxes, tuned }: BoxAsk) => {
      const job = jobFor(recipe, "Edit in box");
      await send({ ...job, stored: { ...job.stored, ...boxInputs(boxes, tuned) } });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
  });
  const boxEdit = once(boxes, (ask: BoxAsk) => ask);
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
