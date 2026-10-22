import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Asset } from "../../api";
import { useAssetChange } from "../../assetChange";
import { eraseNow } from "../../binActions";
import { askAboutDisk } from "../../Confirm";
import { plainKey } from "../../Keys";
import { useItemMutations } from "../../itemMutations";

/** Several items ticked, to move, keep or delete them together; with the keys that tick and untick. */
export function useSelection({ items, listKey, binned, off }: {
  items: Asset[];
  /** What the list is of: when it changes (another folder, another search) nothing is ticked. */
  listKey: string;
  /** The bin is open: Delete erases what is ticked, once asked. */
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
  // shown at once and sent behind (assetChange.tsx): the ticks go with the change, a refusal is said with Retry
  const change = useAssetChange();
  const bulk = (action: "keep" | "unkeep" | "bin" | "restore") => {
    const ids = picked;
    setPicked([]);
    void change(action === "keep" || action === "unkeep" ? { kind: "keep", ids, kept: action === "keep" } : { kind: action, ids });
  };
  const moveTo = (to: string | null) => {
    const ids = picked;
    setPicked([]);
    void change({ kind: "move", ids, folder: to });
  };
  const chosen = items.filter((a) => picked.includes(a.id));
  const client = useQueryClient();
  /** In the bin: the ticked items erased now, once asked; the ticks go once it is done. */
  const eraseChosen = async () => {
    if (await eraseNow(client, picked)) setPicked([]);
  };
  /** The ticked items to the bin; files of a linked folder leave the disk, which is asked first. */
  const binChosen = async () => {
    if (await askAboutDisk(chosen)) bulk("bin");
  };
  const { renameIt } = useItemMutations();
  // Esc unticks, Ctrl + A ticks everything shown, Del (or Backspace, as everywhere Del works) sends what is ticked to the
  // bin (in the bin: erases it, asked first); S keeps what is ticked, or unkeeps it when all of it is kept already, as the
  // viewer's S; F2 renames the one ticked item, as the viewer's F2
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
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void (binned ? eraseChosen() : binChosen());
    } else if ((e.key === "s" || e.key === "S") && !e.shiftKey && !binned) bulk(chosen.length && chosen.every((a) => a.kept) ? "unkeep" : "keep");
    else if (e.key === "F2" && chosen.length === 1 && !binned) {
      e.preventDefault();
      void renameIt(chosen[0]!);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { picked, setPicked, tick, bulk, moveTo, chosen, binChosen, eraseChosen };
}

export type Selection = ReturnType<typeof useSelection>;
