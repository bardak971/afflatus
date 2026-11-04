import { create } from "zustand";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "./api";
import { wholeForm, type FormSetup } from "./form";
import type { ActionId, TuneAt } from "./itemActions";
import type { QueuedJob } from "./queueVariation";

export type { TuneAt };

/**
 * A pass with its settings (card #270): Shift+click, or the ▾ beside it, opens a small popover with the pass's key rows,
 * filled as the pass would send them for this picture, and queues it from there; no draft, no form. The rows are the
 * recipe's own inputs (the forms' skeleton, recipes' pictureForm), drawn by the forms' own fields, so their words are the
 * forms' words.
 */

/** The key rows of each pass that has settings, by the recipe input ids the forms share (PICTURE_ROWS). */
export const TUNED_ROWS: Partial<Record<ActionId, readonly string[]>> = {
  upscale: ["factor", "upscaler"],
  face: ["strength", "detector"],
  hand: ["strength", "detector"],
  "vary-subtle": ["strength"],
  "vary-strong": ["strength"],
  variation: [],
};

/** Those that queue several at once, each on a new seed: their popover has a batch count. */
export const COUNTED: ReadonlySet<ActionId> = new Set(["variation", "vary-subtle", "vary-strong"]);
export const MAX_COUNT = 8;

/** The batch count row, a number field as the forms draw one. */
export const BATCH_COUNT: InputSpec = { id: "count", type: "number", label: "Batch count", note: "how many are queued, each on a new seed", min: 1, max: MAX_COUNT, step: 1, default: 1 };

/** A pass's key rows its recipe has, in the recipe's order. */
export const tunedRows = (recipe: RecipeInfo, action: ActionId): InputSpec[] => {
  const ids = TUNED_ROWS[action] ?? [];
  return recipe.inputs.filter((i) => ids.includes(i.id));
};

/** What the rows start on: the job as the pass sends it, the recipe's defaults (and the model's own) under it. */
export function tuneStart(job: QueuedJob, status: FormSetup, settings: Parameters<typeof wholeForm>[2], rows: InputSpec[]): Record<string, unknown> {
  const whole = wholeForm(job.recipe, status, settings, job.stored);
  return Object.fromEntries(rows.map((i) => [i.id, whole[i.id]]));
}

/**
 * The job with the rows changed in the popover, and how many copies. An upscale set to another factor is named by it in
 * the queue and its banner ("Upscale 4x"), not by the button's 2x.
 */
export const tunedJob = (job: QueuedJob, changed: Record<string, unknown>, count: number): QueuedJob => ({
  ...job,
  stored: { ...job.stored, ...changed },
  ...(typeof changed.factor === "number" ? { label: job.label.replace(/\d+(\.\d+)?x$/, `${changed.factor}x`) } : {}),
  ...(count > 1 ? { count: Math.min(MAX_COUNT, Math.round(count)) } : {}),
});

/** The box of what was clicked, where the popover opens next to. */
export const tuneAt = (el: Element): TuneAt => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** What the popover is asked for. `queue` is handed the rows changed (not the others: a selection keeps each picture's own). */
export interface TuneAsk {
  action: ActionId;
  title: string;
  /** What it runs on, under the title ("on 6 pictures"). */
  sub?: string;
  /** The job as the pass would send it: what the rows start on, and the recipe they are read from. */
  job: QueuedJob;
  queue(changed: Record<string, unknown>, count: number): void;
}

/** The one popover open (TunePopover.tsx draws it). */
export const useTune = create<{ ask: (TuneAsk & { at: TuneAt; n: number }) | null; open(at: TuneAt, ask: TuneAsk): void; close(): void }>((set, get) => ({
  ask: null,
  // numbered, so that one opened over another starts on its own values
  open: (at, ask) => set({ ask: { ...ask, at, n: (get().ask?.n ?? 0) + 1 } }),
  close: () => set({ ask: null }),
}));
