import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import type { Asset } from "./api";
import { useProjects } from "./data";
import { onPaste, pasteIntoLibrary, usePasteTarget } from "./paste";
import { useProject } from "./project";
import { useBanners, useHandover, useStudio } from "./store";

/**
 * What a paste into the library opens: the folder it went into (the project's root when none was named, its whole), and
 * the item large when it was one.
 */
function useOpenPasted() {
  const [, go] = useLocation();
  const hand = useHandover((h) => h.set);
  const setStudio = useStudio((s) => s.set);
  return (folder: string | null) => (items: Asset[]) => {
    setStudio({ place: folder ? { type: "folder", id: folder } : { type: "all" } });
    go("/");
    if (items.length === 1) hand({ show: items[0]!.id });
  };
}

/**
 * The library shown (the Studio's grid, the timeline's Media strip open): Ctrl+V pastes into the folder it shows, `folder`,
 * else the project's root. `name`: what the banner calls it.
 */
export function usePasteIntoLibrary(shown: boolean, folder: string | null, name: string): void {
  const say = useBanners((b) => b.push);
  const open = useOpenPasted();
  usePasteTarget(shown ? { level: "library", take: (files) => void pasteIntoLibrary(files, { folder, name, say, open: open(folder) }) } : null);
}

/**
 * Ctrl+V anywhere in the app (paste.ts): what no place shown takes goes into the project's library, the folder new uploads
 * go to, with a banner "Pasted into Dev · Open".
 */
export function PasteHere() {
  const say = useBanners((b) => b.push);
  const open = useOpenPasted();
  const project = useProject((s) => s.id);
  const projects = useProjects();
  const name = project === "none" ? "Inbox" : projects.data?.items.find((p) => p.id === project)?.name ?? "your project";
  // read when a paste happens: the listener is put on once
  const elsewhere = useRef((_files: File[]) => {});
  elsewhere.current = (files) => void pasteIntoLibrary(files, { folder: null, name, say, open: open(null) });
  useEffect(() => {
    const paste = (e: ClipboardEvent) => onPaste(e, (files) => elsewhere.current(files));
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);
  return null;
}
