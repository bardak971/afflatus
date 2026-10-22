import { useState, type ReactNode } from "react";
import { Bookmark, MapPin, Plus, Puzzle, Search, Sparkles, User } from "lucide-react";
import type { Entity } from "../../api";
import { Button, IconButton, PageHeader, SearchField, SegmentCount, Segmented } from "../../ui";

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
export function KitHeader({ tab, onTab, all, loading, query, onQuery, newLabel, onNew, busy, extra }: {
  tab: Tab;
  onTab(tab: Tab): void;
  all: Entity[];
  /** The kit is still on its way: each count is a dash, not a "0" that reads as an empty kind. */
  loading?: boolean;
  query: string;
  onQuery(q: string): void;
  /** What the New button says: the tab's own word unless given ("New snippet in Light"). */
  newLabel?: string;
  onNew(): void;
  busy?: boolean;
  extra?: ReactNode;
}) {
  const here = TABS.find((t) => t.id === tab)!;
  // the header folded its search to an icon, and the icon was pressed: the box lies over the header's right end
  const [searching, setSearching] = useState(false);
  const adds = newLabel ?? here.add;
  return (
    <PageHeader
      title="Prompt kit"
      after={
        <Segmented<Tab>
          oneLine
          label="What to show"
          value={tab}
          options={TABS.map((t) => ({ value: t.id, label: <span className="inline-flex items-center gap-1.5">{t.title}<SegmentCount>{loading ? null : all.filter((e) => e.kind === t.id).length}</SegmentCount></span> }))}
          onChange={onTab}
        />
      }
      // In a narrow window the search gives up width, then becomes an icon, and last the New button keeps its "+" with its
      // words in the tip; the kinds' tabs never go.
      folds={3}
      foldKey={tab}
      actions={(fold) => (
        <>
          {fold >= 2 && !searching && !query ? (
            <IconButton tone="outline" data-search-opener label={`Search your ${here.title.toLowerCase()}`} tip={`Search ${here.title.toLowerCase()} (/)`} onClick={() => setSearching(true)}>
              <Search size={15} />
            </IconButton>
          ) : (
            <SearchField
              data-search
              autoFocus={searching}
              onBlur={() => setSearching(false)}
              // folded and opened: over the header's right end rather than push the tabs out of it
              className={fold >= 2 ? "absolute top-1/2 right-8 z-10 w-72 -translate-y-1/2 shadow-lg shadow-shade/40" : fold >= 1 ? "w-44" : "w-60"}
              label={`Search your ${here.title.toLowerCase()}`}
              placeholder={`Search ${here.title.toLowerCase()}`}
              value={query}
              onChange={onQuery}
              onClear={() => onQuery("")}
            />
          )}
          {extra}
          {fold >= 3 ? (
            <IconButton tone="primary" disabled={busy} label={adds} onClick={onNew}><Plus size={15} /></IconButton>
          ) : (
            <Button size="sm" tone="primary" disabled={busy} onClick={onNew} className="shrink-0"><Plus size={14} /> {adds}</Button>
          )}
        </>
      )}
    />
  );
}
