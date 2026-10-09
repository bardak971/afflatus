import { useState } from "react";
import { X } from "lucide-react";
import type { RunningJob } from "../../api";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { about, phaseLabel } from "../../format";
import { LivePreview, StageStrip } from "../../LivePreview";
import { Bar, Button } from "../../ui";
import { useModelName } from "./modelName";

/**
 * What runs now, as one highlighted row: its live preview small, the progress and what is left, and a
 * Stop. A click on the preview opens it large (with its sound, and the workflow's own Preview nodes
 * under it), to judge a render by and stop one that is not going where it should.
 */
export function RunningCard({ running, onStop }: { running: RunningJob | null; onStop(id: string): void }) {
  const menu = useMenu<true>();
  const [large, setLarge] = useState(false);
  const modelOf = useModelName();
  if (!running) return <div className="rounded-xl border border-line px-3 py-2.5 text-sm text-ink-2">Nothing running.</div>;
  const seen = running.previewSeq > 0;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-accent/10 px-3 py-2.5 inset-ring inset-ring-accent/35" onContextMenu={(e) => menu.open(e, true)}>
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          data-stage
          aria-expanded={large}
          aria-label={large ? "Show the live preview small" : "Show the live preview large"}
          data-tip={seen ? (large ? "Show it small again" : "Show it large, with its sound") : undefined}
          disabled={!seen}
          onClick={() => setLarge(!large)}
          className="relative flex h-[54px] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised text-[10px] text-ink-3 enabled:hover:ring-2 enabled:hover:ring-accent/50"
        >
          {seen && !large ? <LivePreview job={running} className="h-full w-full object-cover" /> : seen ? "shown below" : running.kind === "export" ? "no preview" : "no preview yet"}
        </button>
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <span className="truncate text-[14.5px] font-bold" data-tip={running.label}>{running.label}</span>
          <Bar value={running.progress * 100} />
          <span className="truncate text-xs text-ink-2">
            {[
              running.kind === "load" ? `loading ${modelOf(running)}` : modelOf(running),
              phaseLabel(running.phase).toLowerCase(),
              running.steps ? `step ${running.step} of ${running.steps}` : running.kind === "export" || running.kind === "cut" ? "no GPU needed" : "",
              running.eta ? about(running.eta) : "",
            ].filter(Boolean).join(" · ")}
            {running.spilling && <span className="font-semibold text-warn-ink" data-tip="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory (a finish frees ComfyUI's models first), or ask SeedVR2 for fewer frames together."> · spilling out of VRAM, much slower than usual</span>}
          </span>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => onStop(running.id)}>Stop</Button>
      </div>
      {large && seen && (
        <div className="flex flex-col gap-2">
          {/* a clip plays with its sound */}
          <div data-stage className="flex h-[260px] items-center justify-center overflow-hidden rounded-lg bg-stage">
            <LivePreview job={running} sound className="h-full w-auto max-w-full object-contain" />
          </div>
          <StageStrip job={running} />
        </div>
      )}
      {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on the running render" head={{ title: running.label, sub: `Running · ${modelOf(running)}` }} items={[{ label: "Stop this render", icon: <X size={14} />, danger: true, run: () => onStop(running.id) }]} onClose={menu.close} />}
    </div>
  );
}
