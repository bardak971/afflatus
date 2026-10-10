import { useMemo, useState } from "react";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { api, type Asset, type DraftLeaf, type ProjectsTree } from "../api";
import { DRAFT_LIST, useRecipes } from "../data";
import { recipeLabel } from "../format";
import { draftsKey, flatten, groupKey, itemsOrder, rowHeight, siblings, type DraftsRead, type ItemKind, type ItemsRead, type Sort } from "./tree";

const DRAFTS_PAGE = 50;
/** A folder's items are read 50 at a time. */
const ITEMS_PAGE = 50;

/**
 * The Projects panel's rows: the tree flattened as it is unfolded, with the drafts of each open drafts row and the items of
 * each open folder read when they open (a page at a time: `readMore` reads the next of a "more" row).
 */
export function useTreeRows({ data, q, kind, sort, only, current, isOpen, folds, searchFolded, bin }: {
  data: ProjectsTree | undefined;
  /** What is searched for. */
  q: string;
  kind: ItemKind | null;
  sort: Sort;
  /** One project's tree (its group: null for the Inbox). */
  only: { group: string | null } | undefined;
  /** The project worked in ("none": the Inbox). */
  current: string;
  isOpen(key: string): boolean;
  /** The fold state, which the rows are drawn from (isOpen reads it). */
  folds: Record<string, boolean>;
  searchFolded: Set<string>;
  /** What the Bin holds, once read. */
  bin: { count: number; bytes: number } | undefined;
}) {
  const recipes = useRecipes();
  // the drafts of each group whose drafts row is open, read when it opens
  const groups = data?.groups ?? [];
  // one project's tree shows that group's rows without its own row being unfolded
  const draftGroups = q ? [] : groups.filter((g) => g.counts.drafts > 0 && isOpen(draftsKey(g.id)) && (only ? g.id === only.group : isOpen(groupKey(g)) && (!g.archived || isOpen("archived"))));
  const draftReads = useQueries({
    queries: draftGroups.map((g) => ({ queryKey: [...DRAFT_LIST, "tree", g.id ?? "none"], queryFn: ({ signal }: { signal: AbortSignal }) => api.draftsOf(g.id, { signal }) })),
  });
  const [limits, setLimits] = useState<Record<string, number>>({});
  const drafts = new Map<string, DraftsRead>(
    draftGroups.map((g, i) => {
      // every one: the unused ones (the empty "New draft" among them) fold into the group's empty-drafts row
      const items = draftReads[i]?.data?.items ?? null;
      return [draftsKey(g.id), { items, limit: limits[draftsKey(g.id)] ?? DRAFTS_PAGE }];
    }),
  );
  const recipeName = (id: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === id);
    return r ? recipeLabel(recipes.data?.families.find((f) => f.id === r.family)?.name, r.title) : id;
  };
  const draftMeta = (d: DraftLeaf) => `${recipeName(d.recipe)}${d.outputs ? ` · ${d.outputs} render${d.outputs === 1 ? "" : "s"}` : ""}`;
  // the items of each unfolded folder that is shown, read when it opens (the folders shown do not depend on items: they come first)
  const [itemPages, setItemPages] = useState<Record<string, number>>({});
  const openFolders = useMemo(
    () => (data && !q ? flatten(data, { isOpen, drafts: () => undefined, only }).filter((r) => r.kind === "folder" && r.open && r.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen and only are read from folds, current and only.group, listed instead
    [data, folds, q, current, only?.group],
  );
  const itemReads = useQueries({
    queries: openFolders.map((f) => {
      const pages = itemPages[f.key] ?? 1;
      return {
        queryKey: ["assets", "tree", f.id, kind, pages, sort.by, sort.desc],
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
          const items: Asset[] = [];
          let after: string | undefined;
          for (let i = 0; i < pages; i++) {
            const page = await api.assets({ folder: f.id!, limit: ITEMS_PAGE, after, ...itemsOrder(sort), ...(kind ? { kind } : {}) }, { signal });
            items.push(...page.items);
            after = page.next ?? undefined;
            if (!after) break;
          }
          return { items, more: Boolean(after) };
        },
        placeholderData: keepPreviousData,
      };
    }),
  });
  const items = new Map<string, ItemsRead>(openFolders.map((f, i) => [f.key, { items: itemReads[i]?.data?.items ?? null, more: itemReads[i]?.data?.more ?? false }]));
  // what the loaded lists are, by when each was read: cheap to compare on every render, unlike the lists themselves
  const draftsRead = draftGroups.map((g, i) => `${g.id}:${draftReads[i]?.dataUpdatedAt ?? 0}:${limits[draftsKey(g.id)] ?? DRAFTS_PAGE}`).join("|");
  const itemsRead = openFolders.map((f, i) => `${f.key}:${itemReads[i]?.dataUpdatedAt ?? 0}:${itemReads[i]?.isPlaceholderData ? 1 : 0}`).join("|");
  const rows = useMemo(
    () => (data ? flatten(data, { isOpen, drafts: (k) => drafts.get(k), items: (k) => items.get(k), bin: bin ?? null, q, kind, draftMeta, sort, only }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reads are compared by when they were made (draftsRead, itemsRead), not by the lists themselves
    [data, folds, searchFolded, q, kind, sort, draftsRead, itemsRead, recipes.data, current, bin?.count, bin?.bytes, only?.group],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  // each row's place among its own, said to screen readers: rows out of sight are not drawn (useRowWindow)
  const sibs = useMemo(() => siblings(rows), [rows]);
  // the Bin stays in sight at the foot of the list: what it covers is not in sight
  const footHeight = rows.at(-1)?.kind === "bin" ? rowHeight(rows.at(-1)!) : 0;
  const found = q ? rows.filter((r) => r.match).length : 0;
  /** A "more" row's list read further: a folder's next page of items, or fifty more drafts. */
  const readMore = (more: string) => {
    if (more.startsWith("f:")) setItemPages((p) => ({ ...p, [more]: (p[more] ?? 1) + 1 }));
    else setLimits((l) => ({ ...l, [more]: (l[more] ?? DRAFTS_PAGE) + DRAFTS_PAGE }));
  };
  return { groups, rows, byKey, sibs, footHeight, found, readMore };
}
