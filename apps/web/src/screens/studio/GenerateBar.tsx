import { Link } from "wouter";
import { Minus, Plus } from "lucide-react";
import { hasWildcards } from "@afflatus/core";
import type { Draft, RecipeInfo } from "../../api";
import { useEstimates } from "../../data";
import { estimateFor } from "../../estimate";
import { aboutMs } from "../../format";
import { FormModel, ResultsPlace } from "../../ModelLoad";
import { Button, ErrorNote } from "../../ui";
import { useQueueOf } from "./queueOf";
import type { useGenerate } from "./useGenerate";

/** The foot of the Create panel: what stops the form, where its results go, the batch count, and Generate with what it will take. */
export function GenerateBar({ recipe, draft, whole, folder, blocked, send, onCount }: {
  recipe: RecipeInfo | undefined;
  draft: Draft | null;
  /** The whole form as it stands. */
  whole: Record<string, unknown>;
  folder: { name: string; path: string | null } | null;
  blocked: string | null;
  send: ReturnType<typeof useGenerate>;
  onCount(count: number): void;
}) {
  const count = draft?.count ?? 1;
  const noun = recipe?.output === "image" ? "image" : recipe?.output === "video" ? "video" : "audio clip";
  const estimates = useEstimates();
  // the model ComfyUI holds, alone: the panel is not drawn again at every sampler step
  const loadedNow = useQueueOf((q) => q.model) ?? null;
  const each = estimateFor(estimates.data, recipe, whole, loadedNow);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
      {send.isError && <ErrorNote>{send.error.message}</ErrorNote>}
      {blocked && (
        <ErrorNote>
          {blocked} <Link href="/settings/models" className="font-semibold underline">Open settings</Link>
        </ErrorNote>
      )}
      {recipe && recipe.inputs.some((i) => i.type === "prompt" && hasWildcards(String(whole[i.id] ?? ""))) && (
        <span className="text-xs text-ink-2">{"{a|b|c}"} wildcard: one option is picked for each {noun}{count === 1 ? ". Generate several to see them vary." : "."}</span>
      )}
      {recipe && draft && !blocked && <FormModel recipe={recipe} input={whole} look={draft.look} />}
      <ResultsPlace folder={folder} />
      <div className="flex items-center gap-2.5">
        <div className="flex h-11 shrink-0 items-center rounded-lg border border-line">
          <button type="button" aria-label="Batch count: one fewer" onClick={() => onCount(count - 1)} className="flex h-full w-9 items-center justify-center"><Minus size={14} /></button>
          <span className="w-6 text-center font-bold">{count}</span>
          <button type="button" aria-label="Batch count: one more" onClick={() => onCount(count + 1)} className="flex h-full w-9 items-center justify-center"><Plus size={14} /></button>
        </div>
        <Button tone="primary" className="h-11 grow text-sm" disabled={!recipe || !draft || Boolean(blocked) || send.isPending} onClick={() => send.mutate()}>
          <span data-tip="Ctrl + Enter">{send.isPending ? "Queuing…" : `Generate ${count} ${noun}${count > 1 ? "s" : ""}${each ? ` · ${aboutMs(each.ms * count + each.loadMs)}` : ""}`}</span>
        </Button>
      </div>
    </div>
  );
}
