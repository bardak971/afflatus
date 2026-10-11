import { Link } from "wouter";
import { Minus, Plus } from "lucide-react";
import { hasWildcards, plural } from "@afflatus/core";
import type { Draft, RecipeInfo } from "../../api";
import { batchAbout, useAdvice } from "../../advice";
import { BATCH } from "../../draft";
import { Keys } from "../../Keys";
import { FormModel, ResultsPlace } from "../../ModelLoad";
import { Button, ErrorNote, Help } from "../../ui";
import { inputMissing } from "./missing";
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
  // the form's own forecast, the one its Output line says (advice.ts): the button says it for the whole batch
  const about = batchAbout(useAdvice(recipe, whole).data?.estimate, count);
  const missing = inputMissing(recipe, whole);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
      {send.isError && <ErrorNote>{send.error.message}</ErrorNote>}
      {blocked && (
        <ErrorNote>
          {blocked} <Link href="/settings/models" className="font-semibold underline">Open settings</Link>
        </ErrorNote>
      )}
      {recipe && recipe.inputs.some((i) => i.type === "prompt" && hasWildcards(String(whole[i.id] ?? ""))) && (
        <span className="flex items-center gap-1.5 text-xs text-ink-2">
          Wildcards: one pick per {noun}
          <Help text={`{a|b|c} in the prompt: one option is picked for each ${noun}.${count === 1 ? " Generate several to see them vary." : ""}`} />
        </span>
      )}
      {recipe && draft && !blocked && <FormModel recipe={recipe} input={whole} look={draft.look} />}
      <ResultsPlace folder={folder} />
      {/* a container: on a narrow panel the keys leave the button (they stay in its tip) before the label is cut */}
      <div className="@container flex items-center gap-2.5">
        <div role="group" aria-label="Batch count" data-tip={`Batch count, ${BATCH.least} to ${BATCH.most}`} className="flex h-11 shrink-0 items-center gap-0.5 rounded-lg border border-line px-1.5">
          <Button tone="quiet" size="sm" className="w-8 rounded-[3px]! px-0!" aria-label="Batch count: one fewer" disabled={count <= BATCH.least} onClick={() => onCount(count - 1)}><Minus size={14} /></Button>
          <span aria-live="polite" className="w-6 text-center font-mono font-bold">{count}</span>
          <Button tone="quiet" size="sm" className="w-8 rounded-[3px]! px-0!" aria-label="Batch count: one more" disabled={count >= BATCH.most} onClick={() => onCount(count + 1)}><Plus size={14} /></Button>
        </div>
        {/* the label gives way before the panel's edge does: the keys go first, then the estimate is cut, then the rest */}
        <Button tone="primary" className="h-11 min-w-0 grow text-sm" disabled={!recipe || !draft || Boolean(blocked) || Boolean(missing) || send.isPending} data-tip={missing ?? "Generate"} data-tip-keys="Ctrl+Enter" onClick={() => send.mutate()}>
          {send.isPending ? (
            <span className="truncate">Queuing…</span>
          ) : (
            <span className="flex min-w-0">
              <span className="truncate">{`Generate ${plural(count, noun)}`}</span>
              {about && <span className="min-w-0 shrink-[100] truncate">&nbsp;· {about}</span>}
            </span>
          )}
          <Keys keys="Ctrl+Enter" size="sm" className="@max-[30rem]:hidden" />
        </Button>
      </div>
    </div>
  );
}
