import { resamplesLatent } from "@afflatus/core";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api, type Clip, type FinishRedo, type FinishSettings } from "../api";
import { useRecipes, useSettings } from "../data";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields";
import { est, fileLabel, plural } from "../format";
import { Keys } from "../Keys";
import { Select } from "../Select";
import { Button, Chip, cx, ErrorNote, Help, NumberBox, Segmented, Toggle } from "../ui";
import { queryKeys } from "../queryKeys";
import { seedvrBatch } from "../snap";

const ROUTES: Array<{ value: FinishSettings["route"]; label: string; detail: string }> = [
  { value: "seedvr", label: "SeedVR2 (restores + enlarges)", detail: "any clip; the whole clip in view, so no flicker; compression and softness repaired too. Minutes per clip" },
  { value: "latent", label: "H3 latent re-sample", detail: "H3 clips: the draft's own latent re-sampled larger with the prompt in hand: the same motion, detail the model would have drawn, seamless joins kept. Other clips take SeedVR2" },
  { value: "rtx", label: "RTX Video Super Resolution", detail: "NVIDIA's driver: near real time, steady, modest detail. Windows and an RTX card" },
  { value: "model", label: "Pixel upscale model", detail: "an ESRGAN-type model, frame by frame: fast, sharp, may shimmer" },
  { value: "face", label: "Face refine (H3, SCAIL 24 fps)", detail: "H3 clips with a person's picture (the cast's, else the first reference picture), and SCAIL-2 clips at 24 fps (towards their Picture): the take's own frames, its faces redrawn closer to the picture, nothing else changed. Best on slow-moving shots. Other clips are skipped" },
];
const COLOURS = ["lab", "wavelet", "adain", "none"] as const;
const FALLBACK: FinishSettings = { route: "seedvr", factor: 2, colour: "lab", upscaleModel: "", latentDenoise: 0.15, latentSteps: 2, faceDenoise: 0.45, seedvrFrames: 0, sharpen: 0 };

/**
 * Finish all clips: every clip's selected take brought to its final quality by an upscale route, as a
 * new take each, marked as the finished version of the draft (which stays). The settings start on the
 * user's defaults (Settings), and can be saved back as them.
 */
export function FinishDialog({ timeline, clips, upscaleModels, attention, onClose, onQueued }: {
  timeline: string;
  clips: Clip[];
  upscaleModels: string[];
  /** What Needs attention lists, in one line with "Fix all first" (AttentionNote): a take with a broken join is finished as it is. */
  attention?: ReactNode;
  onClose(): void;
  onQueued(r: { jobs: string[]; skipped: Array<{ clip: number; why: string }> }): void;
}) {
  const settings = useSettings();
  const recipes = useRecipes();
  const client = useQueryClient();
  const [v, setV] = useState<FinishSettings>(FALLBACK);
  const [redo, setRedo] = useState<FinishRedo>(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (settings.data && !loaded) {
      setV({ ...FALLBACK, ...settings.data.finish });
      setLoaded(true);
    }
  }, [settings.data, loaded]);
  const go = useMutation({ mutationFn: () => api.finishTimeline(timeline, { ...v, redo }), onSuccess: onQueued });
  const save = useMutation({ mutationFn: () => api.saveSettings({ finish: v }), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings() }) });

  const videos = clips.filter((c) => c.kind === "video" && c.take && !c.job);
  const finished = videos.filter((c) => c.take?.finishedFrom);
  const todo = redo ? videos : videos.filter((c) => !c.take?.finishedFrom);
  const stills = clips.filter((c) => c.kind === "still").length;
  // the clips whose model re-samples its own latent (H3's, or a workflow that offers it); the others take SeedVR2 on that route
  const resampled = videos.filter((c) => resamplesLatent(recipes.data?.recipes.find((r) => r.id === c.recipe))).length;
  // the clips whose model offers Face refine (it says so in its traits: H3's five forms): the others are skipped on that route
  const recipeOf = (c: Clip) => recipes.data?.recipes.find((r) => r.id === c.recipe);
  const refined = videos.filter((c) => Boolean(recipeOf(c)?.traits?.faceRefine)).length;
  // what each model's clips take on this route, one row a family (the mock's Finish across models): read from each model's
  // own description, so a new model adds its row and nothing else changes
  const rows = (() => {
    const by = new Map<string, { name: string; clips: number[]; latent: boolean; face: boolean }>();
    for (const c of videos) {
      const r = recipeOf(c);
      const family = r?.family ?? "imported";
      const row = by.get(family) ?? { name: recipes.data?.families.find((f) => f.id === family)?.name ?? "Imported video", clips: [], latent: resamplesLatent(r), face: Boolean(r?.traits?.faceRefine) };
      row.clips.push(clips.indexOf(c) + 1);
      by.set(family, row);
    }
    const pixel = v.route === "rtx" ? "RTX VSR" : v.route === "model" ? "a pixel model" : "SeedVR2";
    return [...by.values()].map((row) => ({
      ...row,
      route: v.route === "face" ? (row.face ? "Face refine" : "left as it is") : v.route === "latent" && row.latent ? `latent re-sample${v.face && row.face ? " + Face refine" : ""}` : v.face && row.face ? `Face refine, then ${pixel}` : pixel,
    }));
  })();
  // what it should take, worked out by the server as the waiting list will show it job by job (finishForecast)
  const forecast = useQuery({
    queryKey: queryKeys.finishForecast.of(timeline, v, redo, todo.map((c) => c.take?.id).join()),
    queryFn: () => api.finishForecast(timeline, { ...v, redo }),
    enabled: loaded && todo.length > 0,
  });
  const estimateMs = forecast.data?.ms ?? null;
  return (
    // wider than the kit's card: its subtitle, its labels and the foot's three buttons each on one line
    <Dialog label="Finish all clips" onClose={onClose} className={cx(DIALOG, "max-w-xl")}>
        <DialogHead icon={<Sparkles size={16} />} title="Finish all clips" sub={<span className="flex items-center gap-1.5">Each clip's take to its final quality · one job per clip, in order<Help title="Finish all clips" text={`Each finished take plays in place of its draft, with the same motion (the draft stays in the takes list); export "At the finished size" afterwards.`} /></span>} onClose={onClose} />
        <div className="flex flex-wrap gap-1.5">
          <Chip tone="accent">{plural(todo.length, "clip")} to finish</Chip>
          {stills > 0 && <Chip>{plural(stills, "still")} left as {stills > 1 ? "they are" : "it is"}</Chip>}
          {v.route === "face" && refined < videos.length && <Chip tone="warn" tip="Face refine redraws the faces of H3 clips and of SCAIL-2 clips at 24 fps: the other clips are left as they are.">{videos.length - refined} of {videos.length} skipped</Chip>}
          {v.route === "latent" && resampled < videos.length && <Chip tone="warn" tip="Only a model that offers the latent re-sample (H3) is re-sampled in the latent; the other clips take SeedVR2.">{videos.length - resampled} of {videos.length} not re-sampled: SeedVR2</Chip>}
          {v.route === "latent" && v.face && refined > 0 && <Chip tip="Their faces redrawn closer to the person's picture after the re-sample, in the same job.">Face refine on {plural(refined, "clip")}</Chip>}
          {v.route !== "latent" && v.route !== "face" && v.face && refined > 0 && <Chip tip="Their faces redrawn first, then the upscale on what it made: two jobs a clip.">Face refine first on {plural(refined, "clip")}</Chip>}
        </div>
        {attention}
        <div className="flex flex-col">
          <FieldRow label="Route" note={ROUTES.find((r) => r.value === v.route)?.detail}>
            <Select label="Route" value={v.route} onChange={(route) => setV({ ...v, route: route as FinishSettings["route"] })} options={ROUTES.map((r) => ({ value: r.value, label: r.label, detail: r.detail }))} />
          </FieldRow>
          {v.route !== "face" && <FieldRow label="Upscale by" note={v.route === "latent" ? "1.5 is light on video memory; 2 asks much more of H3's re-sample" : v.route === "seedvr" ? "2 is what SeedVR2 is tuned for; 1 restores without enlarging" : "2 is what the routes are tuned for"} trail>
            <NumberBox label="Upscale factor" value={v.factor} min={1} max={4} step={0.25} unit="×" onCommit={(factor) => setV({ ...v, factor })} />
          </FieldRow>}
          {v.route === "face" && (
            <FieldRow label="Denoise" note="On the smallest faces (30 px and under); a face of 120 px and more gets a third of it. More is closer to the picture and further from the take. H3 clips; a SCAIL-2 clip keeps its own (0.35 unless its form said otherwise)" trail>
              <NumberBox label="Face refine denoise" value={v.faceDenoise ?? 0.45} min={0.3} max={0.6} step={0.05} onCommit={(faceDenoise) => setV({ ...v, faceDenoise })} />
            </FieldRow>
          )}
          {(v.route === "seedvr" || (v.route === "latent" && resampled < videos.length)) && (
            <>
              <FieldRow label="Colour match" note="SeedVR2's restored frames matched in colour to the originals: lab is the most faithful, wavelet keeps the new fine detail, adain is a global tint">
                <Segmented<(typeof COLOURS)[number]> label="Colour match" value={v.colour} onChange={(colour) => setV({ ...v, colour })} options={COLOURS.map((c) => ({ value: c, label: c }))} />
              </FieldRow>
              <FieldRow label="Batch size" note="SeedVR2's batch size: how many frames it restores together. 0 is auto: by the frame's size (9 at ×2 of a 576p clip, fewer when larger). More is steadier but needs more video memory; past what the card holds it slows to a crawl" trail>
                {/* 0 said as what it does, beside the box: a bare 0 read as off */}
                <span className="flex items-center gap-2">
                  <NumberBox label="SeedVR2 batch size (0 is auto)" value={v.seedvrFrames ?? 0} min={0} max={49} step={1} onCommit={(n) => setV({ ...v, seedvrFrames: seedvrBatch(n) })} />
                  <span className="text-xs text-ink-3">{v.seedvrFrames ? "frames" : "auto, by the frame's size"}</span>
                </span>
              </FieldRow>
            </>
          )}
          {/* what each model's clips take, a row a family: the timeline mixes models (H3, SCAIL-2, LTX) */}
          {rows.length > 1 && (
            <FieldRow label="By model" note="What each model's clips take on this route">
              <span className="flex flex-col gap-0.5 text-xs">
                {rows.map((row) => (
                  <span key={row.name}><span className="font-semibold">{row.name}</span> <span className="text-ink-3">· {plural(row.clips.length, "clip")}{row.clips.length <= 3 ? `: ${row.clips.join(", ")}` : ""}</span> · {row.route}</span>
                ))}
              </span>
            </FieldRow>
          )}
          {v.route !== "face" && refined > 0 && (
            <FieldRow label="Face refine" note={v.route === "latent"
              ? `The faces of the ${plural(refined, "clip")} whose model offers it redrawn closer to the person's picture (the cast's, else the first reference picture), after the re-sample, in the same job. Best on slow-moving shots`
              : `The faces of the ${plural(refined, "clip")} whose model offers it redrawn closer to the person's picture first, from the draft's kept latent, then the upscale on what it made: two jobs a clip. Best on slow-moving shots`} trail>
              <Toggle bare on={Boolean(v.face)} onChange={(face) => setV({ ...v, face })} label={v.route === "latent" ? "Face refine after the re-sample" : "Face refine before the upscale"} />
            </FieldRow>
          )}
          {v.route !== "face" && v.face && refined > 0 && (
            <FieldRow label="Face denoise" note="On the smallest faces (30 px and under); a face of 120 px and more gets a third of it" trail>
              <NumberBox label="Face refine denoise" value={v.faceDenoise ?? 0.45} min={0.3} max={0.6} step={0.05} onCommit={(faceDenoise) => setV({ ...v, faceDenoise })} />
            </FieldRow>
          )}
          {v.route === "latent" && (
            <>
              <FieldRow label="Denoise" note="Re-sample denoise. 0.2 adds detail and keeps the clip; 0.25 and up invent small things (a bird, a moon); past 0.4 faces change" trail>
                <NumberBox label="Re-sample denoise" value={v.latentDenoise} min={0.05} max={0.6} step={0.01} onCommit={(latentDenoise) => setV({ ...v, latentDenoise })} />
              </FieldRow>
              <FieldRow label="Steps" note="Re-sample steps: each step is a pass over the whole clip" trail>
                <NumberBox label="Re-sample steps" value={v.latentSteps} min={1} max={6} step={1} onCommit={(latentSteps) => setV({ ...v, latentSteps: Math.round(latentSteps) })} />
              </FieldRow>
            </>
          )}
          {v.route === "model" && (
            <FieldRow label="Upscale model">
              <Select label="Upscale model" value={v.upscaleModel} onChange={(upscaleModel) => setV({ ...v, upscaleModel })} placeholder={upscaleModels.length ? "The first found" : "No upscale model in ComfyUI"} options={[{ value: "", label: "The first found" }, ...upscaleModels.map((m) => ({ value: m, label: fileLabel(m) }))]} />
            </FieldRow>
          )}
          {/* every route but H3's own re-sample runs a pixel route, after which RCAS can go (the re-sample samples real detail) */}
          {v.route !== "face" && (v.route !== "latent" || resampled < videos.length) && (
            <FieldRow label="Sharpen" note="RCAS (AMD FSR's contrast-adaptive sharpen) on the finished frames: crisps the edges an upscale leaves soft, without a plain sharpen's halos. 0.3 is a usual amount; 0 is off. Needs KJNodes" trail>
              <NumberBox label="Sharpen (RCAS)" value={v.sharpen ?? 0} min={0} max={1} step={0.05} onCommit={(sharpen) => setV({ ...v, sharpen })} />
            </FieldRow>
          )}
          {finished.length > 0 && (
            <FieldRow label="Redo finished" note={`The ${plural(finished.length, "clip")} finished already. Changed: only those finished with other settings than these, or whose clip changed since`}>
              <Segmented<"no" | "changed" | "all"> label="Redo finished" value={redo === "changed" ? "changed" : redo ? "all" : "no"} onChange={(r) => setRedo(r === "changed" ? "changed" : r === "all")} options={[{ value: "no", label: "No" }, { value: "changed", label: "Changed" }, { value: "all", label: "All" }]} />
            </FieldRow>
          )}
        </div>
        {go.isError && <ErrorNote>{go.error.message}</ErrorNote>}
        {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        {/* the estimate on its own line over the foot, so the foot's buttons keep one row; held while it is worked out, so nothing jumps */}
        {todo.length > 0 && (
          <span className="-mb-1.5 min-h-4 self-end text-xs text-ink-3">
            {estimateMs ? <span data-tip="From your past finishes with this route.">{est(estimateMs)} in all</span> : forecast.isSuccess ? <span data-tip="This route has not run here: the first finish teaches it.">No time estimate yet</span> : forecast.isError ? null : "Working out the time…"}
          </span>
        )}
        <DialogFoot>
          <Button tone="quiet" onClick={onClose}>Close <Keys keys="Esc" size="sm" /></Button>
          <Button disabled={save.isPending} data-tip="These settings become what the dialog starts on, in Settings." onClick={() => save.mutate()}>{save.isSuccess ? "Saved as my defaults" : "Save as my defaults"}</Button>
          <Button tone="primary" disabled={!todo.length || go.isPending} onClick={() => go.mutate()}>{redo === "changed" && finished.length ? `Finish up to ${plural(todo.length, "clip")}` : `Finish ${plural(todo.length, "clip")}`}</Button>
        </DialogFoot>
    </Dialog>
  );
}
