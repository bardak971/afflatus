import type { Inspection } from "../src";

/** What the corpus check compares, per workflow: whether the parts were found, and counts. Names and counts only. */
export function corpusFacts(found: Inspection) {
  const s = found.suggested;
  return {
    result: Boolean(s),
    prompt: Boolean(s?.prompt),
    negative: Boolean(s?.negative),
    model: Boolean(s?.model),
    startImage: Boolean(s?.startImage),
    video: Boolean(s?.previousVideo || s?.sourceVideo || s?.nextVideo),
    size: Boolean(s?.size),
    length: Boolean(s?.length),
    seeds: s?.seeds.length ?? 0,
    toggles: s?.toggles.length ?? 0,
    controls: s?.controls.length ?? 0,
    stages: found.stages.length,
    missingNodes: found.missingNodes.length,
    replaced: found.replaced.length,
    notes: found.notes.length,
  };
}
