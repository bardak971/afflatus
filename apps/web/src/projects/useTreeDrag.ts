import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { DRAG_TIMELINE, DRAG_TYPE } from "../dragging";
import { planBin, planDrop, whyRefused, type Moving, type Row } from "./tree";
import type { useTreeActions } from "./useTreeActions";

/** How near the top or the foot of the list a drag scrolls it, in px. */
const EDGE = 32;

/** What the rows move: those of them that can be moved. */
export const movingOf = (rs: Row[]) => rs.map((x) => x.moving).filter((m): m is Moving => Boolean(m));

/**
 * Dragging in the Projects panel: rows dragged onto a project, the Inbox or a folder (or the Bin), the library's items and
 * timelines dropped on them, and files from the computer. Which row a drag is over, why a drop there is refused, a folded
 * row opening after a moment, the "no root folder" badge taking a folder, and the list scrolling at its edges.
 */
export function useTreeDrag({ picked, renaming, setOpen, actions, clearPicks, targetOf, list, head, footHeight }: {
  picked: Map<string, Row>;
  /** A row is being renamed: nothing is dragged meanwhile. */
  renaming: boolean;
  setOpen(key: string, open: boolean): void;
  actions: ReturnType<typeof useTreeActions>;
  clearPicks(): void;
  /** What a drop on the row then opens (a folder, the project), once the move is made. */
  targetOf(r: Row): (() => void) | undefined;
  list: RefObject<HTMLDivElement | null>;
  head: RefObject<HTMLDivElement | null>;
  footHeight: number;
}) {
  // dragging rows onto a project, the Inbox or a folder: what is dragged, the row it is over, a folded one opening after a moment
  const dragged = useRef<Row[] | null>(null);
  // the row a drag started on stays drawn while it lasts, out of sight too: its dragend comes to it
  const dragFrom = useRef<string | null>(null);
  /** Whether what is dragged can be dropped on that row: moved there, or (the Bin) thrown away. */
  const takes = (r: Row) => {
    const moving = dragged.current ? movingOf(dragged.current) : [];
    // the Inbox's No folder row takes items out of their folder (a file of the disk stays in its directory)
    if (r.kind === "loose") return moving.length > 0 && moving.every((m) => m.kind === "asset" && !m.onDisk && m.folder !== null);
    return r.kind === "bin" ? Boolean(planBin(moving)) : Boolean(r.target && planDrop(moving, r.target));
  };
  const [over, setOver] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; why: string } | null>(null);
  const opening = useRef<{ key: string; t: ReturnType<typeof setTimeout> } | null>(null);
  const stopOpening = () => {
    if (opening.current) clearTimeout(opening.current.t);
    opening.current = null;
  };
  const dragStart = (r: Row, e: DragEvent) => {
    if (!r.moving || renaming) return e.preventDefault();
    const rs = picked.has(r.key) ? [...picked.values()] : [r];
    dragged.current = rs;
    dragFrom.current = r.key;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-afflatus-tree", rs.map((x) => x.key).join(","));
    if (rs.length > 1) {
      const ghost = document.createElement("div");
      ghost.textContent = `${rs.length} items`;
      ghost.className = "fixed -top-96 left-0 rounded-lg border border-line-strong bg-raised px-3 py-1.5 text-sm font-semibold text-ink";
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  };
  /** Files from the computer go to a project, the Inbox or a folder (one of the disk: written into it there). */
  const takesFiles = (r: Row) => !r.archived && (r.kind === "project" || r.kind === "inbox" || r.kind === "folder") && Boolean(r.target);
  /**
   * The library's own drag (the grid's items, the Timelines view's cards): items onto a folder, a project with a root
   * folder, the Inbox's No folder row or the Bin; timelines onto a folder that is not of the disk, or a project.
   */
  const takesLibrary = (r: Row, types: readonly string[]) => {
    if (r.archived) return false;
    const items = types.includes(DRAG_TYPE);
    const timelines = types.includes(DRAG_TIMELINE);
    if (r.kind === "bin" || r.kind === "loose") return items && !timelines;
    if (!r.target) return false;
    if (r.target.kind === "folder") return items || (timelines && !r.target.linked);
    return (items && Boolean(r.target.root)) || timelines;
  };
  const dragOver = (r: Row, e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (!dragged.current && (types.includes(DRAG_TYPE) || types.includes(DRAG_TIMELINE))) {
      if (!takesLibrary(r, types)) {
        if (over === r.key) setOver(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== r.key) setOver(r.key);
      if (r.foldable && !r.open && opening.current?.key !== r.key) {
        stopOpening();
        opening.current = { key: r.key, t: setTimeout(() => setOpen(r.key, true), 700) };
      }
      return;
    }
    const fromDisk = !dragged.current && types.includes("Files");
    if (fromDisk ? !takesFiles(r) : !dragged.current || !takes(r)) {
      if (over === r.key) setOver(null);
      // a drop refused for a reason of the disk says so, in place of the row's line
      const why = !fromDisk && dragged.current && r.target ? whyRefused(movingOf(dragged.current), r.target) : null;
      if (why ? refused?.key !== r.key || refused.why !== why : refused?.key === r.key) setRefused(why ? { key: r.key, why } : null);
      return;
    }
    if (refused) setRefused(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = fromDisk ? "copy" : "move";
    if (over !== r.key) setOver(r.key);
    if (r.foldable && !r.open && opening.current?.key !== r.key) {
      stopOpening();
      opening.current = { key: r.key, t: setTimeout(() => setOpen(r.key, true), 700) };
    }
  };
  const dragLeave = (r: Row, e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (refused?.key === r.key) setRefused(null);
    if (over === r.key) setOver(null);
    if (opening.current?.key === r.key) stopOpening();
  };
  const drop = (r: Row, e: DragEvent) => {
    e.preventDefault();
    const items = dragged.current;
    dragged.current = null;
    setOver(null);
    setRefused(null);
    stopOpening();
    const libraryItems = e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean);
    const libraryTimelines = e.dataTransfer.getData(DRAG_TIMELINE).split(",").filter(Boolean);
    if (!items && (libraryItems.length || libraryTimelines.length)) {
      if (!takesLibrary(r, e.dataTransfer.types)) return;
      if (r.kind === "bin") void actions.binLibrary(libraryItems);
      else void actions.fromLibrary({ assets: libraryItems, timelines: libraryTimelines }, r.kind === "loose" ? null : r.target ?? null);
      return;
    }
    if (!items) {
      // files from the computer: uploaded there; a folder dropped is not read (its right-click "Import a folder…" is)
      if (!e.dataTransfer.files.length || !takesFiles(r) || !r.target) return;
      const dirs = new Set([...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x) => x?.isDirectory).map((x) => x!.name));
      const files = [...e.dataTransfer.files].filter((f) => !(dirs.has(f.name) && !f.type));
      void actions.upload(files, r.target, dirs.size);
      return;
    }
    if (r.kind === "bin") void actions.bin(items).then(clearPicks);
    else if (r.kind === "loose") void actions.fromLibrary({ assets: movingOf(items).map((m) => m.id), timelines: [] }, null).then(clearPicks);
    else if (r.target) void actions.move(movingOf(items), r.target, targetOf(r)).then(clearPicks);
  };
  const dragEnd = () => {
    dragged.current = null;
    dragFrom.current = null;
    setOver(null);
    setRefused(null);
    setOverBadge(null);
    stopOpening();
  };
  // the "no root folder" badge: one folder of that project, not of the disk, dropped on it becomes its root
  const [overBadge, setOverBadge] = useState<string | null>(null);
  const rootFrom = (r: Row): Row | null => {
    const d = dragged.current;
    const f = d?.length === 1 ? d[0]! : null;
    return f && f.kind === "folder" && f.id && f.group === r.id && !f.linked ? f : null;
  };
  const badgeOver = (r: Row, e: DragEvent) => {
    // never the row's own drop (a move into the project) while over the badge
    e.stopPropagation();
    if (over) setOver(null);
    if (!rootFrom(r)) {
      e.dataTransfer.dropEffect = "none";
      if (overBadge) setOverBadge(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overBadge !== r.key) setOverBadge(r.key);
  };
  const badgeDrop = (r: Row, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const f = rootFrom(r);
    dragEnd();
    if (f && r.id) void actions.setRoot({ id: r.id, name: r.label }, { id: f.id!, name: f.label });
  };
  useEffect(() => stopOpening, []);
  /** A drag near the top or the foot of the list scrolls it, so rows out of sight can be reached; over the Bin it stays put (a place to drop). */
  const edgeScroll = (e: DragEvent) => {
    const el = list.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const up = box.top + (head.current?.offsetHeight ?? 0) + EDGE - e.clientY;
    const foot = box.bottom - footHeight;
    const down = e.clientY - (foot - EDGE);
    if (up > 0) el.scrollTop -= Math.min(24, up);
    else if (down > 0 && e.clientY < foot) el.scrollTop += Math.min(24, down);
  };
  return { dragFrom, over, refused, overBadge, setOverBadge, dragStart, dragOver, dragLeave, drop, dragEnd, badgeOver, badgeDrop, edgeScroll };
}
