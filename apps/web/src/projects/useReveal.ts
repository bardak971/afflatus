import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Reveal } from "../bar/bridge";
import type { Folder } from "../api";
import { groupKey, type Row } from "./tree";

/**
 * "Show in the Projects panel": the way down to the item unfolded once, then its row picked when it is drawn. An item
 * in no folder has no row of its own (the Inbox's "No folder" row stands for them); one past a folder's first page
 * falls back to its folder's row.
 */
export function useReveal({ reveal, folders, setOpen, rows, setFocused, setPicked }: {
  reveal: Reveal | undefined;
  folders: Folder[] | undefined;
  setOpen(key: string, open: boolean): void;
  rows: Row[];
  setFocused(key: string): void;
  setPicked: Dispatch<SetStateAction<Map<string, Row>>>;
}) {
  const revealed = useRef(false);
  useEffect(() => {
    if (!reveal || revealed.current || !folders) return;
    revealed.current = true;
    setOpen(groupKey({ id: reveal.group }), true);
    const all = folders;
    for (let f = all.find((x) => x.id === reveal.folder); f; f = all.find((x) => x.id === f!.parentId)) setOpen(`f:${f.id}`, true);
  }, [reveal, folders]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useRef(false);
  useEffect(() => {
    if (!reveal || shown.current || !revealed.current) return;
    const own = rows.find((r) => r.key === `a:${reveal.asset}`);
    const stand = own ?? rows.find((r) => r.key === (reveal.folder ? `f:${reveal.folder}` : "loose"));
    // the folder's items not read yet: wait for them rather than settling on the folder
    if (!own && reveal.folder && rows.some((r) => r.key.startsWith("more:") && r.label === "Reading…")) return;
    if (!stand) return;
    shown.current = true;
    setFocused(stand.key);
    setPicked(new Map([[stand.key, stand]]));
  }, [rows, reveal]); // eslint-disable-line react-hooks/exhaustive-deps
}
