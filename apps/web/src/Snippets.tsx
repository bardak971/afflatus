import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ChevronDown, ChevronRight, Dices, Plus, Search, X } from "lucide-react";
import { fuzzyFilter } from "@afflatus/core";
import { api, type Entity, type Look } from "./api";
import { useEntities } from "./data";
import { Popover } from "./Popover";
import { AutoText, Button, cx, ErrorNote } from "./ui";

type Snippet = Extract<Entity, { kind: "snippet" }>;
const none: Look = { cast: [], style: null, snippets: [] };
const OPEN_KEY = "afflatus.snippets.open";

const readOpen = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};

/** One snippet of each category, picked at random: a new combination to try. */
export function rollSnippets(snippets: Snippet[], random: () => number = Math.random): string[] {
  const groups = new Map<string, Snippet[]>();
  for (const s of snippets) {
    if (!s.def.category) continue;
    groups.set(s.def.category, [...(groups.get(s.def.category) ?? []), s]);
  }
  return [...groups.values()].map((pool) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!.id);
}

/**
 * Snippets: bits of text kept under a name, in categories of your own (pose, light, camera…). A
 * ticked one is added after what you wrote each time something is made, without touching your text;
 * "Roll" ticks one of each category at random. They open in a panel over the page, so the column
 * stays as it is; the ticked ones show as chips under the button.
 */
export function Snippets({ style, look, onLook, text, onInsert }: {
  /** How the form's main text is written: snippets written for the other kind are listed apart. */
  style: "tags" | "sentences";
  look: Look | null;
  onLook(look: Look): void;
  /** What the main text box holds now, to keep as a new snippet. */
  text: string;
  /** Write text into the main box. */
  onInsert(text: string): void;
}) {
  const entities = useEntities();
  const client = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<{ name: string; category: string; text: string } | null>(null);
  const [openCats, setOpenCats] = useState(readOpen);
  const all = useMemo(() => (entities.data?.items ?? []).filter((e): e is Snippet => e.kind === "snippet"), [entities.data]);
  const now = look ?? none;
  const ticked = now.snippets ?? [];
  const set = (ids: string[]) => onLook({ ...now, snippets: ids });
  const toggle = (id: string) => set(ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]);

  // the ones written for this kind of prompt (or for any); the others are listed last, apart
  const mine = all.filter((s) => !s.def.style || s.def.style === style);
  const others = all.filter((s) => s.def.style && s.def.style !== style);
  const categories = [...new Set(all.map((s) => s.def.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const found = query.trim() ? fuzzyFilter(all, query, (s) => `${s.name} ${s.def.category} ${s.def.text}`) : null;
  const groups = useMemo(() => {
    const m = new Map<string, Snippet[]>();
    for (const s of mine) m.set(s.def.category, [...(m.get(s.def.category) ?? []), s]);
    // named categories in order, what has none last
    return [...m.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0]));
  }, [mine]);
  const flip = (key: string, to: boolean) => {
    const next = { ...openCats, [key]: to };
    setOpenCats(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      // nowhere to remember it: it stays for this visit
    }
  };

  const save = useMutation({
    mutationFn: (v: { name: string; category: string; text: string }) => api.createEntity("snippet", v.name.trim(), { text: v.text.trim(), category: v.category.trim(), style }),
    onSuccess: (made) => {
      setAdding(null);
      setQuery("");
      if (made.kind === "snippet" && made.def.category) flip(made.def.category, true);
      return client.invalidateQueries({ queryKey: ["entities"] });
    },
  });

  const chip = (s: Snippet) => {
    const on = ticked.includes(s.id);
    return (
      <button
        key={s.id}
        type="button"
        aria-pressed={on}
        title={s.def.text}
        onClick={() => toggle(s.id)}
        className={cx("max-w-full truncate rounded-full border px-2.5 py-1 text-xs", on ? "border-accent bg-accent-wash font-semibold text-ink" : "border-line-strong text-ink-2 hover:text-ink")}
      >
        {s.name}
      </button>
    );
  };
  const group = (key: string, title: string, items: Snippet[], startsOpen: boolean) => {
    const isOpen = openCats[key] ?? startsOpen;
    const on = items.filter((s) => ticked.includes(s.id)).length;
    return (
      <div key={key} className="flex flex-col gap-1.5">
        <button type="button" aria-expanded={isOpen} onClick={() => flip(key, !isOpen)} className="flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase hover:bg-hover hover:text-ink">
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="grow">{title}</span>
          {on > 0 && <span className="text-accent normal-case">{on} ticked</span>}
          <span className="font-normal normal-case">{items.length}</span>
        </button>
        {isOpen && <div className="flex flex-wrap gap-1.5 px-1 pb-1">{items.map(chip)}</div>}
      </div>
    );
  };
  const tickedHere = ticked.map((id) => all.find((s) => s.id === id)).filter((s): s is Snippet => Boolean(s));
  const rollable = new Set(mine.map((s) => s.def.category).filter(Boolean)).size;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx("flex h-8 items-center gap-1.5 rounded-lg border-[1.5px] border-dashed px-3 text-xs font-semibold", tickedHere.length ? "border-accent text-ink" : "border-line-strong text-ink-2 hover:text-ink")}
      >
        <Bookmark size={13} className="shrink-0" /> Snippets{tickedHere.length ? ` · ${tickedHere.length}` : ""}
      </button>
      {rollable > 0 && (
        <button type="button" title="Tick one snippet of each category at random, in place of the ones ticked now" onClick={() => set(rollSnippets(mine))} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong text-ink-2 hover:bg-hover hover:text-ink" aria-label="Roll: one snippet of each category at random">
          <Dices size={14} />
        </button>
      )}
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Snippets" width={440} height={520}>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line p-2">
            <span className="flex h-8 min-w-0 grow items-center gap-2 rounded-md bg-raised px-2">
              <Search size={13} className="shrink-0 text-ink-3" />
              <input data-search autoFocus aria-label="Search your snippets" placeholder={`Search ${all.length} snippet${all.length === 1 ? "" : "s"}`} value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
              {query && <button type="button" aria-label="Clear the search" onClick={() => setQuery("")} className="text-ink-2 hover:text-ink"><X size={13} /></button>}
            </span>
            <Button size="sm" disabled={!rollable} title={rollable ? "Tick one snippet of each category at random, in place of the ones ticked now" : "Give your snippets categories: a roll ticks one of each"} onClick={() => set(rollSnippets(mine))}>
              <Dices size={13} /> Roll
            </Button>
            <Button size="sm" tone={adding ? "quiet" : "plain"} onClick={() => setAdding(adding ? null : { name: "", category: "", text: text.trim() })}><Plus size={13} /> New</Button>
          </div>
          {adding && (
            <form
              className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-raised p-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (adding.name.trim() && adding.text.trim()) save.mutate(adding);
              }}
            >
              <div className="flex gap-1.5">
                <input autoFocus aria-label="Name of the new snippet" placeholder="Name" maxLength={120} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md border border-line bg-ground px-2 placeholder:text-ink-3" />
                <input aria-label="Category of the new snippet" placeholder="Category (pose, light…)" maxLength={40} value={adding.category} onChange={(e) => setAdding({ ...adding, category: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="h-8 w-40 shrink-0 rounded-md border border-line bg-ground px-2 placeholder:text-ink-3" />
              </div>
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {categories.map((c) => (
                    <button key={c} type="button" onClick={() => setAdding({ ...adding, category: c })} className={cx("rounded-full px-2 py-0.5 text-[11px]", adding.category.trim().toLowerCase() === c.toLowerCase() ? "bg-line-strong text-ink-strong" : "bg-hover text-ink-2 hover:text-ink")}>{c}</button>
                  ))}
                </div>
              )}
              <AutoText aria-label="Text of the new snippet" rows={2} placeholder={style === "tags" ? "tags, tags… {a|b} is a wildcard: one is picked each time" : "A sentence or two. {a|b} is a wildcard: one is picked each time"} value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="rounded-md border border-line bg-ground px-2 py-1.5 text-[13px] placeholder:text-ink-3" />
              {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
              <div className="flex items-center justify-end gap-1.5">
                <span className="mr-auto text-xs text-ink-3">{text.trim() ? "Starts with the prompt in the form." : ""}</span>
                <Button size="sm" tone="quiet" onClick={() => setAdding(null)}>Cancel</Button>
                <Button size="sm" tone="primary" type="submit" disabled={!adding.name.trim() || !adding.text.trim() || save.isPending}>Save</Button>
              </div>
            </form>
          )}
          <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto p-2">
            {all.length === 0 && !adding && <span className="p-2 text-ink-2">No snippets yet. Keep a bit of prompt text under a name with "New": a pose, a light, a camera move. Tick it and it is appended to your prompt each time.</span>}
            {found && (found.length ? <div className="flex flex-wrap gap-1.5 p-1">{found.map(chip)}</div> : <span className="p-2 text-ink-2">Nothing matches.</span>)}
            {!found && groups.map(([cat, items]) => group(`c:${cat}`, cat || (groups.length > 1 ? "No category" : "All"), items, groups.length <= 3))}
            {!found && others.length > 0 && group("other-style", `Written for ${style === "tags" ? "natural-language" : "tag"} prompts`, others, false)}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-xs text-ink-2">
            <span>{tickedHere.length ? `${tickedHere.length} ticked: appended to your prompt, each time` : "Tick a snippet: it is appended to your prompt, each time"}</span>
            <span className="grow" />
            {tickedHere.length > 0 && (
              <>
                <button
                  type="button"
                  title="Insert their text into the prompt and untick them: for when you want to edit the words"
                  className="text-accent hover:underline"
                  onClick={() => {
                    onInsert(tickedHere.map((s) => s.def.text.trim()).filter(Boolean).join(style === "tags" ? ", " : " "));
                    set(ticked.filter((id) => !tickedHere.some((s) => s.id === id)));
                  }}
                >
                  Insert into prompt
                </button>
                <button type="button" className="hover:text-ink hover:underline" onClick={() => set([])}>Untick all</button>
              </>
            )}
            <Link href="/kit#snippets" className="underline hover:text-ink" onClick={() => setOpen(false)}>Edit in the Prompt kit</Link>
          </div>
        </Popover>
      )}
    </>
  );
}

/** The ticked snippets as chips, each with a cross to untick it. Nothing when none is ticked. */
export function TickedSnippets({ look, onLook }: { look: Look | null; onLook(look: Look): void }) {
  const entities = useEntities();
  const ticked = look?.snippets ?? [];
  if (!ticked.length) return null;
  const all = entities.data?.items ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ticked.map((id) => {
        const s = all.find((e) => e.id === id);
        if (!s || s.kind !== "snippet") return null;
        return (
          <span key={id} title={s.def.text} className="flex h-7 items-center gap-1 rounded-full border border-accent bg-accent-wash pr-1 pl-2.5 text-xs font-semibold">
            <span className="max-w-40 truncate">{s.name}</span>
            <button type="button" aria-label={`Untick ${s.name}`} onClick={() => onLook({ ...(look ?? none), snippets: ticked.filter((x) => x !== id) })} className="flex h-5 w-5 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"><X size={11} /></button>
          </span>
        );
      })}
    </div>
  );
}
