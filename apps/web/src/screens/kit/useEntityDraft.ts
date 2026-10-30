import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keptSaid, kitEditCount, kitLaidOver, kitUndone, kitUnsaved, useKitEdits, type KitEdit } from "../../agentEdits";
import { api, ApiError, raw, type Entity } from "../../api";
import { useKeyedAutosave } from "../../autosave";
import { plural } from "../../format";
import { outfitsOf } from "./shared";
import { queryKeys } from "../../queryKeys";
import { failedBanner } from "../../sayFailed";
import { useBanners } from "../../store";

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
export function useEntityDraft({ stored, loading, shows }: {
  /** The open item as the server has it; null when none is open. */
  stored: Entity | null;
  /** The list is still being read: nothing open yet is not the same as nothing open. */
  loading: boolean;
  /** Whether the kit shows the item an MCP token changed (the one open, or a snippet of the Snippets tab): its change is said in a toast with Undo. */
  shows?(e: KitEdit): boolean;
}) {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  // what is on screen is saved half a second after the last change (autosave.ts, as a draft is)
  const [edit, setEdit] = useState<Entity | null>(null);
  // the page's last save as the server answered it: an agent's change saved before it was written over by it (saved again below)
  const lastSaved = useRef<{ id: string; at: string } | null>(null);
  const save = useKeyedAutosave<Entity>({
    save: async (_, e) => {
      const saved = await api.saveEntity(e.id, bodyOf(e));
      lastSaved.current = { id: saved.id, at: saved.updatedAt };
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
  const shown = useRef(edit);
  shown.current = edit;
  const change = (next: Entity) => {
    // what the user changed loses the ring an MCP token left on it
    const before = shown.current;
    if (before?.id === next.id) useKitEdits.getState().clear(next.id, [...kitUnsaved(next, before)]);
    setEdit(next);
    save.queue(next.id, next);
  };

  // an item an MCP token changed (a "kit" live event, agentEdits.ts): the open one shows it at once, the parts the user
  // changed and has not saved yet kept as typed (their save goes after, with the agent's other parts), with a toast whose
  // Undo puts back what the token changed (what was changed again since stays); the lists read again. A save of the page's
  // answered after the change was written sent the item as the page held it before, over it: it is saved again
  const kitSeq = useKitEdits((st) => st.seq);
  useEffect(() => {
    const e = useKitEdits.getState().last;
    if (!kitSeq || !e) return;
    void client.invalidateQueries({ queryKey: queryKeys.entities() });
    if (e.made) return;
    const open = shown.current;
    if (open?.id === e.id) {
      const waiting = pending.get(e.id);
      const keep = kitUnsaved(waiting, stored);
      const next = kitLaidOver(open, e, keep);
      setEdit(next);
      if (waiting) save.queue(e.id, kitLaidOver(waiting, e, keep));
      else if (e.saved && lastSaved.current?.id === e.id && lastSaved.current.at >= e.saved) save.queue(e.id, next);
    }
    const n = kitEditCount(e);
    if (!n || !(shows?.(e) ?? open?.id === e.id)) return;
    say({
      id: `agent-kit:${e.id}`, tone: "good", title: `${e.by} changed ${plural(n, "field")}`,
      action: {
        label: "Undo", key: "Ctrl+Z", undo: true,
        run: () => {
          useKitEdits.getState().forget(e);
          // the parts changed again since stay as they are now: said
          const back = (item: Entity) => {
            const r = kitUndone(item, e);
            const text = keptSaid(r.kept);
            if (text) say({ id: `agent-undo:${e.id}`, tone: "good", title: `${e.by}'s change undone, in part`, text });
            return r.item;
          };
          const now = shown.current;
          if (now?.id === e.id) return change(back(now));
          // not open (a snippet's row, or another item opened since): its change still waiting here (a failed save) goes
          // with the Undo in it; else put back as the server has it now, never from the list kept here, which may be older
          const waiting = pending.get(e.id);
          if (waiting) return void save.queue(e.id, back(waiting));
          void (async () => {
            const item = (await api.entities()).items.find((x) => x.id === e.id);
            if (!item) return;
            await api.saveEntity(e.id, bodyOf(back(item)));
            await client.invalidateQueries({ queryKey: queryKeys.entities() });
          })().catch((err: unknown) => say(failedBanner({ id: `agent-undo:${e.id}`, href: "/kit", go: "Open the Prompt kit" }, `${e.by}'s change could not be undone`, err)));
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each edit heard once; the item is read through refs
  }, [kitSeq]);
  /** The change that waits for this item is dropped: the item is gone. Another item's change still goes. */
  const dropPending = (id: string) => save.drop(id);
  // every item's change, the one open and any left failed: what opens next, or the Studio, reads what the server has
  const flush = () => save.flush();
  return { edit, saved: save.state, failure: save.failure, flush, retry: save.retry, change, dropPending };
}
