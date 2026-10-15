import { removedName } from "@afflatus/core";
import type { Job } from "../../api";
import { useRecipes } from "../../data";
import { fileLabel, recipeLabel } from "../../format";
import { isFinish } from "./historyText";

/** What a job runs on, in a word or two: its recipe under its model's name; ffmpeg for a cut or an export (no model at all), the upscale for a finish. */
export function useModelName(): (job: Pick<Job, "kind" | "recipe" | "label" | "upscaler">) => string {
  const recipes = useRecipes();
  return (job) => {
    if (isFinish(job)) return job.upscaler ?? "finish upscale";
    if (job.kind === "cut" || job.kind === "export") return "ffmpeg";
    const r = recipes.data?.recipes.find((x) => x.id === job.recipe);
    // one of a model taken out of Afflatus by the name it had ("Wan Animate 2 (removed)"), not its id
    return r ? recipeLabel(recipes.data?.families.find((f) => f.id === r.family)?.name, r.title) : removedName(job.recipe) ?? job.recipe;
  };
}

/** The tip on a model cell: the whole name, which the column may still cut on a narrow window, then the file it loads. */
export function modelTip(name: string, file: string | null | undefined): string {
  const f = file ? fileLabel(file) : "";
  return f && f !== name ? `${name} · ${f}` : name;
}
