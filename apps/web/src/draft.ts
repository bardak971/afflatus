import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, ApiError, lookAdds, type Draft } from "./api";
import { DRAFT_LIST, useDrafts } from "./data";
import { useBanners, useOpenDraft } from "./store";

const SAVE_AFTER_MS = 500;

/** Nothing was done in it: no value set, nobody in it, no conversation, no name. Such a draft is not worth keeping. */
const holdsNothing = (d: Draft) =>
  !d.name && !d.chat.length && !lookAdds(d.look) && Object.values(d.forms).every((form) => Object.keys(form).length === 0);

/** What a save sends: the whole of what the page holds of the draft. */
export const saveBodyOf = (d: Draft) => ({ recipe: d.recipe, forms: d.forms, count: d.count, look: d.look, chat: d.chat, designer: d.designer });

/**
 * A draft saved, through fetch itself rather than `api`: whether the draft is gone (404) is wanted, and a
 * save made as the page closes must outlive the page (`keepalive`). "gone": the server no longer has it.
 */
export async function putDraft(id: string, body: ReturnType<typeof saveBodyOf>, keepalive = false): Promise<Draft | "gone"> {
  const res = await fetch(`/api/drafts/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Afflatus": "1" }, body: JSON.stringify(body), keepalive });
  if (res.status === 404) return "gone";
  const data = (await res.json().catch(() => ({}))) as Draft & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
  return data;
}

/**
 * A draft the server no longer has (swept as idle while it sat open in this tab, deleted from another one),
 * made again with what the page holds of it. Its new id comes back.
 */
export async function remade(d: Draft): Promise<Draft> {
  const made = await api.createDraft({ recipe: d.recipe, forms: d.forms, count: d.count, look: d.look, project: d.projectId });
  // what a new draft cannot be made with: put in at once
  return d.chat.length || d.designer || d.name ? api.saveDraft(made.id, { chat: d.chat, designer: d.designer, ...(d.name ? { name: d.name } : {}) }) : made;
}

/**
 * A draft that was just made (from a picture, a workflow, a file's parameters) opened in the form:
 * it is put in the cache, the list is told, it becomes the open draft, and the screen goes to the form.
 */
export function useOpenNewDraft() {
  const client = useQueryClient();
  const open = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  return useCallback(
    (d: { id: string }) => {
      client.setQueryData(["drafts", d.id], d);
      void client.invalidateQueries({ queryKey: DRAFT_LIST });
      open(d.id);
      go("/create");
    },
    [client, open, go],
  );
}

/**
 * The draft being worked on. Edits apply at once on screen and are saved to the server half a second
 * after the last one; leaving the page, closing the tab or switching draft saves right away. A save that
 * fails keeps the edit: the next flush, or Retry, sends it again. A draft the server no longer has is made
 * again with what is on screen.
 */
export function useDraft(firstRecipe: string | undefined) {
  const client = useQueryClient();
  const { id: openId, open } = useOpenDraft();
  const list = useDrafts();
  const say = useBanners((b) => b.push);
  const loaded = useQuery({ queryKey: ["drafts", openId], queryFn: () => api.draft(openId!), enabled: Boolean(openId), retry: false, staleTime: Infinity });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState<"saved" | "saving" | "failed">("saved");
  /** Why the last save failed, in the server's words (a cast too large for it, say). */
  const [failure, setFailure] = useState<string | null>(null);
  const unsaved = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the draft on screen, for what arrives after a wait (a designer's reply, a seed moved after queuing)
  const shown = useRef<Draft | null>(null);
  shown.current = draft;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = unsaved.current;
    if (!d) return;
    try {
      let saved = await putDraft(d.id, saveBodyOf(d));
      if (saved === "gone") {
        // swept or deleted elsewhere: made again with what is unsaved, which goes on under the new id
        saved = await remade(d);
        const from = d.id;
        const to = saved.id;
        if (unsaved.current && unsaved.current.id === from) unsaved.current = { ...unsaved.current, id: to };
        setDraft((x) => (x && x.id === from ? { ...x, id: to } : x));
        client.removeQueries({ queryKey: ["drafts", from] });
        if (useOpenDraft.getState().id === from) open(to);
      }
      // what was sent is saved; an edit made meanwhile is still waiting
      if (unsaved.current === d) unsaved.current = null;
      client.setQueryData(["drafts", saved.id], saved);
      void client.invalidateQueries({ queryKey: DRAFT_LIST });
      if (!unsaved.current) {
        setSaving("saved");
        setFailure(null);
      }
    } catch (err) {
      // the edit stays in `unsaved`: the next flush sends it again
      setSaving("failed");
      setFailure((err as Error).message);
    }
  }, [client, open]);

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
      api.createDraft({ recipe: firstRecipe })
        .then((d) => {
          client.setQueryData(["drafts", d.id], d);
          void client.invalidateQueries({ queryKey: DRAFT_LIST });
          open(d.id);
        })
        .catch((err: Error) => say({ id: "draft:create", tone: "bad", title: "A new draft could not be started", text: err.message, href: "/create", go: "Open the form" }))
        .finally(() => {
          creating.current = false;
        });
    }
  }, [list.data, openId, loaded.isError, firstRecipe, open, client, say]);

  // leaving the screen saves what is pending
  useEffect(() => () => void flush(), [flush]);
  // so does closing or reloading the tab: a request that outlives the page. While a save has failed, the browser asks first.
  useEffect(() => {
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const d = unsaved.current;
      if (d) void putDraft(d.id, saveBodyOf(d), true).catch(() => {});
    };
    const ask = (e: BeforeUnloadEvent) => {
      if (saving !== "failed") return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", ask);
    };
  }, [saving]);

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

  /**
   * An edit for one draft by its id, whichever is open when it lands: the open one is changed on screen; another
   * (the designer answered, or a seed moved, after a switch) is changed where it is kept, never the open one.
   */
  const editDraft = useCallback(
    async (id: string, edit: (d: Draft) => Draft) => {
      if (shown.current?.id === id) return change(edit);
      const base = unsaved.current?.id === id ? unsaved.current : (client.getQueryData<Draft>(["drafts", id]) ?? (await api.draft(id)));
      const next = edit(base);
      if (unsaved.current?.id === id) unsaved.current = null;
      const saved = await putDraft(id, saveBodyOf(next));
      // gone meanwhile: nothing left to write into
      if (saved === "gone") return;
      client.setQueryData(["drafts", id], saved);
      void client.invalidateQueries({ queryKey: DRAFT_LIST });
    },
    [change, client],
  );

  return {
    draft,
    // (an empty one that is not the open one is on its way out: it is not shown)
    drafts: (list.data?.items ?? []).filter((d) => !d.empty || d.id === openId),
    saving,
    failure,
    /** Send the edit that could not be saved again. */
    retry: () => {
      setSaving("saving");
      void flush();
    },
    editDraft,
    setValue: (recipe: string, input: string, value: unknown) =>
      change((d) => ({ ...d, forms: { ...d.forms, [recipe]: { ...d.forms[recipe], [input]: value } } })),
    /** Drop what the draft holds for these inputs: they follow the defaults again. */
    clearValues: (recipe: string, inputs: string[]) =>
      change((d) => ({ ...d, forms: { ...d.forms, [recipe]: Object.fromEntries(Object.entries(d.forms[recipe] ?? {}).filter(([id]) => !inputs.includes(id))) } })),
    /** Another recipe's form. `carried` is what it takes along from the form that is left, where it holds nothing itself (whoever makes `carried` leaves out what the form holds: an empty box counts as nothing). */
    setRecipe: (recipe: string, carried: Record<string, unknown> = {}) =>
      change((d) => ({ ...d, recipe, ...(Object.keys(carried).length ? { forms: { ...d.forms, [recipe]: { ...d.forms[recipe], ...carried } } } : {}) })),
    setLook: (look: Draft["look"]) => change((d) => ({ ...d, look })),
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
        return { ...d, recipe: target, forms: { ...d.forms, [target]: { ...d.forms[target], ...form } }, look: lookAdds(look) ? look : d.look };
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
      void client.invalidateQueries({ queryKey: DRAFT_LIST });
      open(d.id);
    },
    async remove(id: string) {
      if (unsaved.current?.id === id) unsaved.current = null;
      await api.deleteDraft(id);
      client.removeQueries({ queryKey: ["drafts", id] });
      // the list first, so that what opens next is chosen among drafts that still exist
      await client.invalidateQueries({ queryKey: DRAFT_LIST });
      if (id === openId) {
        setDraft(null);
        open(null);
      }
    },
  };
}
