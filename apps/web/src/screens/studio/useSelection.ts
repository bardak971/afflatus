import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type Asset } from "../../api";
import { askAboutDisk } from "../../Confirm";
import { plainKey } from "../../Keys";

/** Several items ticked, to move, keep or delete them together; with the keys that tick and untick. */
export function useSelection({ items, listKey, binned, off }: {
  items: Asset[];
  /** What the list is of: when it changes (another folder, another search) nothing is ticked. */
  listKey: string;
  /** The bin is open: Delete does nothing. */
  binned: boolean;
  /** The keys are left alone: the draft's results are shown, or the viewer is open. */
  off: boolean;
}) {
  // ---- several items ticked, to move, keep or delete them together
  const [picked, setPicked] = useState<string[]>([]);
  const lastPicked = useRef<string | null>(null);
  const tick = (a: Asset, range: boolean) => {
    const from = range && lastPicked.current ? items.findIndex((x) => x.id === lastPicked.current) : -1;
    const to = items.findIndex((x) => x.id === a.id);
    if (from >= 0 && to >= 0) {
      // with Shift: everything from the last one ticked to this one
      const between = items.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id);
      setPicked((old) => [...new Set([...old, ...between])]);
    } else setPicked((old) => (old.includes(a.id) ? old.filter((x) => x !== a.id) : [...old, a.id]));
    lastPicked.current = a.id;
  };
  // what is ticked is of the list that is shown: another folder, another search, and nothing is
  useEffect(() => setPicked([]), [listKey]);
  // the library refreshes on the server's own word (its `library` event)
  const afterBulk = () => setPicked([]);
  const bulk = useMutation({ mutationFn: (action: "keep" | "unkeep" | "bin" | "restore") => api.bulkAssets(picked, action), onSuccess: afterBulk });
  const moveTo = useMutation({ mutationFn: (to: string | null) => api.moveAssets(picked, to), onSuccess: afterBulk });
  const chosen = items.filter((a) => picked.includes(a.id));
  /** The ticked items to the bin; files of a linked folder leave the disk, which is asked first. */
  const binChosen = async () => {
    if (await askAboutDisk(chosen)) bulk.mutate("bin");
  };
  // Esc unticks, Ctrl + A ticks everything shown, Del sends what is ticked to the bin
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (off || document.querySelector("[role=dialog][aria-modal=true]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !(e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]") && items.length) {
      e.preventDefault();
      setPicked(items.map((a) => a.id));
      return;
    }
    if (!picked.length || !plainKey(e)) return;
    if (e.key === "Escape") setPicked([]);
    else if (e.key === "Delete" && !binned) void binChosen();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { picked, setPicked, tick, bulk, moveTo, chosen, binChosen };
}

export type Selection = ReturnType<typeof useSelection>;
