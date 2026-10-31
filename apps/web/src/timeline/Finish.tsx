import { OWN_MODEL, resamplesLatent, UPSCALE_ROUTE_WORDS, type InputSpec } from "@afflatus/core";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api, type Clip, type FinishRedo, type FinishSettings } from "../api";
import { useRecipes, useSettings } from "../data";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { Field, FieldRow } from "../fields";
import { est, fileLabel, plural } from "../format";
import { Select } from "../Select";
import { Button, Chip, cx, Failed, Help, NumberBox, Segmented, Toggle } from "../ui";
import { queryKeys } from "../queryKeys";
import { seedvrBatch } from "../snap";

// the same names, order and lines as a video form's Upscale list (card #172), then Face refine, which only Finish offers as a route
const ROUTES: Array<{ value: FinishSettings["route"]; label: string; detail: string }> = [
  { value: "seedvr", ...UPSCALE_ROUTE_WORDS.seedvr },
  { value: "latent", label: UPSCALE_ROUTE_WORDS.latent.label, detail: `${UPSCALE_ROUTE_WORDS.latent.detail}. A model that does not offer it (H3 does) takes SeedVR2` },
  { value: "rtx", ...UPSCALE_ROUTE_WORDS.rtx },
  { value: "model", ...UPSCALE_ROUTE_WORDS.model },
  { value: "face", label: "Face refine", detail: "the take's faces redrawn closer to the person's picture, nothing else changed: H3 and LTX 2.5 clips, SCAIL-2 at 24 fps; the others are skipped" },
];
/** SeedVR2's batch size as the form's own field draws it: "auto" at the left end, never a bare 0 read as off. */
const SEEDVR_BATCH: InputSpec = {
  id: "seedvrFrames", type: "number", label: "SeedVR2 batch size", min: 1, max: 49, step: 4, default: 0, auto: "auto",
  note: "batch_size: frames restored together (1, 5, 9…), each seeing the others. Wider is steadier, with fewer joins; auto (the left end) takes 49 on the 7B where it fits",
};
const COLOURS = ["lab", "wavelet", "adain", "none"] as const;
// a strong denoise at the model's shift: on H3 the whole range starts near 0.84–0.96 of real noise, so a step of 0.05 changes little
const FACE_DENOISE_NOTE = "denoise at the model's shift: full on faces of 30 px and under, a third at 120 px and up. Higher is closer to the picture, further from the take. A SCAIL-2 clip keeps its own";
const FALLBACK: FinishSettings = { route: "seedvr", factor: 2, colour: "lab", upscaleModel: "", latentNoise: 0.35, latentSteps: 3, faceDenoise: 0.45, seedvrFrames: 0, sharpen: 0 };

/**
 * Finish all clips: every clip's selected take brought to its final quality by an upscale route, as a
 * new take each, marked as the finished version of the draft (which stays). The settings start on the
 * user's defaults (Settings), and can be saved back as them.
 */
export function FinishDialog({ timeline, clips, upscaleModels, models = { face: [], latent: [], seedvr: [] }, attention, onClose, onQueued }: {
  timeline: string;
  clips: Clip[];
  upscaleModels: string[];
  /** The files offered for Face refine (with the clip's own model among them), H3's latent upscaler and SeedVR2 (card #159). */
  models?: { face: string[]; latent: string[]; seedvr: string[] };
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
    const pixel = v.route === "rtx" ? "RTX VSR" : v.route === "model" ? "an upscale model" : "SeedVR2";
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
          {v.route === "face" && refined < videos.length && <Chip tone="warn" tip="Face refine redraws the faces of H3 clips, LTX 2.5 clips and SCAIL-2 clips at 24 fps: the other clips are left as they are.">{videos.length - refined} of {videos.length} skipped</Chip>}
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
            <NumberBox label="Upscale by" value={v.factor} min={1} max={4} step={0.25} unit="×" onCommit={(factor) => setV({ ...v, factor })} />
          </FieldRow>}
          {v.route === "face" && (
            <FieldRow label="Face refine denoise" note={FACE_DENOISE_NOTE} trail>
              <NumberBox label="Face refine denoise" value={v.faceDenoise ?? 0.45} min={0.3} max={0.6} step={0.05} onCommit={(faceDenoise) => setV({ ...v, faceDenoise })} />
            </FieldRow>
          )}
          {(v.route === "seedvr" || (v.route === "latent" && resampled < videos.length)) && (
            <>
              <FieldRow label="SeedVR2 model" note="The 3B (fast) or the 7B (sharper, slower, steadier over its wider window); its VAE is the same">
                <Select label="SeedVR2 model" value={v.seedvrModel ?? ""} onChange={(seedvrModel) => setV({ ...v, seedvrModel })} options={[{ value: "", label: "Default (Settings › Models)" }, ...models.seedvr.map((m) => ({ value: m, label: fileLabel(m) }))]} />
              </FieldRow>
              <FieldRow label="SeedVR2 colour match" note="the restored frames matched in colour to the originals: lab the most faithful, wavelet keeps the new fine detail, adain a global tint">
                <Segmented<(typeof COLOURS)[number]> label="SeedVR2 colour match" value={v.colour} onChange={(colour) => setV({ ...v, colour })} options={COLOURS.map((c) => ({ value: c, label: c }))} />
              </FieldRow>
              <Field spec={SEEDVR_BATCH} options={undefined} value={v.seedvrFrames ?? 0} onChange={(n) => setV({ ...v, seedvrFrames: seedvrBatch(Number(n)) })} />
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
            <FieldRow label="Face refine denoise" note={FACE_DENOISE_NOTE} trail>
              <NumberBox label="Face refine denoise" value={v.faceDenoise ?? 0.45} min={0.3} max={0.6} step={0.05} onCommit={(faceDenoise) => setV({ ...v, faceDenoise })} />
            </FieldRow>
          )}
          {(v.route === "face" || v.face) && refined > 0 && (
            <FieldRow label="Face refine model" note={`As each clip's form: the one its form says. ${OWN_MODEL}: the clip's model, nothing more loaded; another file is a second model in RAM. On SCAIL-2 and LTX 2.5, whose model is not H3's, ${OWN_MODEL} is the fused turbo`}>
              <Select label="Face refine model" value={v.faceModel ?? ""} onChange={(faceModel) => setV({ ...v, faceModel })} options={[{ value: "", label: "As each clip's form" }, ...(models.face.includes(OWN_MODEL) ? [{ value: OWN_MODEL, label: OWN_MODEL }] : []), ...models.face.filter((m) => m !== OWN_MODEL).map((m) => ({ value: m, label: fileLabel(m) }))]} />
            </FieldRow>
          )}
          {v.route === "latent" && resampled > 0 && (
            <FieldRow label="Latent upscaler" note="from models/latent_upscale_models; the re-sample after it runs on each clip's own model">
              <Select label="Latent upscaler" value={v.latentModel ?? ""} onChange={(latentModel) => setV({ ...v, latentModel })} options={[{ value: "", label: "Default (Settings › Models)" }, ...models.latent.map((m) => ({ value: m, label: fileLabel(m) }))]} />
            </FieldRow>
          )}
          {v.route === "latent" && (
            <>
              <FieldRow label="Re-sample denoise" note="the σ the re-sample starts at, whatever the shift (0.35 = 35 % noise). Higher redraws more, and faces drift from the draft" trail>
                <NumberBox label="Re-sample denoise" value={v.latentNoise} min={0.05} max={0.95} step={0.01} onCommit={(latentNoise) => setV({ ...v, latentNoise })} />
              </FieldRow>
              <FieldRow label="Re-sample steps" note="from its denoise down to 0 (karras); each step is a pass over the whole clip" trail>
                <NumberBox label="Re-sample steps" value={v.latentSteps} min={1} max={6} step={1} onCommit={(latentSteps) => setV({ ...v, latentSteps: Math.round(latentSteps) })} />
              </FieldRow>
            </>
          )}
          {v.route === "model" && (
            <FieldRow label="Upscaler" note="from models/upscale_models">
              <Select label="Upscaler" value={v.upscaleModel} onChange={(upscaleModel) => setV({ ...v, upscaleModel })} placeholder={upscaleModels.length ? "The first found" : "No upscale model in ComfyUI"} options={[{ value: "", label: "The first found" }, ...upscaleModels.map((m) => ({ value: m, label: fileLabel(m) }))]} />
            </FieldRow>
          )}
          {/* every route but H3's own re-sample runs a pixel route, after which RCAS can go (the re-sample samples real detail) */}
          {v.route !== "face" && (v.route !== "latent" || resampled < videos.length) && (
            <FieldRow label="RCAS sharpen" note="AMD FSR's contrast-adaptive sharpen (KJNodes) on the finished frames, without a plain sharpen's halos. 0.3 is usual; 0 = off" trail>
              <NumberBox label="RCAS sharpen" value={v.sharpen ?? 0} min={0} max={1} step={0.05} onCommit={(sharpen) => setV({ ...v, sharpen })} />
            </FieldRow>
          )}
          {finished.length > 0 && (
            <FieldRow label="Redo finished" note={`The ${plural(finished.length, "clip")} finished already. Changed: only those finished with other settings than these, or whose clip changed since`}>
              <Segmented<"no" | "changed" | "all"> label="Redo finished" value={redo === "changed" ? "changed" : redo ? "all" : "no"} onChange={(r) => setRedo(r === "changed" ? "changed" : r === "all")} options={[{ value: "no", label: "No" }, { value: "changed", label: "Changed" }, { value: "all", label: "All" }]} />
            </FieldRow>
          )}
        </div>
        {go.isError && <Failed what="Not finished" error={go.error} />}
        {save.isError && <Failed what="Not saved" error={save.error} />}
        {/* the estimate on its own line over the foot, so the foot's buttons keep one row; held while it is worked out, so nothing jumps */}
        {todo.length > 0 && (
          <span className="-mb-1.5 min-h-4 self-end text-xs text-ink-3">
            {estimateMs ? <span data-tip="From your past finishes with this route.">{est(estimateMs)} in all</span> : forecast.isSuccess ? <span data-tip="This route has not run here: the first finish teaches it.">No time estimate yet</span> : forecast.isError ? null : "Working out the time…"}
          </span>
        )}
        <DialogFoot>
          <Button disabled={save.isPending} data-tip="These settings become what the dialog starts on, in Settings." onClick={() => save.mutate()}>{save.isSuccess ? "Saved as my defaults" : "Save as my defaults"}</Button>
          <Button tone="primary" disabled={!todo.length || go.isPending} onClick={() => go.mutate()}>{redo === "changed" && finished.length ? `Finish up to ${plural(todo.length, "clip")}` : `Finish ${plural(todo.length, "clip")}`}</Button>
        </DialogFoot>
    </Dialog>
  );
}
