import { useEffect, useState } from "react";

/**
 * The moment whose exact frame is shown under the mouse on a strip: asked for a moment after the mouse settles on it
 * (`hoverMs`), none once the mouse has left.
 */
export function usePeek(hoverMs: number | undefined): number | null {
  const [peek, setPeek] = useState<number | null>(null);
  useEffect(() => {
    if (hoverMs === undefined) { setPeek(null); return; }
    const t = setTimeout(() => setPeek(Math.round(hoverMs)), 90);
    return () => clearTimeout(t);
  }, [hoverMs]);
  return peek;
}
