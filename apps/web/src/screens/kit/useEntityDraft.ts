import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Entity } from "../../api";

/**
 * The item open for changes, as it is on screen: saved half a second after the last change, and at once
 * when another is opened or the screen is left. A save that fails keeps the change: the next flush, or
 * Retry, sends it again.
 */
export function useEntityDraft({ stored, loading }: {
  /** The open item as the server has it; null when none is open. */
  stored: Entity | null;
  /** The list is still being read: nothing open yet is not the same as nothing open. */
  loading: boolean;
}) {
  const client = useQueryClient();
  // what is on screen is saved half a second after the last change
  const [edit, setEdit] = useState<Entity | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Entity | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "failed">("saved");
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const e = pending.current;
    if (!e) return;
    try {
      await api.saveEntity(e.id, { name: e.name.trim() || "Unnamed", def: e.def });
      // what was sent is saved; a change made meanwhile is still waiting
      if (pending.current === e) pending.current = null;
      await client.invalidateQueries({ queryKey: ["entities"] });
      if (!pending.current) setSaved("saved");
    } catch {
      // the change stays pending: the next flush, or Retry, sends it again
      setSaved("failed");
    }
  }, [client]);
  const retry = () => {
    setSaved("saving");
    void flush();
  };
  useEffect(() => () => void flush(), [flush]);
  useEffect(() => {
    if (stored && stored.id !== edit?.id) setEdit(stored);
    if (!stored && !loading) setEdit(null);
  }, [stored, edit?.id, loading]);
  const change = (next: Entity) => {
    setEdit(next);
    pending.current = next;
    setSaved("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };
  /** The change that waits is dropped: the item it was for is gone. */
  const dropPending = () => {
    pending.current = null;
  };
  return { edit, saved, flush, retry, change, dropPending };
}
