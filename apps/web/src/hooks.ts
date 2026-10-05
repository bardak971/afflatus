import { useEffect, useState } from "react";

/** The small hooks several screens share. */

/** A value as it stands once it has stopped changing for `ms`: what is typed in a search box, asked for once the typing stops. */
export function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
