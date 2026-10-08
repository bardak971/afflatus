import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Entity } from "../../api";

/** What a save of an item sends. */
const bodyOf = (e: Entity) => ({ name: e.name.trim() || "Unnamed", def: e.def });

/**
 * The item open for changes, as it is on screen: saved half a second after the last change, and at once
 * when another is opened, the screen is left or the tab is closed. A save that fails keeps the change: the
 * next flush, or Retry, sends it again, and the browser asks before the tab is closed meanwhile.
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
  const [failure, setFailure] = useState<string | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const e = pending.current;
    if (!e) return;
    try {
      await api.saveEntity(e.id, bodyOf(e));
      // what was sent is saved; a change made meanwhile is still waiting
      if (pending.current === e) pending.current = null;
      await client.invalidateQueries({ queryKey: ["entities"] });
      if (!pending.current) {
        setSaved("saved");
        setFailure(null);
      }
    } catch (err) {
      // the change stays pending: the next flush, or Retry, sends it again
      setSaved("failed");
      setFailure((err as Error).message);
    }
  }, [client]);
  const retry = () => {
    setSaved("saving");
    void flush();
  };
  useEffect(() => () => void flush(), [flush]);
  // the tab closed or reloaded: a request that outlives the page; while a save has failed, the browser asks first
  useEffect(() => {
    const hide = () => {
      const e = pending.current;
      if (!e) return;
      void fetch(`/api/entities/${e.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Afflatus": "1" }, body: JSON.stringify(bodyOf(e)), keepalive: true }).catch(() => {});
    };
    const ask = (ev: BeforeUnloadEvent) => {
      if (saved !== "failed") return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", ask);
    };
  }, [saved]);
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
  /** The change that waits for this item is dropped: the item is gone. Another item's change still goes. */
  const dropPending = (id: string) => {
    if (pending.current?.id === id) pending.current = null;
  };
  return { edit, saved, failure, flush, retry, change, dropPending };
}
