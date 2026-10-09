import { lazy, Suspense } from "react";
import { api, type Clip, type DesignerSession, type RecipeInfo, type Timeline } from "../api";
import type { useModelSettings, useSetup } from "../data";
import type { DesignerTurn } from "../Designer";
import { formDefaults } from "../form";

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
  const recipe = recipes.find((r) => r.id === c.recipe);
  if (!recipe) return null;
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
        values={{ ...formDefaults(recipe, status?.options, settings.data?.items ?? [], stored).defaults, ...stored }}
        previous={before && beforeMain ? String(inputsOf(before)[beforeMain.id] ?? "") || undefined : undefined}
        story={{ clips: clips.map(sayOf), index: at }}
        look={c.look ?? t.look}
        mood={t.mood}
        turns={turns ?? (c.chat as DesignerTurn[])}
        onTurns={(next) => {
          onTurns(next);
          // kept with the clip, so that it is there the next time the timeline is opened
          void api.editClip(c.id, { chat: next }).catch(() => {});
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
