import { useEffect, useRef } from "react";
import { newTransition, TRANSITIONS } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline } from "../api";
import { useSelectedClip } from "../bar/bridge";
import { pinMirrors } from "./model";
import type { useClipEdits } from "./useClipEdits";
import type { useRange } from "./useRange";
import type { useTimelineMutations } from "./useTimelineMutations";

type Mutations = ReturnType<typeof useTimelineMutations>;

/**
 * The clip selected in the timeline editor, told to the command bar (bar/bridge.ts) for its `@name` and its clip commands:
 * who is in it and the Inspector's own change of its cast, its pinned frames' Mirror, the join before it, Slow motion and
 * Motion transfer in windows. Told nothing once the editor closes.
 */
export function useSelectedClipBridge({ id, t, clips, current, recipes, patch, inputsOf, rangeAct, edit, openSource }: {
  id: string;
  t: Timeline | undefined;
  clips: Clip[];
  current: Clip | null;
  recipes: RecipeInfo[] | undefined;
  patch: Mutations["patch"];
  inputsOf: ReturnType<typeof useClipEdits>["inputsOf"];
  rangeAct: ReturnType<typeof useRange>["rangeAct"];
  edit: Mutations["edit"];
  openSource: () => void;
}) {
  // what the bar's clip commands call, read when they run (they are new at every render: kept out of the effect's deps)
  const barActs = useRef({ rangeAct, edit, openSource });
  barActs.current = { rangeAct, edit, openSource };
  // the selected clip, for the command bar's `@name`: who is in it and the Inspector's own change of its cast
  const patchNow = patch.mutateAsync;
  const castRecipe = current?.recipe ? recipes?.find((r) => r.id === current.recipe) ?? null : null;
  const castNumber = current ? clips.indexOf(current) + 1 : 0;
  useEffect(() => {
    if (!current || !t) return void useSelectedClip.getState().set(null);
    useSelectedClip.getState().set({
      timeline: id, timelineName: t.name, id: current.id, number: castNumber, kind: current.kind, recipe: castRecipe,
      look: current.look ?? t.look, own: current.look !== null, setLook: (look) => patchNow({ clip: current.id, patch: { look } }),
      // its pinned frames' Mirror, for the bar's `> mirror pin`: its form as it stands, the Inspector's edits not yet saved included
      pins: pinMirrors(current, castRecipe ?? undefined, inputsOf(current), castNumber > 1 && current.joined === "continue" && current.kind === "video"),
      mirror: (input, on) => patchNow({ clip: current.id, patch: { pinMirror: { [input]: on } } }),
      // the join before it, for the bar's `> transition`: what the column's join choice reads and writes
      cutIn: castNumber <= 1 ? "none" : current.joined === "continue" ? "extends" : "cut",
      transition: current.transition?.kind ?? null,
      setTransition: (kind) => patchNow({ clip: current.id, patch: { transition: kind ? (current.transition ? { ...current.transition, kind, ms: TRANSITIONS[kind].ms } : newTransition(kind)) : null } }),
      // its menu's Slow motion and Motion transfer in windows, on the same conditions (menus.tsx)
      slow: current.kind === "video" && current.take ? (factor) => barActs.current.rangeAct.mutate({ slow: factor, inMs: current.atMs, outMs: current.atMs + current.lengthMs }) : null,
      toSource: current.kind === "video" && current.take && !current.recipe ? () => {
        const take = current.take!;
        // as the menu does it: the source sits so that what the clip plays stays where it is; the clips made from it take its place
        barActs.current.edit.mutate({ source: { asset: take.asset.id, atMs: current.atMs - take.startMs, fromMs: take.startMs, toMs: take.endMs, clip: current.id } });
        barActs.current.openSource();
      } : null,
    });
  }, [current, t, id, castNumber, castRecipe, patchNow, inputsOf]);
  useEffect(() => () => useSelectedClip.getState().set(null), []);
}
