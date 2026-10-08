import type { ReactNode } from "react";
import { Bookmark, MapPin, Search, Sparkles, User, X } from "lucide-react";
import type { Entity } from "../../api";
import { cx } from "../../ui";

export type Tab = "person" | "place" | "style" | "snippet" | "preset";
export const TABS: Array<{ id: Tab; title: string; add: string; icon: ReactNode }> = [
  { id: "person", title: "People", add: "New person", icon: <User size={22} /> },
  { id: "place", title: "Places", add: "New place", icon: <MapPin size={22} /> },
  { id: "style", title: "Styles", add: "New style", icon: <Sparkles size={22} /> },
  { id: "snippet", title: "Snippets", add: "New snippet", icon: <Bookmark size={22} /> },
  { id: "preset", title: "Presets", add: "New preset", icon: <Bookmark size={22} /> },
];

/** The head of the Prompt kit: the kinds as tabs, each with how many there are, and the search of the kind open. */
export function KitHeader({ tab, onTab, all, query, onQuery }: { tab: Tab; onTab(tab: Tab): void; all: Entity[]; query: string; onQuery(q: string): void }) {
  const here = TABS.find((t) => t.id === tab)!;
  return (
    <header className="grid h-[60px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
      <h1 className="text-base font-semibold">Prompt kit</h1>
      <div role="tablist" aria-label="What to show" className="flex gap-1 rounded-[10px] bg-raised p-[3px]">
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onTab(t.id)} className={cx("flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold whitespace-nowrap", on ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:text-ink")}>
              {t.title} <span className={cx("font-normal", on ? "text-ink-2" : "text-ink-3")}>{all.filter((e) => e.kind === t.id).length}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-end">
        <label className="flex h-9 w-64 min-w-0 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input data-search aria-label={`Search your ${here.title.toLowerCase()}`} placeholder={`Search ${here.title.toLowerCase()}`} value={query} onChange={(e) => onQuery(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
          {query && <button type="button" aria-label="Clear the search" onClick={() => onQuery("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
        </label>
      </div>
    </header>
  );
}
