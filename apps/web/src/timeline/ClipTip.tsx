import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { api, type Clip } from "../api";


/**
 * What a clip is, read without opening it: shown after the pointer has rested on the clip for a second.
 * Only what decides something: its length and how long it took, how it joins the clip before (and how much
 * the picture catches there), which take plays, its size, and anything that needs attention. The prompt,
 * the seed and the files stay in the Inspector.
 */
export function ClipTip({ clip, index, clips, at }: {
  clip: Clip;
  /** Its number on the track, from 0. */
  index: number;
  clips: Clip[];
  /** Where to draw it: under the clip, at this left edge (viewport pixels). */
  at: { left: number; top: number };
}) {
  const take = clip.take;
  const planned = clip.kind === "video" && !take;
  // how much the picture jumps where this clip meets the one before: measured once the takes are there
  const joins = useQuery({
    queryKey: ["joins", clip.id, clip.takes.map((t) => `${t.id}:${t.startMs}:${t.endMs}`).join(","), clips[index - 1]?.take?.id ?? clips[index - 1]?.still?.id ?? "-", clips[index + 1]?.take?.id ?? clips[index + 1]?.still?.id ?? "-"],
    queryFn: () => api.joins(clip.id),
    enabled: Boolean(take) && index > 0 && clip.joined === "continue",
    staleTime: 60_000,
  });
  const jump = joins.data?.items.find((j) => j.take === take?.id)?.in ?? null;

  const lines: Array<{ text: string; tone?: "warn" | "dim" }> = [];
  if (clip.kind === "still") {
    lines.push({ text: `Still · ${seconds(clip.lengthMs)}` });
  } else if (planned) {
    lines.push({ text: clip.failed ? "The render failed" : "Not rendered yet", tone: clip.failed ? "warn" : "dim" });
  } else if (take) {
    const took = take.renderMs ? ` · rendered in ${spell(take.renderMs)}` : clip.recipe ? "" : " · imported";
    lines.push({ text: `${seconds(clip.lengthMs)}${took}` });
    if (index > 0) {
      const kind = take.joinKind === "latent" ? "Latent join" : take.joinKind === "hybrid" ? "Frames + latent join" : take.joinKind === "pixels" ? "Pixel join" : clip.joined === "continue" ? `Extends clip ${index}` : "Cut";
      const figure = clip.joined === "continue" && jump !== null ? ` · ×${jump.toFixed(1)}` : "";
      // a join made in the latent: how wide its run-up came out against the latent it was guided by (1.00 = the same)
      const width = take.measure?.drift ? ` · run-up ×${take.measure.drift.width.toFixed(2)}` : "";
      lines.push({ text: `${kind}${figure}${width}`, tone: clip.joined === "continue" ? undefined : "dim" });
      // how far the picture has slid along this run of clips that flow on: against the run's first clip,
      // measured on the real frames when each was rendered. A chain continued from exact latents drifts
      // darker and softer clip after clip; a few per cent is the model's own variation
      if (take.measure && clip.joined === "continue") {
        let k = index;
        while (k > 0 && clips[k]!.joined === "continue") k--;
        const first = clips[k]?.take?.measure;
        if (first && k < index) {
          const luma = (take.measure.luma - first.luma) / Math.max(1, first.luma);
          const sharp = (take.measure.sharp - first.sharp) / Math.max(0.01, first.sharp);
          const pct = (x: number) => `${x < 0 ? "−" : "+"}${Math.round(Math.abs(x) * 100)} %`;
          lines.push({ text: `Since clip ${k + 1}: brightness ${pct(luma)}, sharpness ${pct(sharp)}`, tone: luma < -0.08 || sharp < -0.15 ? "warn" : "dim" });
        }
      }
    }
    const n = clip.takes.findIndex((t) => t.id === take.id) + 1;
    const draft = take.finishedFrom ? clip.takes.find((t) => t.id === take.finishedFrom) : undefined;
    const by = draft?.asset.width && take.asset.width ? Math.round((take.asset.width / draft.asset.width) * 10) / 10 : null;
    const up = take.finishedFrom ? `upscaled${by && by !== 1 ? ` ×${by}` : ""}` : "";
    if (clip.takes.length > 1 || up) lines.push({ text: [clip.takes.length > 1 ? `Take ${n} of ${clip.takes.length}` : "", up].filter(Boolean).join(" · ") });
    if (take.asset.width && take.asset.height) lines.push({ text: `${take.asset.width} × ${take.asset.height}${take.asset.fps ? ` · ${Math.round(take.asset.fps)} fps` : ""}`, tone: "dim" });
    if (take.trimStartMs > 0 || take.trimEndMs > 0) {
      lines.push({ text: `Trimmed${take.trimStartMs > 0 ? ` ${seconds(take.trimStartMs)} at the start` : ""}${take.trimStartMs > 0 && take.trimEndMs > 0 ? "," : ""}${take.trimEndMs > 0 ? ` ${seconds(take.trimEndMs)} at the end` : ""}`, tone: "dim" });
    }
  }
  if (clip.job) lines.push({ text: clip.job.status === "running" ? "Rendering now" : "Queued for a render", tone: "dim" });
  if (clip.join === "stale") lines.push({ text: `Join stale: clip ${index} changed since`, tone: "warn" });
  if (!lines.length) return null;

  const left = Math.max(8, Math.min(at.left, window.innerWidth - 248));
  return createPortal(
    <div role="tooltip" className="pointer-events-none fixed z-50 flex w-60 flex-col gap-0.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs shadow-lg" style={{ left, top: at.top + 6 }}>
      {lines.map((l, i) => (
        <span key={i} className={l.tone === "warn" ? "text-warn-ink" : l.tone === "dim" ? "text-ink-2" : i === 0 ? "font-semibold text-ink" : "text-ink"}>{l.text}</span>
      ))}
    </div>,
    document.body,
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** A time that was measured, said plainly: "48 s", "2 min 10 s", "1 h 05 min". */
function spell(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}
