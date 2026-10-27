import { useEffect, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, ChevronDown, ChevronRight, Copy, Trash2 } from "lucide-react";
import { ContextMenu, headLine, useMenu, type MenuItem } from "../../ContextMenu";
import { ask } from "../../Confirm";
import { fuzzyFilter } from "@afflatus/core";
import { api, raw, type Entity } from "../../api";
import { ringBy, useKitEdits } from "../../agentEdits";
import { useAutosave } from "../../autosave";
import { Select } from "../../Select";
import { AutoText, Button, Checkbox, cx, Empty, ErrorNote, fieldClass, Segmented, TwoStep } from "../../ui";
import { remember, remembered, textOf } from "./shared";
import { useSayFailed } from "../../sayFailed";
import { copyText } from "../../secureContext";
import { useBanners } from "../../store";
import { kitHref } from "./link";
import { queryKeys } from "../../queryKeys";

export type Snippet = Extract<Entity, { kind: "snippet" }>;

const OPEN_KEY = "afflatus.kit.categories";

const cell = "w-full rounded-md border border-transparent bg-transparent px-2 text-ink placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-raised";
const STYLE_WORDS = { any: "Any prompt", tags: "Tags", sentences: "Natural language" } as const;

/**
 * One snippet as a row that is changed where it stands. Its name and its category are kept when the
 * field is left (a row does not jump to another place while it is typed in); its text also a moment
 * after the typing stops. Saved through autosave.ts, as the kit's items are: what was typed in the last
 * moment goes as the row is folded away or the screen left, and as the tab closes by a request that
 * outlives the page; a save that fails is sent again by the next one, and the browser asks before the tab closes.
 */
function SnippetRow({ snippet, ticked, onTick, fresh }: { snippet: Snippet; ticked: boolean; onTick(on: boolean): void; fresh: boolean }) {
  const client = useQueryClient();
  const [name, setName] = useState(snippet.name);
  const [category, setCategory] = useState(snippet.def.category);
  const [text, setText] = useState(snippet.def.text);
  // moved to another category from the bar above, or renamed elsewhere: the row follows
  useEffect(() => setCategory(snippet.def.category), [snippet.def.category]);
  useEffect(() => setName(snippet.name), [snippet.name]);
  type Body = { name: string; def: Snippet["def"] };
  const save = useAutosave<Body>({
    delayMs: 800,
    save: async (next) => {
      await api.saveEntity(snippet.id, next);
      await client.invalidateQueries({ queryKey: queryKeys.entities() });
    },
    keepalive: (next) => void raw("PUT", `/entities/${snippet.id}`, next, { keepalive: true }).catch(() => {}),
  });
  // its text changed by an MCP token: the row follows, unless the user has typed something not saved yet (theirs goes after)
  useEffect(() => {
    if (!save.pending.current) setText(snippet.def.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the saved text alone; what waits to be saved is read as it is
  }, [snippet.def.text]);
  // changed by an MCP token, not edited by the user since: ringed with its name (agentEdits.ts)
  const by = useKitEdits((st) => ringBy(st.rings[snippet.id], "text", "category", "style", "name"));
  const remove = useMutation({ mutationFn: () => api.deleteEntity(snippet.id), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.entities() }) });
  /** The row as it is now, with `over` changed, waits to be saved; `now`: sent at once (a field left, a style chosen). */
  const commit = (over: { name?: string; category?: string; text?: string; style?: Snippet["def"]["style"] } = {}, now = true) => {
    const next = {
      name: (over.name ?? name).trim() || "Unnamed",
      def: { text: over.text ?? text, category: (over.category ?? category).trim(), style: over.style !== undefined ? over.style : snippet.def.style },
    };
    const same = next.name === snippet.name && next.def.text === snippet.def.text && next.def.category === snippet.def.category && next.def.style === snippet.def.style;
    // a change typed and then undone by hand still goes: the one before it is waiting, or on its way
    if (same && !save.pending.current) return;
    useKitEdits.getState().clear(snippet.id, ["text", "category", "style", "name"]);
    save.queue(next);
    if (now) void save.flush();
  };
  const leaveOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  // right-click on the row (not in its fields, which keep the browser's own menu for the text)
  const menu = useMenu<true>();
  const say = useBanners((b) => b.push);
  const failed = useSayFailed({ id: "kit", href: kitHref("snippet"), go: "Open the snippets" });
  // what it holds first, then ticking it with others (the library's Select), Delete last: it asks first, so "…"
  const items: MenuItem[] = [
    // said in a banner, as the seed is: a menu item shows nothing once it closes
    { label: "Copy its text", icon: <Copy size={14} />, run: () => void copyText(text).then(() => say({ id: `copied:${Date.now()}`, tone: "good", title: `Text of ${snippet.name} copied` }), failed("Could not copy the snippet")) },
    "—",
    { label: "Select", icon: <CheckSquare size={14} />, checked: ticked, note: "to move or delete several", run: () => onTick(!ticked) },
    "—",
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, run: () => void ask({ title: `Delete the snippet ${snippet.name}?`, text: "It goes from every draft that uses it.", yes: "Delete" }).then((yes) => yes && remove.mutate()) },
  ];
  return (
    <div onContextMenu={(e) => { if (!(e.target as HTMLElement).closest("input, textarea")) menu.open(e, true); }} data-agent={by} data-tip={by ? `Changed by ${by}` : undefined} className={cx("grid grid-cols-[auto_minmax(110px,190px)_minmax(90px,150px)_minmax(0,1fr)_148px_auto] items-start gap-1.5 rounded-lg px-1.5 py-0.5", ticked ? "bg-accent-wash" : "hover:bg-panel", by && "ring-1 ring-picture/55")}>
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Snippet ${snippet.name}`} head={{ title: snippet.name, sub: headLine("Snippet", snippet.def.category || "no category") }} items={items} onClose={menu.close} />}
      <span className="flex h-8 w-7 items-center justify-center">
        <Checkbox label={`Tick ${snippet.name}`} checked={ticked} onChange={onTick} />
      </span>
      <input
        aria-label="Name of the snippet" value={name} maxLength={120} autoFocus={fresh}
        onFocus={(e) => fresh && e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)} onBlur={() => commit()} onKeyDown={leaveOnEnter}
        className={cx(cell, "h-8 font-semibold")}
      />
      <input
        aria-label={`Category of ${snippet.name}`} value={category} maxLength={40} placeholder="No category"
        onChange={(e) => setCategory(e.target.value)} onBlur={() => commit()} onKeyDown={leaveOnEnter}
        className={cx(cell, "h-8 text-ink-2")}
      />
      <AutoText
        aria-label={`Text of ${snippet.name}`} rows={1} value={text} placeholder="Its text. {a|b|c} is a wildcard: one is picked each time"
        onChange={(e) => {
          setText(e.target.value);
          commit({ text: e.target.value }, false);
        }}
        onBlur={() => commit()}
        className={cx(cell, "py-1.5 leading-normal")}
      />
      <Select
        size="sm" className="h-8" label={`The prompt style ${snippet.name} is written for`}
        value={snippet.def.style ?? "any"}
        onChange={(v) => commit({ style: v === "any" ? null : (v as "tags" | "sentences") })}
        options={(["any", "tags", "sentences"] as const).map((v) => ({ value: v, label: STYLE_WORDS[v] }))}
      />
      <TwoStep title={`Delete the snippet ${snippet.name}`} stay yes="Delete" onYes={() => remove.mutate()} />
      {(save.failure || remove.isError) && <div className="col-span-6"><ErrorNote>{save.failure ?? remove.error?.message}</ErrorNote></div>}
    </div>
  );
}

/**
 * Every snippet as a list that is changed in place: by category (each folds away), narrowed to one
 * category or by the search, several ticked at once to move them to another category or delete them.
 * The category it is narrowed to and the snippet just made are the screen's: its New button makes one
 * in that category.
 */
export function SnippetTable({ snippets, query, only, onOnly: setOnly, fresh }: {
  snippets: Snippet[];
  query: string;
  /** The one category shown; null for all. */
  only: string | null;
  onOnly(only: string | null): void;
  /** The snippet just made: its name is in focus, its category open. */
  fresh: string | null;
}) {
  const client = useQueryClient();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [folds, setFolds] = useState<Record<string, boolean>>(() => remembered(OPEN_KEY, {}));
  const [newCategory, setNewCategory] = useState("");
  const categories = [...new Set(snippets.map((s) => s.def.category))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
  const narrowed = only === null ? snippets : snippets.filter((s) => s.def.category === only);
  const found = query.trim() ? fuzzyFilter(narrowed, query, textOf) : narrowed;
  // a category that is gone (its last snippet moved away) is no filter any more
  useEffect(() => {
    if (only !== null && !snippets.some((s) => s.def.category === only)) setOnly(null);
  }, [only, snippets, setOnly]);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.entities() });
  // what a move or a delete touches: the ticked ones still shown, never one the search or the category hides
  const chosen = found.filter((s) => ticked.has(s.id));
  const move = useMutation({
    mutationFn: (category: string) => Promise.all(chosen.map((s) => api.saveEntity(s.id, { def: { ...s.def, category } }))),
    onSuccess: () => {
      setTicked(new Set());
      return refresh();
    },
  });
  const removeAll = useMutation({
    mutationFn: () => Promise.all(chosen.map((s) => api.deleteEntity(s.id))),
    onSuccess: () => {
      setTicked(new Set());
      return refresh();
    },
  });
  // a long list starts folded; a search, one category or a short list shows everything
  const narrow = Boolean(query.trim()) || only !== null || snippets.length <= 40;
  const isOpen = (c: string) => narrow || (folds[c] ?? false) || found.some((s) => s.id === fresh && s.def.category === c);
  const fold = (c: string, open: boolean) => {
    const next = { ...folds, [c]: open };
    setFolds(next);
    remember(OPEN_KEY, next);
  };
  const tick = (ids: string[], on: boolean) => setTicked((old) => {
    const next = new Set(old);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    return next;
  });
  // "" is the snippets with no category, so "every one" is a value no category can be
  const EVERY = "\u0000every";
  const choice = (label: string, count: number, value: string) => ({ value, label: <>{label} <span className="font-normal text-ink-3">{count}</span></> });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented
          size="sm"
          label="Which category"
          value={only ?? EVERY}
          options={[choice("All", snippets.length, EVERY), ...categories.map((c) => choice(c || "No category", snippets.filter((s) => s.def.category === c).length, c))]}
          onChange={(v) => setOnly(v === EVERY ? null : v)}
        />
      </div>
      {chosen.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-panel px-3 py-2">
          <span className="font-semibold">{chosen.length} ticked</span>
          <div className="w-52">
            <Select
              size="sm" label="Move the ticked snippets to a category" placeholder="Move to a category" value=""
              onChange={(c) => move.mutate(c === "__none__" ? "" : c)}
              options={[...categories.filter(Boolean).map((c) => ({ value: c, label: c })), { value: "__none__", label: "No category" }]}
              footer={(close) => (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newCategory.trim()) return;
                    move.mutate(newCategory.trim());
                    setNewCategory("");
                    close();
                  }}
                >
                  <input aria-label="A new category" placeholder="A new category" maxLength={40} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={cx("h-8 min-w-0 grow", fieldClass)} />
                  <Button size="sm" tone="quiet" type="submit" disabled={!newCategory.trim()}>Move</Button>
                </form>
              )}
            />
          </div>
          <TwoStep title={`Delete the ${chosen.length} ticked snippets`} stay yes={`Delete ${chosen.length}`} onYes={() => removeAll.mutate()} />
          <span className="grow" />
          <Button size="sm" tone="quiet" onClick={() => setTicked(new Set())}>Untick all</Button>
        </div>
      )}
      {(move.isError || removeAll.isError) && <ErrorNote>{(move.error ?? removeAll.error)?.message}</ErrorNote>}
      {snippets.length === 0 && (
        <Empty title="No snippets yet" helpTitle="Snippets" help={`A snippet is a bit of prompt text kept under a name: a pose, a light, a camera move. Under "Snippets" above a form, tick it and it is appended to your prompt each time you generate; the dice ticks one of each category at random.`} />
      )}
      {snippets.length > 0 && found.length === 0 && <Empty title="Nothing matches" />}
      {found.length > 0 && (
        <div className="grid grid-cols-[auto_minmax(110px,190px)_minmax(90px,150px)_minmax(0,1fr)_148px_auto] gap-1.5 px-1.5 text-meta font-bold tracking-label text-ink-3 uppercase">
          <span className="w-7" /><span className="px-2">Name</span><span className="px-2">Category</span><span className="px-2">Text</span><span>Prompt style</span><span className="w-8" />
        </div>
      )}
      {categories.filter((c) => found.some((s) => s.def.category === c)).map((c) => {
        const rows = found.filter((s) => s.def.category === c);
        const open = isOpen(c);
        const all = rows.every((s) => ticked.has(s.id));
        return (
          <section key={c || "none"} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 border-b border-line pb-1">
              <span className="flex h-7 w-7 items-center justify-center pl-1.5" data-tip={`Tick every snippet of ${c || "no category"}`}>
                <Checkbox label={`Tick every snippet of ${c || "no category"}`} checked={all} onChange={(on) => tick(rows.map((s) => s.id), on)} />
              </span>
              <button type="button" aria-expanded={open} disabled={narrow} onClick={() => fold(c, !open)} className="flex grow items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-bold tracking-label text-ink-2 uppercase enabled:hover:text-ink">
                {!narrow && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                {c || "No category"}
                <span className="font-normal text-ink-3">{rows.length}</span>
              </button>
            </div>
            {open && rows.map((s) => <SnippetRow key={s.id} snippet={s} ticked={ticked.has(s.id)} onTick={(on) => tick([s.id], on)} fresh={fresh === s.id} />)}
          </section>
        );
      })}
    </div>
  );
}
