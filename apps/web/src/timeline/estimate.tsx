import { est } from "../format";

/** An estimate inside a button, after its words: dimmed, in the button's own type so it reads as part of the label. */
export function Estimate({ ms }: { ms: number | null | undefined }) {
  const said = est(ms);
  return said ? <span className="text-micro font-medium opacity-75">{said}</span> : null;
}
