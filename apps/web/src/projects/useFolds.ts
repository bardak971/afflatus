import { useEffect, useState } from "react";

/** Which rows are unfolded, kept per browser. */
const FOLDS = "afflatus.projects.open";
const readFolds = (): Record<string, boolean> => {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDS) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};

/**
 * The Projects panel's unfolded rows: kept per browser; while searching (`q`) every branch is open unless folded then.
 * A row never folded or unfolded is open when it is the project worked in (`currentKey`).
 */
export function useFolds(q: string, currentKey: string) {
  const [folds, setFolds] = useState(readFolds);
  const [searchFolded, setSearchFolded] = useState<Set<string>>(new Set());
  useEffect(() => setSearchFolded(new Set()), [q]);
  const isOpen = (key: string) => (q ? !searchFolded.has(key) : folds[key] ?? key === currentKey);
  const setOpen = (key: string, open: boolean) => {
    if (q) {
      setSearchFolded((s) => {
        const n = new Set(s);
        if (open) n.delete(key);
        else n.add(key);
        return n;
      });
      return;
    }
    setFolds((f) => {
      const n = { ...f, [key]: open };
      try {
        localStorage.setItem(FOLDS, JSON.stringify(n));
      } catch {
        // not kept: it opens folded next time
      }
      return n;
    });
  };
  return { folds, searchFolded, isOpen, setOpen };
}
