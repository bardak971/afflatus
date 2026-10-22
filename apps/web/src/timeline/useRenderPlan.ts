import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type Clip, type MachineState, type RecipeInfo, type Timeline } from "../api";
import { queryKeys } from "../queryKeys";
import { timelineKey } from "../draftMachine";
import { usePickedMachine } from "../GenerateOn";
import type { Checks } from "./EditorColumns";
import type { useClipEdits } from "./useClipEdits";
import { useForecasts } from "./useForecasts";

type Edits = ReturnType<typeof useClipEdits>;

/**
 * What is left to render on a timeline and what rendering it takes (useTimelineEditor): the clips left, the ones picked
 * that can render, each clip's forecast on the machine picked, all of them on each machine, and what Needs attention is
 * worked out from.
 */
export function useRenderPlan({ id, t, clips, picked, recipes, ready, formOf, known }: {
  id: string;
  t: Timeline | undefined;
  clips: Clip[];
  picked: ReadonlySet<string>;
  recipes: RecipeInfo[];
  ready: Edits["ready"];
  formOf: Edits["formOf"];
  /** The lists the checks read are settled (recipes, setup, model settings). */
  known: boolean;
}) {
  /** What is left to render: clips without a take, clips whose join went stale, and clips whose take was made with other flips than Mirror asks now. */
  const missing = clips.filter((c) => c.kind === "video" && !c.job && (!c.take || c.join === "stale" || c.mirrorChanged) && ready(c).input);
  const renderable = (c: Clip) => picked.has(c.id) && c.kind === "video" && Boolean(ready(c).input);

  /** About how long a clip takes to render on a machine (null: Auto): the server's forecast of its whole form, learned from past renders (as the timeline card's). */
  const { takesOn, canOn } = useForecasts(clips, recipes, formOf);
  // on the machine picked for this timeline, as that machine's own renders say it; Auto: the machine that renders it soonest
  const pickedMachine = usePickedMachine(timelineKey(id));
  const takes = (c: Clip) => takesOn(c, pickedMachine);
  // on Auto, the server's plan of them all (queue.total): shared between the machines, each loading its model once. Added
  // up one after another, 3 H3 clips said ~7 min where 3 machines take ~4
  const missingAt = missing.map((c) => clips.indexOf(c) + 1);
  const plannedAll = useQuery({
    queryKey: queryKeys.timelinePlanned(id, missingAt, t?.updatedAt ?? ""),
    queryFn: ({ signal }) => api.commandEstimate({ timeline: id, clips: missingAt }, { signal }),
    enabled: Boolean(id && missingAt.length),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  /** What rendering every clip left to render takes on a machine (null: Auto), as Render all and its machine list say it. */
  const allOn = (m: MachineState | null) => (m === null && plannedAll.data?.ms ? plannedAll.data.ms : missing.reduce((sum, c) => sum + (takesOn(c, m) ?? 0), 0));
  /** Why a machine cannot take the clips left to render: one of them it cannot render (its files not there). */
  const allBlocked = (m: MachineState) => (missing.some((c) => !canOn(c, m)) ? "lacks a model of these clips" : null);
  const allMs = allOn(pickedMachine ?? null);
  /** What Needs attention is worked out from (EditorColumns' Checks). */
  const checks: Checks = {
    renderable: (c: Clip) => c.kind === "video" && !c.job && Boolean(ready(c).input),
    msOf: takes,
    // the header's own plan, so that the same clips read the same time in Needs attention and Fix all
    plan: { auto: !pickedMachine, ids: missing.map((c) => c.id), ms: plannedAll.data?.ms ?? 0 },
    why: (c: Clip) => (c.kind === "video" ? ready(c).why : undefined),
    voiceless: (c: Clip) => c.kind === "video" && Boolean(ready(c).voice),
    // settled, not succeeded: a list that failed to come must not hold the checks back for ever
    known,
  };
  return { missing, renderable, takes, takesOn, allMs, allOn, allBlocked, checks };
}
