import type { ReactNode } from "react";
import { Bookmark, MapPin, Plus, Puzzle, Search, Sparkles, User, X } from "lucide-react";
import type { Entity } from "../../api";
import { Button, Segmented } from "../../ui";

export type Tab = "person" | "place" | "style" | "snippet" | "preset";
export const TABS: Array<{ id: Tab; title: string; add: string; icon: ReactNode }> = [
  { id: "person", title: "People", add: "New person", icon: <User size={22} /> },
  { id: "place", title: "Places", add: "New place", icon: <MapPin size={22} /> },
  { id: "style", title: "Styles", add: "New style", icon: <Sparkles size={22} /> },
  { id: "snippet", title: "Snippets", add: "New snippet", icon: <Puzzle size={22} /> },
  { id: "preset", title: "Presets", add: "New preset", icon: <Bookmark size={22} /> },
];

/**
 * The head of the Prompt kit: the kinds as tabs, each with how many there are, the search of the kind open,
 * and the one New button, for that kind (`extra` sits before it: the presets' Import).
 */
export function KitHeader({ tab, onTab, all, query, onQuery, newLabel, onNew, busy, extra }: {
  tab: Tab;
  onTab(tab: Tab): void;
  all: Entity[];
  query: string;
  onQuery(q: string): void;
  /** What the New button says: the tab's own word unless given ("New snippet in Light"). */
  newLabel?: string;
  onNew(): void;
  busy?: boolean;
  extra?: ReactNode;
}) {
  const here = TABS.find((t) => t.id === tab)!;
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-line px-6">
      <h1 className="shrink-0 text-lg font-bold">Prompt kit</h1>
      <Segmented<Tab>
        oneLine
        label="What to show"
        value={tab}
        options={TABS.map((t) => ({ value: t.id, label: <>{t.title} <span className={t.id === tab ? "font-normal text-ink-2" : "font-normal text-ink-3"}>{all.filter((e) => e.kind === t.id).length}</span></> }))}
        onChange={onTab}
      />
      <span className="grow" />
      <label className="flex h-9 w-60 min-w-0 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-ink-3" />
        <input data-search aria-label={`Search your ${here.title.toLowerCase()}`} placeholder={`Search ${here.title.toLowerCase()}`} value={query} onChange={(e) => onQuery(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
        {query && <button type="button" aria-label="Clear the search" onClick={() => onQuery("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
      </label>
      {extra}
      <Button size="sm" tone="primary" disabled={busy} onClick={onNew} className="flex h-9 shrink-0 items-center gap-1.5"><Plus size={14} /> {newLabel ?? here.add}</Button>
    </header>
  );
}
