import { hashKey, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { Asset, Folder } from "./api";
import { isAssets, queryKeys } from "./queryKeys";

/**
 * A change to items of the library made on screen before the server says it is done (keep, unkeep, bin, put back,
 * move, rename): every copy the screens read is changed at once (the library's lists, the Projects panel's folder
 * lists, the item itself, the expiring count of the status bar, the folders' counts), and what each copy was is kept,
 * so that a refusal puts every one back as it was. Pure but for the query client, for the tests; the hook that sends
 * the change and says what happened is assetChange.tsx.
 */
export type AssetChange =
  | { kind: "keep"; ids: string[]; kept: boolean }
  | { kind: "bin"; ids: string[] }
  | { kind: "restore"; ids: string[] }
  | { kind: "move"; ids: string[]; folder: string | null }
  | { kind: "rename"; ids: string[]; name: string };

/** What a copy was before the change, what the change made of it, and the items it changed: put back by `rollback`. */
export type Snapshot = Array<[QueryKey, unknown, unknown, ReadonlySet<string>]>;

/**
 * Where items sat in the lists on screen before a change took them out (the list, the page, the place in it, the item as
 * it was): an Undo puts each one back there at once, instead of waiting for the server to say where it goes. Read again
 * after the Undo lands, so a place that has moved meanwhile is only off for a moment.
 */
export type Seats = Array<{ key: string; page: number; index: number; asset: Asset }>;

/** A page of the library, as `api.assets` gives it. */
interface Page {
  items: Asset[];
  next: string | null;
  prev: string | null;
}
/** The filters of a library list (data.ts useAssets), the parts that decide whether an item belongs. */
interface ListFilter {
  bin?: boolean;
  folder?: string;
  kept?: boolean;
  unkept?: boolean;
  draft?: string;
  all?: boolean;
}
/** The expiring summary (screens/studio/expiring.ts). */
interface Unkept {
  count: number;
  from: string | null;
  to: string | null;
}

/** The item as it is after the change; `now` is when a countdown starts again (unkept, put back). */
export function changed(a: Asset, c: AssetChange, now: string): Asset {
  switch (c.kind) {
    case "keep": return { ...a, kept: c.kept, ...(c.kept ? {} : { countdownFrom: now }) };
    case "bin": return { ...a, inBin: true };
    // out of the bin, an item not kept has its day again (the server starts its countdown anew)
    case "restore": return { ...a, inBin: false, countdownFrom: now };
    case "move": return { ...a, folderId: c.folder };
    // a name of its own says what it is: the name worked out from where it came from is not shown any more
    case "rename": return { ...a, name: c.name, shownName: c.name ? undefined : a.shownName };
  }
}

/**
 * Whether an item belongs in a library list of these filters, as the server would answer (apps/server assetSearch.ts):
 * the bin or not, the folder (exactly that one; "none": in no folder), kept or not, and the project the list scopes to
 * when no folder, bin or draft says where. `projectOf` says which project a folder is in (null: the Inbox); undefined
 * when it is not known, and then the item is not taken out for it (the list is read again after anyway). The words
 * searched, the family and the like are not decided here: no change of this file alters them but a rename.
 */
export function fits(f: ListFilter, project: string | undefined, a: Asset, projectOf: (folder: string) => string | null | undefined): boolean {
  if (Boolean(f.bin) !== a.inBin) return false;
  if (f.folder === "none" ? a.folderId !== null : f.folder ? a.folderId !== f.folder : false) return false;
  if (f.kept && !a.kept) return false;
  if (f.unkept && a.kept) return false;
  if (!f.folder && !f.bin && !f.draft && !f.all && project) {
    const of = a.folderId === null ? null : projectOf(a.folderId);
    if (of !== undefined && (of ?? "none") !== project) return false;
  }
  return true;
}

/** The item as some copy on screen has it now: its details, else a list that holds it. */
export function findAsset(client: QueryClient, id: string): Asset | undefined {
  const one = client.getQueryData<Asset>(queryKeys.assets.one(id));
  if (one) return one;
  for (const [key, data] of client.getQueriesData<unknown>({ queryKey: queryKeys.assets.all() })) {
    if (isAssets(key, "list")) {
      for (const p of (data as InfiniteData<Page> | undefined)?.pages ?? []) {
        const hit = p.items.find((a) => a.id === id);
        if (hit) return hit;
      }
    } else if (isAssets(key, "tree")) {
      const hit = (data as { items: Asset[] } | undefined)?.items.find((a) => a.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The change made on every copy of the items on screen, at once; what each copy was is answered, for `rollback`. An
 * item that no longer belongs in a list (moved out of its folder, binned, put back out of the bin, unkept in "Kept
 * only") leaves it, and where it sat is written in `seats.left`; one that comes into a list is not added (its place in
 * the order is the server's to say: the lists are read again once the change is done), unless `seats.back` says where
 * it sat before (an Undo): then it goes back to that place.
 */
export function applyChange(client: QueryClient, c: AssetChange, now = new Date().toISOString(), seats: { left?: Seats; back?: Seats } = {}): Snapshot {
  const snap: Snapshot = [];
  const ids = new Set(c.ids);
  const before = new Map(c.ids.flatMap((id) => {
    const a = findAsset(client, id);
    return a ? [[id, a] as const] : [];
  }));
  const set = (key: QueryKey, was: unknown, next: unknown) => {
    // what the cache holds after it (structural sharing may keep parts of the old copy): told apart from a later change
    snap.push([key, was, client.setQueryData(key, next), ids]);
  };
  const folders = client.getQueryData<{ items: Folder[] }>(queryKeys.folders())?.items;
  const projectOf = (folder: string) => {
    if (!folders) return undefined;
    const f = folders.find((x) => x.id === folder);
    return f ? f.projectId : undefined;
  };

  for (const [key, data] of client.getQueriesData<unknown>({ queryKey: queryKeys.assets.all() })) {
    if (!data) continue;
    if (isAssets(key, "list")) {
      const list = data as InfiniteData<Page>;
      const filter = (key[3] ?? {}) as ListFilter;
      const project = typeof key[2] === "string" ? key[2] : undefined;
      const hash = hashKey(key);
      let touched = false;
      const pages = list.pages.map((p, pi) => {
        if (!p.items.some((a) => ids.has(a.id))) return p;
        touched = true;
        return { ...p, items: p.items.flatMap((a, ii) => {
          if (!ids.has(a.id)) return [a];
          const next = changed(a, c, now);
          if (fits(filter, project, next, projectOf)) return [next];
          seats.left?.push({ key: hash, page: pi, index: ii, asset: a });
          return [];
        }) };
      });
      // an Undo: each item back where it sat, when it belongs here again and is not here already. Only the items of this
      // change: the Undo of a move from several folders is one change a folder, each handed every seat, and one put the
      // other folders' items back as if they were in its own
      for (const s of seats.back ?? []) {
        if (!ids.has(s.asset.id)) continue;
        if (s.key !== hash || !pages[s.page] || pages.some((p) => p.items.some((a) => a.id === s.asset.id))) continue;
        const next = changed(s.asset, c, now);
        if (!fits(filter, project, next, projectOf)) continue;
        const items = [...pages[s.page]!.items];
        items.splice(Math.min(s.index, items.length), 0, next);
        pages[s.page] = { ...pages[s.page]!, items };
        touched = true;
      }
      if (touched) set(key, data, { ...list, pages });
    } else if (isAssets(key, "tree")) {
      // the Projects panel's items of one open folder (projects/ProjectsPanel.tsx): its folder is the key's third part
      const read = data as { items: Asset[]; more: boolean };
      const hash = hashKey(key);
      const belongs = (a: Asset) => !a.inBin && a.folderId === key[2];
      const back = (seats.back ?? []).filter((s) => ids.has(s.asset.id) && s.key === hash && !read.items.some((a) => a.id === s.asset.id));
      if (!back.length && !read.items.some((a) => ids.has(a.id))) continue;
      const items = read.items.flatMap((a, ii) => {
        if (!ids.has(a.id)) return [a];
        const next = changed(a, c, now);
        if (belongs(next)) return [next];
        seats.left?.push({ key: hash, page: 0, index: ii, asset: a });
        return [];
      });
      for (const s of back) {
        const next = changed(s.asset, c, now);
        if (belongs(next)) items.splice(Math.min(s.index, items.length), 0, next);
      }
      set(key, data, { ...read, items });
    } else if (isAssets(key, "one") && typeof key[2] === "string" && ids.has(key[2])) {
      set(key, data, changed(data as Asset, c, now));
    } else if (isAssets(key, "unkept") && key[2] === "all") {
      // the status bar's expiring count: what comes into it or leaves it; the first and last countdowns roughly (read again after)
      const sum = data as Unkept;
      const counted = (a: Asset) => !a.inBin && !a.kept;
      let delta = 0;
      for (const a of before.values()) delta += Number(counted(changed(a, c, now))) - Number(counted(a));
      if (!delta) continue;
      const count = Math.max(0, sum.count + delta);
      set(key, data, count === 0 ? { ...sum, count, from: null, to: null } : delta > 0 ? { ...sum, count, from: sum.from ?? now, to: now } : { ...sum, count });
    }
  }

  // the folders' counts (the Move to menu, the folder panel): what each holds directly, items in the bin not counted
  if (folders && (c.kind === "move" || c.kind === "bin" || c.kind === "restore")) {
    const by = new Map<string, number>();
    const add = (folder: string | null, n: number) => {
      if (folder) by.set(folder, (by.get(folder) ?? 0) + n);
    };
    for (const a of before.values()) {
      if (c.kind === "move" && !a.inBin && a.folderId !== c.folder) {
        add(a.folderId, -1);
        add(c.folder, 1);
      } else if (c.kind === "bin" && !a.inBin) add(a.folderId, -1);
      else if (c.kind === "restore" && a.inBin) add(a.folderId, 1);
    }
    if (by.size) {
      const was = client.getQueryData(queryKeys.folders());
      set(queryKeys.folders(), was, { items: folders.map((f) => (by.has(f.id) ? { ...f, count: Math.max(0, f.count + by.get(f.id)!) } : f)) });
    }
  }
  return snap;
}

/**
 * What the refused change did, undone on every copy (the latest first, so that a copy changed twice ends as it began).
 * A copy nothing else changed since is put back whole; in one changed since (another change that went through, a read
 * that landed) only the items of the refused change go back as they were, where they were: putting the whole copy back
 * undid the later change on screen too, until the next read. A count changed since is read again.
 */
export function rollback(client: QueryClient, snap: Snapshot): void {
  for (const [key, was, made, ids] of [...snap].reverse()) {
    const now = client.getQueryData(key);
    if (now === made) client.setQueryData(key, was);
    else if (now === undefined) continue;
    else if (isAssets(key, "list")) {
      const before = was as InfiniteData<Page>;
      const list = now as InfiniteData<Page>;
      const pages = list.pages.map((p) => ({ ...p, items: p.items.filter((a) => !ids.has(a.id)) }));
      before.pages.forEach((p, pi) => p.items.forEach((a, ii) => {
        if (!ids.has(a.id) || !pages[pi]) return;
        pages[pi]!.items.splice(Math.min(ii, pages[pi]!.items.length), 0, a);
      }));
      client.setQueryData(key, { ...list, pages });
    } else if (isAssets(key, "tree")) {
      const read = now as { items: Asset[] };
      const items = read.items.filter((a) => !ids.has(a.id));
      (was as { items: Asset[] }).items.forEach((a, i) => ids.has(a.id) && items.splice(Math.min(i, items.length), 0, a));
      client.setQueryData(key, { ...read, items });
    } else if (isAssets(key, "one")) client.setQueryData(key, was);
    else void client.invalidateQueries({ queryKey: key, exact: true });
  }
}

/**
 * Where the items were before a move, folder by folder (null: in no folder): an Undo moves each group back to its own
 * place. Items not on screen anywhere are not in it: there is no telling where they were.
 */
export function placesBefore(client: QueryClient, ids: string[]): Array<{ folder: string | null; ids: string[] }> {
  const by = new Map<string | null, string[]>();
  for (const id of ids) {
    const a = findAsset(client, id);
    if (a) by.set(a.folderId, [...(by.get(a.folderId) ?? []), id]);
  }
  return [...by].map(([folder, list]) => ({ folder, ids: list }));
}

/** A place in a few words, for "Moved to …": a project's root folder by the project's name, a folder by its, the Inbox. */
export function placeName(folder: string | null, folders: readonly Folder[] | undefined, projects: ReadonlyArray<{ id: string; name: string; folderId: string | null }> | undefined): string {
  if (folder === null) return "the Inbox";
  const root = projects?.find((p) => p.folderId === folder);
  if (root) return root.name;
  return folders?.find((f) => f.id === folder)?.name ?? "the folder";
}

/** "1 item", "3 items". */
export const itemsWord = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
