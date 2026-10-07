import { hiddenRunUp } from "@afflatus/core";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api, type Clip, type FinishSettings } from "../api";
import { useSettings } from "../data";
import { Dialog } from "../Dialog";
import { fileLabel } from "../format";
import { Select } from "../Select";
import { Button, ErrorNote, NumberBox, Segmented, Toggle } from "../ui";

const ROUTES: Array<{ value: FinishSettings["route"]; label: string; detail: string }> = [
  { value: "seedvr", label: "SeedVR2 (restores + enlarges)", detail: "any clip; the whole clip in view, so no flicker; compression and softness repaired too. Minutes per clip" },
  { value: "latent", label: "H3 latent re-sample", detail: "H3 clips: the draft's own latent re-sampled larger with the prompt in hand: the same motion, detail the model would have drawn, seamless joins kept. Other clips take SeedVR2" },
  { value: "rtx", label: "RTX Video Super Resolution", detail: "NVIDIA's driver: near real time, steady, modest detail. Windows and an RTX card" },
  { value: "model", label: "Pixel upscale model", detail: "an ESRGAN-type model, frame by frame: fast, sharp, may shimmer" },
];
const COLOURS = ["lab", "wavelet", "adain", "none"] as const;
const FALLBACK: FinishSettings = { route: "seedvr", factor: 2, colour: "lab", upscaleModel: "", latentDenoise: 0.2, latentSteps: 2, seedvrFrames: 0 };

/**
 * Finish all clips: every clip's selected take brought to its final quality by an upscale route, as a
 * new take each, marked as the finished version of the draft (which stays). The settings start on the
 * user's defaults (Settings), and can be saved back as them.
 */
export function FinishDialog({ timeline, clips, upscaleModels, onClose, onQueued }: {
  timeline: string;
  clips: Clip[];
  upscaleModels: string[];
  onClose(): void;
  onQueued(r: { jobs: string[]; skipped: Array<{ clip: number; why: string }> }): void;
}) {
  const settings = useSettings();
  const client = useQueryClient();
  const [v, setV] = useState<FinishSettings>(FALLBACK);
  const [redo, setRedo] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (settings.data && !loaded) {
      setV({ ...FALLBACK, ...settings.data.finish });
      setLoaded(true);
    }
  }, [settings.data, loaded]);
  const go = useMutation({ mutationFn: () => api.finishTimeline(timeline, { ...v, redo }), onSuccess: onQueued });
  const save = useMutation({ mutationFn: () => api.saveSettings({ finish: v }), onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }) });

  const videos = clips.filter((c) => c.kind === "video" && c.take && !c.job);
  const finished = videos.filter((c) => c.take?.finishedFrom);
  const todo = redo ? videos : videos.filter((c) => !c.take?.finishedFrom);
  const stills = clips.filter((c) => c.kind === "still").length;
  const h3 = videos.filter((c) => c.recipe === "h3.video").length;
  // what it should take, from this route's own past finishes: its pace × what each clip makes (its size × the factor, its frames)
  const tool = v.route === "rtx" ? "tool.finish.rtx" : v.route === "model" ? "tool.finish.model" : v.route === "seedvr" ? "tool.finish.seedvr" : null;
  const pace = useQuery({ queryKey: ["renderPace", tool], queryFn: () => api.renderPace(tool!), enabled: Boolean(tool) });
  // the frames it restores: past a continuation's hidden run-up (hiddenRunUp), which is enlarged plainly
  const workOf = (c: Clip) => { const a = c.take!.asset; return (a.width ?? 0) * v.factor * (a.height ?? 0) * v.factor * Math.max(1, (Math.max(0, (a.durationMs ?? 0) - hiddenRunUp(c.take!.headMs)) / 1000) * (a.fps ?? 24)); };
  const estimateMs = pace.data?.msPerWork ? todo.reduce((n, c) => n + workOf(c) * pace.data!.msPerWork!, 0) : null;
  return (
    <Dialog label="Finish all clips" onClose={onClose} className="flex w-full max-w-lg flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5">
        <span className="flex items-center gap-2 text-base font-semibold"><Sparkles size={16} className="text-accent" /> Finish all clips</span>
        <span className="text-ink-2">Each clip's selected take is brought to its final quality by the route below, as a new take that plays in its place. The motion stays the same; the draft stays in the takes list. One job per clip, in order.</span>
        <Select label="Route" value={v.route} onChange={(route) => setV({ ...v, route: route as FinishSettings["route"] })} options={ROUTES.map((r) => ({ value: r.value, label: r.label, detail: r.detail }))} />
        {v.route === "latent" && h3 < videos.length && <span className="text-xs text-ink-2">{videos.length - h3} of the {videos.length} clips are not H3 renders: they take SeedVR2.</span>}
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col"><span className="text-xs font-semibold">Upscale by</span><span className="text-xs text-ink-2">{v.route === "latent" ? "1.5 is light on video memory; 2 asks much more of H3's re-sample" : v.route === "seedvr" ? "2 is what SeedVR2 is tuned for; 1 restores without enlarging" : "2 is what the routes are tuned for"}</span></span>
          <NumberBox label="Upscale factor" value={v.factor} min={1} max={4} step={0.25} unit="×" onCommit={(factor) => setV({ ...v, factor })} />
        </div>
        {(v.route === "seedvr" || (v.route === "latent" && h3 < videos.length)) && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">SeedVR2 colour match</span>
            <Segmented<(typeof COLOURS)[number]> label="Colour match" value={v.colour} onChange={(colour) => setV({ ...v, colour })} options={COLOURS.map((c) => ({ value: c, label: c }))} />
            <span className="text-xs text-ink-2">the restored frames matched in colour to the originals: lab is the most faithful, wavelet keeps the new fine detail, adain is a global tint</span>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="flex flex-col"><span className="text-xs font-semibold">SeedVR2 frames together</span><span className="text-xs text-ink-2">0: by the frame's size (9 at ×2 of a 576p clip, fewer when larger). More is steadier but needs more video memory; past what the card holds it slows to a crawl</span></span>
              <NumberBox label="SeedVR2 frames together" value={v.seedvrFrames ?? 0} min={0} max={49} step={4} onCommit={(seedvrFrames) => setV({ ...v, seedvrFrames: Math.round(seedvrFrames) })} />
            </div>
          </div>
        )}
        {v.route === "latent" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col"><span className="text-xs font-semibold">Re-sample denoise</span><span className="text-xs text-ink-2">0.2 adds detail and keeps the clip; 0.25 and up invent small things (a bird, a moon); past 0.4 faces change</span></span>
              <NumberBox label="Re-sample denoise" value={v.latentDenoise} min={0.05} max={0.6} step={0.05} onCommit={(latentDenoise) => setV({ ...v, latentDenoise })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col"><span className="text-xs font-semibold">Re-sample steps</span><span className="text-xs text-ink-2">each step is a pass over the whole clip</span></span>
              <NumberBox label="Re-sample steps" value={v.latentSteps} min={1} max={6} step={1} onCommit={(latentSteps) => setV({ ...v, latentSteps: Math.round(latentSteps) })} />
            </div>
          </div>
        )}
        {v.route === "model" && (
          <Select label="Upscale model" value={v.upscaleModel} onChange={(upscaleModel) => setV({ ...v, upscaleModel })} placeholder={upscaleModels.length ? "The first found" : "No upscale model in ComfyUI"} options={[{ value: "", label: "The first found" }, ...upscaleModels.map((m) => ({ value: m, label: fileLabel(m) }))]} />
        )}
        {finished.length > 0 && <Toggle on={redo} onChange={setRedo} label={`Redo the ${finished.length} clip${finished.length > 1 ? "s" : ""} finished already`} note="off: they are skipped" />}
        <span className="text-xs text-ink-2">
          {todo.length} clip{todo.length === 1 ? "" : "s"} to finish{stills ? `; ${stills} still${stills > 1 ? "s" : ""} left as ${stills > 1 ? "they are" : "it is"}` : ""}. The finished takes arrive as the jobs land; export "At the finished size" afterwards.
          {estimateMs ? ` About ${Math.max(1, Math.round(estimateMs / 60_000))} min in all, from your past finishes with this route.` : tool && pace.isSuccess ? " No time estimate yet: this route has not run here (the first finish teaches it)." : ""}
        </span>
        {go.isError && <ErrorNote>{go.error.message}</ErrorNote>}
        {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="primary" disabled={!todo.length || go.isPending} onClick={() => go.mutate()}>Finish {todo.length} clip{todo.length === 1 ? "" : "s"}</Button>
          <Button size="sm" disabled={save.isPending} title="These settings become what the dialog starts on, in Settings." onClick={() => save.mutate()}>{save.isSuccess ? "Saved as my defaults" : "Save as my defaults"}</Button>
          <span className="grow" />
          <Button tone="quiet" onClick={onClose}>Close</Button>
        </div>
    </Dialog>
  );
}
