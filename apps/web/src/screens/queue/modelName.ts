import type { Job } from "../../api";
import { useRecipes } from "../../data";
import { recipeLabel } from "../../format";
import { isFinish } from "./historyText";

/** What a job runs on, in a word or two: its recipe under its model's name; ffmpeg for a cut or an export (no model at all), the upscale for a finish. */
export function useModelName(): (job: Pick<Job, "kind" | "recipe" | "label" | "upscaler">) => string {
  const recipes = useRecipes();
  return (job) => {
    if (isFinish(job)) return job.upscaler ?? "finish upscale";
    if (job.kind === "cut" || job.kind === "export") return "ffmpeg";
    const r = recipes.data?.recipes.find((x) => x.id === job.recipe);
    return r ? recipeLabel(recipes.data?.families.find((f) => f.id === r.family)?.name, r.title) : job.recipe;
  };
}
