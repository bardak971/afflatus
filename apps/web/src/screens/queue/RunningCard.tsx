import { X } from "lucide-react";
import type { RunningJob } from "../../api";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { about, phaseLabel } from "../../format";
import { LivePreview, StageStrip } from "../../LivePreview";
import { Bar, Button, SectionTitle } from "../../ui";

/** What runs now: its preview, large enough to judge a render by and to stop one that is not going where it should. */
export function RunningCard({ running, onStop }: { running: RunningJob | null; onStop(id: string): void }) {
  const menu = useMenu<true>();
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{running?.kind === "export" ? "Exporting" : running?.kind === "load" ? "Loading model" : "Running"}</SectionTitle>
      {running ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-panel p-3" onContextMenu={(e) => menu.open(e, true)}>
          {/* a clip plays with its sound */}
          <div data-stage className="flex h-[260px] items-center justify-center overflow-hidden rounded-lg bg-raised text-[11px] text-ink-2">
            {running.previewSeq > 0 ? <LivePreview job={running} sound className="h-full w-auto max-w-full object-contain" /> : running.kind === "export" ? "no preview" : "no preview yet"}
          </div>
          <StageStrip job={running} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="truncate text-[15px] font-semibold">{running.label}</div>
            <Bar value={running.progress * 100} />
            <div className="flex items-center justify-between gap-2 text-xs text-ink-2">
              <span className="truncate">
                {phaseLabel(running.phase)}
                {running.steps ? ` · step ${running.step} of ${running.steps}` : running.kind === "export" ? " · no GPU needed" : ""}
                {running.eta ? ` · ${about(running.eta)}` : ""}
                {running.spilling && <span className="font-semibold text-warn-ink" title="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory (a finish frees ComfyUI's models first), or ask SeedVR2 for fewer frames together."> · spilling out of VRAM, much slower than usual</span>}
              </span>
              <Button size="sm" onClick={() => onStop(running.id)}>Stop</Button>
            </div>
          </div>
          {menu.menu && <ContextMenu at={menu.menu.at} label="Actions on the running render" items={[{ label: "Stop this render", icon: <X size={14} />, danger: true, run: () => onStop(running.id) }]} onClose={menu.close} />}
        </div>
      ) : (
        <div className="rounded-xl border border-line px-3.5 py-3 text-sm text-ink-2">Nothing running.</div>
      )}
    </section>
  );
}
