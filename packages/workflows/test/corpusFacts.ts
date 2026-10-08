import type { Inspection, Target } from "../src";

const at = (t: Target | undefined) => (t ? `${t.node}.${t.input}` : undefined);

/** What the corpus check compares, per workflow: whether the parts were found, counts, and where the main parts were bound. Names and counts only. */
export function corpusFacts(found: Inspection) {
  const s = found.suggested;
  // where each part was bound: a change that moves one is seen, not only one that loses it
  const bound = Object.fromEntries(Object.entries({
    result: s?.result.node,
    prompt: at(s?.prompt),
    negative: at(s?.negative),
    model: at(s?.model?.target),
    seeds: s?.seeds.length ? s.seeds.map(at).join(" ") : undefined,
    size: s?.size ? `${at(s.size.width)} ${at(s.size.height)}` : undefined,
    length: at(s?.length?.target),
    startImage: at(s?.startImage?.target),
    endImage: at(s?.endImage?.target),
  }).filter(([, v]) => v !== undefined)) as Record<string, string>;
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
    bound,
  };
}
