import type { CueValue, InputSpec } from "@afflatus/core";

/**
 * A ♪ on the clip where each of its sound cues lands, in the clip's own time as its keyframe is placed; one past what the
 * clip shows is not drawn. The cue's sound is said in its hover line.
 */
export function CueMarks({ inputs, specs, lengthMs }: { inputs: Record<string, unknown>; specs: readonly InputSpec[] | undefined; lengthMs: number }) {
  const spec = specs?.find((i) => i.type === "cues");
  const cues = spec ? ((inputs[spec.id] as CueValue[] | undefined) ?? []) : [];
  if (!cues.length || lengthMs <= 0) return null;
  return (
    <>
      {cues.map((cue, i) => {
        const part = (cue.at * 1000) / lengthMs;
        if (part > 1) return null;
        return (
          // a thin line down the clip, the ♪ beside it half way down: the clip's own words and badges stay readable over it
          <span
            key={i}
            data-cue-mark={i}
            data-tip={`Sound cue ${i + 1}: lands at ${cue.at.toFixed(1)} s, ${cue.seconds.toFixed(1)} s of its sound`}
            className="pointer-events-auto absolute inset-y-1 w-px bg-accent/50"
            style={{ left: `${Math.max(0.02, part) * 100}%` }}
          >
            <span aria-hidden className="absolute top-1/2 left-0.5 -translate-y-1/2 text-micro leading-none text-accent">♪</span>
          </span>
        );
      })}
    </>
  );
}
