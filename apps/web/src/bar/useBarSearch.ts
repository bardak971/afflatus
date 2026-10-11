import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import type { Mode } from "./parse";

/**
 * `value` a moment after it stops changing: what is asked of the server as typed waits for the typing to pause. While
 * `live` is off it keeps what it had (a search of another mode is not asked again on the way back). It starts at `from`.
 */
export function useDebounced<T>(value: T, ms: number, live: boolean, from: T): T {
  const [now, setNow] = useState(from);
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setNow(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, live]);
  return now;
}

/**
 * The bar's two searches asked of the server as typed: the library's items whose name could match (the index holds only a
 * few; the server looks through all of them and the bin), and the prompt history (every prompt rendered).
 */
export function useBarSearch(open: boolean, mode: Mode, text: string) {
  // a moment after the typing stops; the ones found before stay while it answers. Under the index's key, so that what
  // marks the index old marks them too
  const typed = mode === "all" ? text.trim() : "";
  const itemsQ = useDebounced(typed, typed ? 80 : 0, true, "");
  const found = useQuery({
    queryKey: queryKeys.commandIndex.items(itemsQ),
    queryFn: ({ signal }) => api.commandItems(itemsQ, { signal }),
    enabled: open && Boolean(itemsQ),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const foundEntries = itemsQ && mode === "all" ? found.data?.entries : undefined;

  // prompt history: only while its mode is on
  const historyQ = useDebounced(text, 150, mode === "history", "");
  const history = useQuery({ queryKey: queryKeys.promptHistory.search(historyQ), queryFn: ({ signal }) => api.promptHistory(historyQ, 30, { signal }), enabled: open && mode === "history", placeholderData: keepPreviousData });

  return { foundEntries, history };
}
