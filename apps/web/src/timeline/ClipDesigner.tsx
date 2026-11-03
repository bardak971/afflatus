import { lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Clip, type DesignerSession, type RecipeInfo, type Timeline } from "../api";
import type { useModelSettings, useSetup } from "../data";
import type { DesignerTurn } from "../designer/types";
import { wholeForm } from "../form";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { Button, Failed } from "../ui";

// the designer's panel is a chunk of its own: fetched the first time it opens
const Designer = lazy(() => import("../Designer").then((m) => ({ default: m.Designer })));

/**
 * The designer, open for one clip of the timeline: on the left, over the media, so that the clip's own settings on the right
 * stay in view and are seen to change. It is told the story so far (what each clip says happens), the clip before's words
 * when this one carries on from it, and the cast and mood; its conversation and session are kept with the clip.
 */
export function ClipDesigner({ timeline: t, clip: c, clips, recipes, setup, settings, inputsOf, sayOf, turns, onTurns, session, onSession, onApply, onClose }: {
  timeline: Timeline;
  clip: Clip;
  clips: Clip[];
  recipes: RecipeInfo[];
  setup: ReturnType<typeof useSetup>;
  settings: ReturnType<typeof useModelSettings>;
  inputsOf(c: Clip): Record<string, unknown>;
  /** What a clip says happens, in a few words. */
  sayOf(c: Clip): string;
  /** What was said about this clip while the editor is open, over what the clip keeps. */
  turns: DesignerTurn[] | undefined;
  onTurns(turns: DesignerTurn[]): void;
  session: DesignerSession | undefined;
  onSession(session: DesignerSession): void;
  onApply(changes: Record<string, unknown>): void;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const sayFailed = useSayFailed({ id: `clip-chat:${c.id}`, once: true, here: true });
  // what was said before, kept with the clip: read as the designer opens (card #242: not with every read of the timeline).
  // Read afresh each time it opens, the copy dropped as it closes: every turn saves the whole conversation, so one started
  // from an older copy (an earlier visit to the editor) would write the turns said since out of the clip (card #267).
  const kept = useQuery({ queryKey: queryKeys.clipChat(c.id), queryFn: ({ signal }) => api.clipChat(c.id, { signal }), enabled: !turns, staleTime: 0, gcTime: 0 });
  const recipe = recipes.find((r) => r.id === c.recipe);
  if (!recipe) return null;
  // a conversation that could not be read is not opened as an empty one: its first turn would replace what the clip keeps
  if (!turns && !kept.data) return kept.isError ? <div className="p-3"><Failed what="This clip's conversation could not be read" error={kept.error}><Button size="sm" onClick={() => void kept.refetch()}>Try again</Button></Failed></div> : null;
  const at = clips.indexOf(c);
  const before = at > 0 && c.joined === "continue" ? clips[at - 1] : undefined;
  const beforeRecipe = recipes.find((r) => r.id === before?.recipe);
  const beforeMain = beforeRecipe?.inputs.find((i) => i.type === "prompt" && !i.optional);
  const stored = inputsOf(c);
  const status = setup.data?.recipes.find((r) => r.id === recipe.id);
  return (
    <Suspense fallback={null}>
      <Designer
        // in the clip's own column, where the prompt it writes is: the player keeps its whole width
        side="inline"
        draftKey={`clip:${c.id}`}
        recipe={recipe}
        values={wholeForm(recipe, status, settings.data?.items ?? [], stored)}
        previous={before && beforeMain ? String(inputsOf(before)[beforeMain.id] ?? "") || undefined : undefined}
        story={{ clips: clips.map(sayOf), index: at }}
        look={c.look ?? t.look}
        mood={t.mood}
        turns={turns ?? ((kept.data?.chat ?? []) as DesignerTurn[])}
        onTurns={(next) => {
          onTurns(next);
          // kept with the clip, so that it is there the next time the timeline is opened; the copy read stays in step with it
          queryClient.setQueryData(queryKeys.clipChat(c.id), { chat: next });
          void api.editClip(c.id, { chat: next }).catch(sayFailed("The conversation was not kept with the clip"));
        }}
        session={session ?? c.designer}
        onSession={(next) => {
          onSession(next);
          void api.editClip(c.id, { designer: next }).catch(() => {});
        }}
        onApply={onApply}
        onClose={onClose}
      />
    </Suspense>
  );
}
