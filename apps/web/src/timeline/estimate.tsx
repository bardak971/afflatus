import { aboutMs } from "../format";

/**
 * A render time that is a guess, as the editor says it everywhere (header chip, Render all, Fix all, New take,
 * the track): "~5 s", "~7 min". Empty when nothing was learned yet. A measured time is said without "~" (`spell`).
 */
export const est = (ms: number | null | undefined) => aboutMs(ms).replace(/^about /, "~");

/** An estimate inside a button, after its words: dimmed, in the button's own type so it reads as part of the label. */
export function Estimate({ ms }: { ms: number | null | undefined }) {
  const said = est(ms);
  return said ? <span className="text-[11px] font-medium opacity-75">{said}</span> : null;
}
