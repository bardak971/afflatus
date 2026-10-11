import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, failure, lookAdds, raw, type Draft } from "./api";
import { KEEPALIVE_MAX, useAutosave } from "./autosave";
import { useDrafts } from "./data";
import { useProject, type ProjectChoice } from "./project";
import { useBanners, useOpenDraft } from "./store";
import { queryKeys } from "./queryKeys";
import { failedBanner } from "./sayFailed";

const SAVE_AFTER_MS = 500;

/** Nothing was done in it: no value set, nobody in it, no conversation, no name. Such a draft is not worth keeping. */
const holdsNothing = (d: Draft) =>
  !d.name && !d.chat.length && !lookAdds(d.look) && Object.values(d.forms).every((form) => Object.keys(form).length === 0);

/** What a save sends: the whole of what the page holds of the draft. */
/** How many renders one Generate asks for: the batch count's bounds (the stepper stops at them). */
export const BATCH = { least: 1, most: 8 } as const;

export const saveBodyOf = (d: Draft) => ({ recipe: d.recipe, forms: d.forms, count: d.count, look: d.look, chat: d.chat, designer: d.designer });


/**
 * What the save made as the page closes sends: the whole draft when it fits a request that outlives the page; else the
 * draft without its conversation with the designer (the long part, which the server keeps as it was); else nothing can
 * go (null). Past the limit the browser refused the whole save without a word, and the last edits were lost.
 */
export function closingBody(d: Draft): Partial<ReturnType<typeof saveBodyOf>> | null {
  const whole = saveBodyOf(d);
  const size = (b: object) => new TextEncoder().encode(JSON.stringify(b)).length;
  if (size(whole) <= KEEPALIVE_MAX) return whole;
  const { chat: _chat, ...rest } = whole;
  return size(rest) <= KEEPALIVE_MAX ? rest : null;
}

export { inTurn, KEEPALIVE_MAX } from "./autosave";

/**
 * A draft saved, through `raw` rather than `api.saveDraft`: whether the draft is gone (404) is wanted, and a save made
 * as the page closes must outlive the page (`keepalive`). "gone": the server no longer has it.
 */
export async function putDraft(id: string, body: Partial<ReturnType<typeof saveBodyOf>>, keepalive = false): Promise<Draft | "gone"> {
  const res = await raw("PUT", `/drafts/${id}`, body, { keepalive });
  if (res.status === 404) return "gone";
  if (!res.ok) throw await failure(res);
  return (await res.json()) as Draft;
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
 * What becomes of the open draft, of project `draftProject` (null: the Inbox), while the app works in `project`
 * ("none": the Inbox): "keep" when it is there; "follow" (the app works in its project) when it was opened from
 * another project since the last switch, `under` being the project worked in then (null: "everything", a place there
 * is no more); else "leave" for that project's own draft (`pickFor`): the project was switched to since, or the draft was moved.
 */
export function draftFate(draftProject: string | null, under: ProjectChoice | null | undefined, project: ProjectChoice): "keep" | "follow" | "leave" {
  if ((draftProject ?? "none") === project) return "keep";
  return under === project ? "follow" : "leave";
}

/** The draft a project opens on: the one last open in it while it is still in its list, else its newest; never `skip` (the one left, or gone). */
export const pickFor = (items: { id: string }[], last: string | undefined, skip: string | null) =>
  items.find((d) => d.id === last && d.id !== skip) ?? items.find((d) => d.id !== skip);

/**
 * A draft that was just made (from a picture, a workflow, a file's parameters) opened in the form:
 * it is put in the cache, the list is told, it becomes the open draft, and the screen goes to the form.
 */
/**
 * A copy of a draft, as every Duplicate makes it: its forms for every model, its count, its cast, its project, and its name
 * (or the start of its prompt) with " copy"; not what was made from it, nor its conversation with the designer.
 */
export async function duplicateDraft(id: string): Promise<Draft> {
  const d = await api.draft(id);
  const named = (d.name || d.title).trim();
  return api.createDraft({ recipe: d.recipe, forms: d.forms, count: d.count, look: d.look, project: d.projectId, ...(named ? { name: `${named.slice(0, 75)} copy` } : {}) });
}

export function useOpenNewDraft() {
  const client = useQueryClient();
  const open = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  return useCallback(
    (d: { id: string }) => {
      client.setQueryData(queryKeys.drafts.one(d.id), d);
      void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
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
  const { id: openId, under, last, open, remember } = useOpenDraft();
  const project = useProject((s) => s.id);
  const list = useDrafts();
  const say = useBanners((b) => b.push);
  const loaded = useQuery({ queryKey: queryKeys.drafts.one(openId), queryFn: () => api.draft(openId!), enabled: Boolean(openId), retry: false, staleTime: Infinity });

  const [draft, setDraft] = useState<Draft | null>(null);
  // the draft on screen, for what arrives after a wait (a designer's reply, a seed moved after queuing)
  const shown = useRef<Draft | null>(null);
  shown.current = draft;
  // the open draft is of another project than the one looked at (the choice is global, the open draft too)
  const fate = loaded.data ? draftFate(loaded.data.projectId, under, project) : "keep";

  // the edits on screen, saved half a second after the last one (autosave.ts); the saves of drafts go one at a time (see
  // inTurn), the edits of a draft that is not on screen too
  const save = useAutosave<Draft>({
    delayMs: SAVE_AFTER_MS,
    save: async (d) => {
      let saved = await putDraft(d.id, saveBodyOf(d));
      if (saved === "gone") {
        // swept or deleted elsewhere: made again with what is unsaved, which goes on under the new id
        saved = await remade(d);
        const from = d.id;
        const to = saved.id;
        if (unsaved.current && unsaved.current.id === from) unsaved.current = { ...unsaved.current, id: to };
        setDraft((x) => (x && x.id === from ? { ...x, id: to } : x));
        client.removeQueries({ queryKey: queryKeys.drafts.one(from) });
        if (useOpenDraft.getState().id === from) open(to);
      }
      client.setQueryData(queryKeys.drafts.one(saved.id), saved);
      void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
    },
    // closing or reloading the tab: a request that outlives the page, without the conversation when the whole draft is
    // too large for one; when even that cannot go, or the conversation is left out, the browser asks first
    keepalive: (d) => {
      const body = closingBody(d);
      if (body) void putDraft(d.id, body, true).catch(() => {});
    },
    goesWhole: (d) => closingBody(d)?.chat !== undefined,
  });
  const { pending: unsaved, flush, turn, schedule } = save;

  // what the server has replaces what is on screen only when another draft is opened
  useEffect(() => {
    if (loaded.data && loaded.data.id !== draft?.id) setDraft(loaded.data);
  }, [loaded.data, draft?.id]);
  // a rename (from the header or the command bar) is not a form edit: its name is taken at once, the edits on screen kept
  useEffect(() => {
    if (loaded.data && loaded.data.id === draft?.id && loaded.data.name !== draft.name) {
      const name = loaded.data.name;
      setDraft((d) => (d && d.id === loaded.data!.id ? { ...d, name } : d));
      if (unsaved.current && unsaved.current.id === loaded.data.id) unsaved.current = { ...unsaved.current, name };
    }
  }, [loaded.data, draft?.id, draft?.name, unsaved]);

  // the project it is in is remembered as where it was last open; opened from another project, the app follows it there
  useEffect(() => {
    if (!loaded.data) return;
    if (fate === "keep") remember(loaded.data.projectId ?? "none", loaded.data.id);
    else if (fate === "follow") useProject.getState().set(loaded.data.projectId ?? "none");
  }, [loaded.data, fate, remember]);

  // nothing open, the open one is gone, or another project is looked at since: take the one last open in it (else the most recent), or start the first one
  const creating = useRef(false);
  useEffect(() => {
    if (!list.data) return;
    if (openId && !loaded.isError && fate !== "leave") return;
    // what is unsaved of the one left is saved under its own id
    if (fate === "leave") void flush();
    const newest = pickFor(list.data.items, project === null ? undefined : last[project], openId);
    if (newest) open(newest.id);
    else if (firstRecipe && !creating.current) {
      creating.current = true;
      api.createDraft({ recipe: firstRecipe })
        .then((d) => {
          client.setQueryData(queryKeys.drafts.one(d.id), d);
          void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
          open(d.id);
        })
        .catch((err: unknown) => say(failedBanner({ id: "draft:create", once: true, href: "/create", go: "Open the form" }, "A new draft could not be started", err)))
        .finally(() => {
          creating.current = false;
        });
    }
  }, [list.data, openId, loaded.isError, fate, flush, project, last, firstRecipe, open, client, say]);

  const change = useCallback(
    (edit: (d: Draft) => Draft) => {
      setDraft((d) => {
        if (!d) return d;
        const next = edit(d);
        unsaved.current = next;
        return next;
      });
      schedule();
    },
    [unsaved, schedule],
  );

  /**
   * An edit for one draft by its id, whichever is open when it lands: the open one is changed on screen; another
   * (the designer answered, or a seed moved, after a switch) is changed where it is kept, never the open one.
   */
  const editDraft = useCallback(
    async (id: string, edit: (d: Draft) => Draft) => {
      if (shown.current?.id === id) return change(edit);
      const base = unsaved.current?.id === id ? unsaved.current : (client.getQueryData<Draft>(queryKeys.drafts.one(id)) ?? (await api.draft(id)));
      const next = edit(base);
      if (unsaved.current?.id === id) unsaved.current = null;
      const saved = await turn(() => putDraft(id, saveBodyOf(next)));
      // gone meanwhile: nothing left to write into
      if (saved === "gone") return;
      client.setQueryData(queryKeys.drafts.one(id), saved);
      void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
    },
    [change, client, turn, unsaved],
  );

  return {
    // (one of another project is not shown while the project's own is opened)
    draft: fate === "keep" ? draft : null,
    // (an empty one that is not the open one is on its way out: it is not shown)
    drafts: (list.data?.items ?? []).filter((d) => !d.empty || d.id === openId),
    /** How many drafts hold settings and nothing else (no prompt, no name, nothing made). */
    unused: list.data?.unused ?? 0,
    saving: save.state,
    /** Why the last save failed, in the server's words (a cast too large for it, say). */
    failure: save.failure,
    /** Send the edit that could not be saved again. */
    retry: save.retry,
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
    setCount: (count: number) => change((d) => ({ ...d, count: Math.max(BATCH.least, Math.min(BATCH.most, count)) })),
    async switchTo(id: string) {
      await flush();
      open(id);
    },
    async startNew() {
      // the open one is still empty: it is the new draft
      if (draft && holdsNothing(draft)) return;
      await flush();
      const d = await api.createDraft({ recipe: draft?.recipe ?? firstRecipe! });
      client.setQueryData(queryKeys.drafts.one(d.id), d);
      void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
      open(d.id);
    },
    async remove(id: string) {
      if (unsaved.current?.id === id) unsaved.current = null;
      await api.deleteDraft(id);
      client.removeQueries({ queryKey: queryKeys.drafts.one(id) });
      // the list first, so that what opens next is chosen among drafts that still exist
      await client.invalidateQueries({ queryKey: queryKeys.drafts.lists() });
      if (id === openId) {
        setDraft(null);
        open(null);
      }
    },
  };
}
