import type { ComponentProps } from "react";
import type { ExportDialog } from "./ExportDialog";
import type { FinishDialog } from "./Finish";
import { AttentionNote } from "./Overview";
import type { LoadedEditor } from "./useTimelineEditor";
import { plural } from "../format";

// What the Export and Finish dialogs are drawn with (the editor's `finish`, its mutations in `actions`).

export function exportProps(e: LoadedEditor, exp: NonNullable<LoadedEditor["finish"]["exp"]>): ComponentProps<typeof ExportDialog> {
  const { t, clips } = e;
  return {
    timeline: t,
    clips,
    ask: exp,
    onChange: e.finish.setExp,
    range: e.range,
    emptyRange: e.emptyRange,
    finishedSize: e.finish.finishedSize,
    misfits: e.finish.misfits,
    exporting: e.actions.exportIt.isPending,
    attention: <AttentionNote timeline={t} clips={clips} {...e.checks} onFixFirst={(plan) => e.finish.fixFirst(plan, () => e.finish.setExp(null))} />,
    onExport: (v) => e.actions.exportIt.mutate(v),
    onFinishFirst: () => {
      e.finish.setExp(null);
      e.finish.setFin(true);
    },
    onOpen: e.setOpened,
    onClose: () => e.finish.setExp(null),
  };
}

export function finishProps(e: LoadedEditor): ComponentProps<typeof FinishDialog> {
  const { t, clips, setNote } = e;
  return {
    timeline: e.id,
    clips,
    // ComfyUI's upscale_models, as any recipe with an upscale model to pick lists them
    upscaleModels: e.setup.data?.recipes.find((r) => r.options.upscaleModel?.length)?.options.upscaleModel ?? [],
    // and the files the H3 forms' Face refine and latent upscaler, and the SeedVR2 route, offer (card #159)
    models: {
      face: e.setup.data?.recipes.find((r) => r.id === "h3.video")?.options.faceRefineModel ?? [],
      latent: e.setup.data?.recipes.find((r) => r.id === "h3.video")?.options.upscaleLatentModel ?? [],
      seedvr: e.setup.data?.recipes.find((r) => r.options.seedvrModel?.length)?.options.seedvrModel ?? [],
    },
    attention: <AttentionNote timeline={t} clips={clips} {...e.checks} onFixFirst={(plan) => e.finish.fixFirst(plan, () => e.finish.setFin(false))} />,
    onClose: () => e.finish.setFin(false),
    onQueued: (r) => {
      e.actions.after();
      e.finish.setFin(false);
      setNote(`${plural(r.jobs.length, "finish job")} in the queue${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, `One job a clip (two with Face refine before an upscale); the finished takes arrive as they land.${r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `clip ${x.clip} (${x.why})`).join(", ")}.` : ""}`);
    },
  };
}
