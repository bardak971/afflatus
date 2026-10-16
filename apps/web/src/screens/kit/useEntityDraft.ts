import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, raw, type Entity } from "../../api";
import { useKeyedAutosave } from "../../autosave";
import { outfitsOf } from "./shared";
import { queryKeys } from "../../queryKeys";

/**
 * What a save of an item sends. A person's outfit that holds nothing yet is left out: it stays on screen to be
 * filled in, and is saved with the first name, word or picture it gets.
 */
export const bodyOf = (e: Entity) => ({
  name: e.name.trim() || "Unnamed",
  def: e.kind === "person" ? { ...e.def, outfits: outfitsOf(e.def.outfits) } : e.def,
});

/**
 * The item open for changes, as it is on screen: saved half a second after the last change, and at once
 * when another is opened, the screen is left or the tab is closed. A save that fails keeps the change: the
 * next flush, or Retry, sends it again, and the browser asks before the tab is closed meanwhile. Each item's
 * change waits under its own id: with one for all, a change to another item, made after a failed save,
 * took the failed one's place and, once saved, said everything saved, its changes gone.
 */
export function useEntityDraft({ stored, loading }: {
  /** The open item as the server has it; null when none is open. */
  stored: Entity | null;
  /** The list is still being read: nothing open yet is not the same as nothing open. */
  loading: boolean;
}) {
  const client = useQueryClient();
  // what is on screen is saved half a second after the last change (autosave.ts, as a draft is)
  const [edit, setEdit] = useState<Entity | null>(null);
  const save = useKeyedAutosave<Entity>({
    save: async (_, e) => {
      await api.saveEntity(e.id, bodyOf(e));
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
    },
    // the tab closed or reloaded: a request that outlives the page
    keepalive: (_, e) => void raw("PUT", `/entities/${e.id}`, bodyOf(e), { keepalive: true }).catch(() => {}),
    // deleted meanwhile (another tab): its change has nowhere to go, and would leave the screen said failed
    gone: (err) => err instanceof ApiError && err.status === 404,
  });
  const { pending } = save;
  // an item opened again while its change is not saved (its save failed) opens as it was left, not as the server has it
  useEffect(() => {
    if (stored && stored.id !== edit?.id) setEdit(pending.get(stored.id) ?? stored);
    if (!stored && !loading) setEdit(null);
  }, [stored, edit?.id, loading, pending]);
  const change = (next: Entity) => {
    setEdit(next);
    save.queue(next.id, next);
  };
  /** The change that waits for this item is dropped: the item is gone. Another item's change still goes. */
  const dropPending = (id: string) => save.drop(id);
  // every item's change, the one open and any left failed: what opens next, or the Studio, reads what the server has
  const flush = () => save.flush();
  return { edit, saved: save.state, failure: save.failure, flush, retry: save.retry, change, dropPending };
}
