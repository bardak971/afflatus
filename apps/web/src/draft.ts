import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, lookAdds, type Draft } from "./api";
import { useOpenDraft } from "./store";

const SAVE_AFTER_MS = 500;

/** Nothing was done in it: no value set, nobody in it, no conversation, no name. Such a draft is not worth keeping. */
const holdsNothing = (d: Draft) =>
  !d.name && !d.chat.length && !lookAdds(d.look) && Object.values(d.forms).every((form) => Object.keys(form).length === 0);

/**
 * The draft being worked on. Edits apply at once on screen and are saved to the server half a second
 * after the last one; leaving the page or switching draft saves right away.
 */
export function useDraft(firstRecipe: string | undefined) {
  const client = useQueryClient();
  const { id: openId, open } = useOpenDraft();
  const list = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const loaded = useQuery({ queryKey: ["drafts", openId], queryFn: () => api.draft(openId!), enabled: Boolean(openId), retry: false, staleTime: Infinity });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState<"saved" | "saving" | "failed">("saved");
  const unsaved = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = unsaved.current;
    if (!d) return;
    unsaved.current = null;
    try {
      const saved = await api.saveDraft(d.id, { recipe: d.recipe, forms: d.forms, count: d.count, look: d.look, chat: d.chat, designer: d.designer });
      client.setQueryData(["drafts", d.id], saved);
      void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      if (!unsaved.current) setSaving("saved");
    } catch {
      setSaving("failed");
    }
  }, [client]);

  // what the server has replaces what is on screen only when another draft is opened
  useEffect(() => {
    if (loaded.data && loaded.data.id !== draft?.id) setDraft(loaded.data);
  }, [loaded.data, draft?.id]);

  // nothing open, or the open one is gone: take the most recent, or start the first one
  const creating = useRef(false);
  useEffect(() => {
    if (!list.data) return;
    if (openId && !loaded.isError) return;
    const newest = list.data.items.find((d) => d.id !== openId);
    if (newest) open(newest.id);
    else if (firstRecipe && !creating.current) {
      creating.current = true;
      void api.createDraft({ recipe: firstRecipe }).then((d) => {
        client.setQueryData(["drafts", d.id], d);
        void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
        open(d.id);
        creating.current = false;
      });
    }
  }, [list.data, openId, loaded.isError, firstRecipe, open, client]);

  // leaving the screen saves what is pending
  useEffect(() => () => void flush(), [flush]);

  // drafts nothing was ever done in pile up (a "New draft" that was left at once): they are thrown away, the open one aside
  const swept = useRef(new Set<string>());
  useEffect(() => {
    if (!list.data || !openId) return;
    const idle = list.data.items.filter((d) => d.empty && d.target === "new" && d.id !== openId && !swept.current.has(d.id));
    if (!idle.length) return;
    for (const d of idle) swept.current.add(d.id);
    void Promise.all(idle.map((d) => api.deleteDraft(d.id).catch(() => {}))).then(() => client.invalidateQueries({ queryKey: ["drafts"], exact: true }));
  }, [list.data, openId, client]);

  const change = useCallback(
    (edit: (d: Draft) => Draft) => {
      setDraft((d) => {
        if (!d) return d;
        const next = edit(d);
        unsaved.current = next;
        return next;
      });
      setSaving("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
    },
    [flush],
  );

  return {
    draft,
    // (an empty one that is not the open one is on its way out: it is not shown)
    drafts: (list.data?.items ?? []).filter((d) => !d.empty || d.id === openId),
    saving,
    setValue: (recipe: string, input: string, value: unknown) =>
      change((d) => ({ ...d, forms: { ...d.forms, [recipe]: { ...d.forms[recipe], [input]: value } } })),
    /** Drop what the draft holds for these inputs: they follow the defaults again. */
    clearValues: (recipe: string, inputs: string[]) =>
      change((d) => ({ ...d, forms: { ...d.forms, [recipe]: Object.fromEntries(Object.entries(d.forms[recipe] ?? {}).filter(([id]) => !inputs.includes(id))) } })),
    /** Another recipe's form. `carried` is what it takes along from the form that is left, where it holds nothing itself (whoever makes `carried` leaves out what the form holds: an empty box counts as nothing). */
    setRecipe: (recipe: string, carried: Record<string, unknown> = {}) =>
      change((d) => ({ ...d, recipe, ...(Object.keys(carried).length ? { forms: { ...d.forms, [recipe]: { ...d.forms[recipe], ...carried } } } : {}) })),
    setLook: (look: Draft["look"]) => change((d) => ({ ...d, look })),
    setChat: (chat: unknown[]) => change((d) => ({ ...d, chat })),
    /** Which language model and instructions this draft's conversation with the designer is held with. */
    setDesigner: (designer: Draft["designer"]) => change((d) => ({ ...d, designer })),
    /** Several inputs of one form at once (what the designer proposed). */
    setValues: (recipe: string, values: Record<string, unknown>) => change((d) => ({ ...d, forms: { ...d.forms, [recipe]: { ...d.forms[recipe], ...values } } })),
    /**
     * A preset: its model when it names one (else the form stays on its model), what it sets laid over
     * the form (the rest of the form is kept), and who is in it when it says.
     */
    apply: (recipe: string | undefined, form: Record<string, unknown>, look: Draft["look"]) =>
      change((d) => {
        const target = recipe ?? d.recipe;
        const says = look && (look.cast.length > 0 || Boolean(look.style) || (look.snippets?.length ?? 0) > 0);
        return { ...d, recipe: target, forms: { ...d.forms, [target]: { ...d.forms[target], ...form } }, look: says ? look : d.look };
      }),
    setCount: (count: number) => change((d) => ({ ...d, count: Math.max(1, Math.min(8, count)) })),
    async switchTo(id: string) {
      await flush();
      open(id);
    },
    async startNew() {
      // the open one is still empty: it is the new draft
      if (draft && holdsNothing(draft)) return;
      await flush();
      const d = await api.createDraft({ recipe: draft?.recipe ?? firstRecipe! });
      client.setQueryData(["drafts", d.id], d);
      void client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      open(d.id);
    },
    async remove(id: string) {
      if (unsaved.current?.id === id) unsaved.current = null;
      await api.deleteDraft(id);
      client.removeQueries({ queryKey: ["drafts", id] });
      // the list first, so that what opens next is chosen among drafts that still exist
      await client.invalidateQueries({ queryKey: ["drafts"], exact: true });
      if (id === openId) {
        setDraft(null);
        open(null);
      }
    },
  };
}
