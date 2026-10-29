import { CUT_WINDOW_MOST } from "@afflatus/core";
import { plural } from "../../format";
import { NumberBox } from "../../ui";
import { Slide } from "./parts";

/**
 * How a long recording or a source video is cut into clips, the one control for both (the owner, 2026-10-29: the source's
 * like Lip sync's): Clip length, ± how far from it a clip may end at a better spot (0: every clip that long), and under
 * them what the clips' ends landed on and their lengths. Changed, the clips are cut again.
 */
export function ClipLength({ seconds, within, leastMs, mostMs, pending, onCut, landed, lengths }: {
  /** The length asked, in seconds; `within`: the ± in seconds. */
  seconds: number;
  within: number;
  /** What one clip of the model shows, in ms (the slider's ends). */
  leastMs: number;
  mostMs: number;
  pending: boolean;
  onCut(seconds: number, within: number): void;
  /** What the ends landed on, said ("3 clips on a scene cut, 12 on a pause"); null while it is read. */
  landed: string | null;
  /** Each clip's length, in seconds. */
  lengths: number[];
}) {
  return (
    <>
      <div className="flex items-end gap-2">
        <div className="min-w-0 grow">
          <Slide label="Clip length" value={Math.min(Math.max(seconds * 1000, leastMs), mostMs)} min={leastMs} max={mostMs} step={100} show={(ms) => `${(ms / 1000).toFixed(1)} s`} onCommit={(ms) => onCut(ms / 1000, within)} disabled={pending} />
        </div>
        <span className="flex shrink-0 items-center gap-1 text-ink-2">
          ±
          <NumberBox label="Window (± s of Clip length)" value={within} min={0} max={CUT_WINDOW_MOST} step={0.1} unit=" s" onCommit={(v) => !pending && v !== within && onCut(seconds, v)} />
        </span>
      </div>
      <span className="text-xs text-ink-2">{landed ? `${landed} · ` : ""}{lengths.map((s) => s.toFixed(1)).join(", ")} s</span>
    </>
  );
}

/** What the clips' ends landed on, counted in the order the cut looks for them: "3 clips on a scene cut, 12 on a pause". */
export function landedSaid<K extends string>(on: K[], labels: Array<[K, string]>): string | null {
  if (!on.length) return null;
  return labels.map(([kind, said]) => [on.filter((k) => k === kind).length, said] as const).filter(([n]) => n > 0).map(([n, said], i) => `${i === 0 ? plural(n, "clip") : n} ${said}`).join(", ");
}
