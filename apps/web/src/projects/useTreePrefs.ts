import { useState } from "react";
import { DEFAULT_SORT, nextSort, type ItemKind, type Sort } from "./tree";

/** Which kind of item the folders show and count, kept per browser. */
const KIND = "afflatus.projects.kind";
const readKind = (): ItemKind | null => {
  try {
    const v = localStorage.getItem(KIND);
    return v === "image" || v === "video" || v === "audio" ? v : null;
  } catch {
    return null;
  }
};
/** The column the rows are sorted by, and which way, kept per browser. */
const SORT = "afflatus.projects.sort";
const readSort = (): Sort => {
  try {
    const v = JSON.parse(localStorage.getItem(SORT) ?? "null") as Partial<Sort> | null;
    return v && (v.by === "name" || v.by === "created" || v.by === "size") ? { by: v.by, desc: Boolean(v.desc) } : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
};

/** The Projects panel's kind of item shown and its sort, kept per browser; one project's tree (`scoped`) shows every kind. */
export function useTreePrefs(scoped: boolean) {
  // one project's tree has no kind chips: it shows and counts every kind, whatever the Projects panel was left on
  const [kind, setKindState] = useState<ItemKind | null>(() => (scoped ? null : readKind()));
  const setKind = (k: ItemKind | null) => {
    setKindState(k);
    try {
      if (k) localStorage.setItem(KIND, k);
      else localStorage.removeItem(KIND);
    } catch {
      // not kept: it starts on All next time
    }
  };
  const [sort, setSortState] = useState<Sort>(readSort);
  const sortBy = (by: Sort["by"]) => {
    const next = nextSort(sort, by);
    setSortState(next);
    try {
      localStorage.setItem(SORT, JSON.stringify(next));
    } catch {
      // not kept: newest first next time
    }
  };
  return { kind, setKind, sort, sortBy };
}
