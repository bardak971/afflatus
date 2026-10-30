import type { ComponentProps } from "react";
import type { Clip, Timeline, TimelinePatch } from "../api";
import { Help } from "../ui";
import { ColumnEdge, FoldButton, FoldedStrip } from "./column";
import { SHAPES, shapeOf, type Shape } from "./model";
import type { Plan } from "./attention";
import { Overview, useAttention } from "./Overview";
import { StartPanel } from "./StartPanel";

/**
 * What Needs attention is worked out from, the same in the Overview, the folded column and the Export and Finish
 * dialogs: which clips can render (known once the models, the setup and the settings have come) and why the others cannot.
 */
export interface Checks {
  renderable(c: Clip): boolean;
  msOf(c: Clip): number | null;
  /** The server's plan of the clips left to render (the header's Render all): the Overview says each render's time from it. */
  plan?: Plan;
  why(c: Clip): string | undefined;
  /** A Lip sync clip without its voice recording yet (listed on a row of its own). */
  voiceless(c: Clip): boolean;
  known: boolean;
}

/** The right column folded: its strip, with the count of what Needs attention lists (the Overview's rows, worked out the same way). */
export function FoldedColumn({ timeline, clips, label, renderable, msOf, why, voiceless, known }: { timeline: Timeline; clips: Clip[]; label: string } & Checks) {
  const { rows, checking } = useAttention(timeline, clips, renderable, msOf, { why, voiceless, known });
  // no count while the checks run: one that grows under the pointer reads as new trouble
  return <FoldedStrip label={label} attention={checking ? 0 : rows.length} />;
}

/** The right column with no clip open: the timeline's own Overview, or the start's invitation while it has no clip. */
export function OverviewColumn({ t, clips, checks, width, picked, rendering, onEdit, onPick, onVoice, onMusic, onCast, onFix, onRenderPicked, start }: {
  t: Timeline;
  clips: Clip[];
  checks: Checks;
  width: number;
  picked: Set<string>;
  rendering: boolean;
  onEdit(patch: TimelinePatch): void;
  onPick(clip: string): void;
  /** A Lip sync clip's voice, chosen from its Needs a look row. */
  onVoice(clip: string, asset: string): void;
  onMusic(): void;
  onCast(): void;
  onFix: ComponentProps<typeof Overview>["onFix"];
  onRenderPicked(): void;
  start: { busy: boolean; planning: boolean; onPickImage(): void; onPlan(idea: string, count: number): void; onNewClip(): void };
}) {
  const shape: Shape | "own" | "first" = !t.width || !t.height ? "first" : (Object.keys(SHAPES) as Shape[]).find((k) => SHAPES[k].width === t.width && SHAPES[k].height === t.height) ?? "own";
  return (
    // as wide as the clip's panel, and widened the same way: the stage keeps its size from one to the other
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-l border-line bg-panel text-ink-2">
      <ColumnEdge />
      {/* a container: the Overview's rows lay out by the column's width, which can go down to 320 px */}
      <div className="@container/column flex min-h-0 grow flex-col gap-3 overflow-y-auto p-4">
      {/* its name is in the header's field: said here only as the start's invitation */}
      {!clips.length && <span className="flex items-center gap-1.5 text-page font-bold text-ink">Start your video<Help title="Start your video" text="Clips play one after the other; each can extend the clip before (seamless): the motion and the voices carry on across the join." /></span>}
      {clips.length ? (
        <Overview
          timeline={t}
          aspect={{
            value: shape,
            onChange: (v) => onEdit(v === "first" ? { width: null, height: null } : v === "own" ? {} : { width: SHAPES[v as Shape].width, height: SHAPES[v as Shape].height }),
            options: [
              ...(Object.keys(SHAPES) as Shape[]).map((k) => ({ value: k as string, label: SHAPES[k].label, short: SHAPES[k].ratio, note: `${SHAPES[k].width} × ${SHAPES[k].height}` })),
              ...(shape === "own" ? [{ value: "own", label: SHAPES[shapeOf(t.width!, t.height!)].label, note: `${t.width} × ${t.height}` }] : []),
              { value: "first", label: "The first clip decides", detail: "The video takes the aspect ratio of the first clip that is rendered." },
            ],
          }}
          clips={clips}
          {...checks}
          onPick={onPick}
          onVoice={onVoice}
          onMusic={onMusic}
          onCast={onCast}
          onFolder={(folder) => onEdit({ folder })}
          onFix={onFix}
          picked={picked}
          onRenderPicked={onRenderPicked}
          rendering={rendering}
          fold={<FoldButton words />}
        />
      ) : (
        <StartPanel busy={start.busy} planning={start.planning} onPickImage={start.onPickImage} onPlan={start.onPlan} onNewClip={start.onNewClip} />
      )}
      </div>
    </aside>
  );
}
