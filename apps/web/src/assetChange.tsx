import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type Folder, type Project } from "./api";
import { applyChange, itemsWord, placeName, placesBefore, rollback, type Seats } from "./assetCache";
import { clearDraftUse } from "./draftUse";
import type { AssetChange } from "./queryKeys";
import { moves } from "./leave";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { libraryReads, queryKeys, type LibraryChange } from "./queryKeys";

/**
 * Keep, unkeep, bin, put back, move and rename, as every place of the app does them: the screen changes first (every
 * copy of the items, assetCache.ts), the request goes behind it, and when it lands nothing moves, it was already right.
 * A move, a bin or a put back says so in a banner with Undo (Ctrl+Z) for its few seconds; Undo is the reverse change,
 * made the same way. When the server refuses, every copy goes back as it was, the item shakes where it shows, and a
 * banner says why, with Retry. Renders, finishes and exports stay as they are: they are queued jobs, the queue shows them.
 */

/** The items that just left a list on purpose (moved out, binned, put back): their tile plays the exit (MediaGrid.tsx). */
export const leavingNow = new Set<string>();

/** The changes on their way: the lists are read again once the last one is done, so an earlier answer does not undo a later change on screen. */
let inFlight = 0;
/** The changes done while others were on their way: what they touched is read once the last is done. */
let done: LibraryChange[] = [];
/** A change made here, as the server's "library" event says it (queryKeys.ts libraryReads): what it can touch. */
const asLibraryChange = (c: AssetChange): LibraryChange =>
  c.kind === "rename" ? { change: "fields", items: c.ids, name: c.name }
  : c.kind === "keep" ? { change: "kept", items: c.ids, kept: c.kept }
  // filed in a folder keeps them; taken out of any, nothing is kept
  : c.kind === "move" ? { change: "moved", items: c.ids, ...(c.folder === null ? { kept: false } : {}) }
  : { change: "binned", items: c.ids };
let said = 0;
const bannerId = (what: string) => `${what}:${Date.now()}:${++said}`;
/** The refusal banner said for each item: a later change to the item takes it away, its Retry would undo that change. */
const refusedFor = new Map<string, string>();

/** What the server is asked for: one item by its own call, several by the bulk call. */
function send(c: AssetChange): Promise<unknown> {
  const one = c.ids.length === 1 ? c.ids[0]! : null;
  switch (c.kind) {
    case "keep": return one ? api.keep(one, c.kept) : api.bulkAssets(c.ids, c.kept ? "keep" : "unkeep");
    case "bin": return one ? api.bin(one) : api.bulkAssets(c.ids, "bin");
    case "restore": return one ? api.restore(one) : api.bulkAssets(c.ids, "restore");
    case "move": return api.moveAssets(c.ids, c.folder);
    case "rename": return Promise.all(c.ids.map((id) => api.renameAsset(id, c.name)));
  }
}

/** The banner's title when the server refuses: what could not be done, to one item or several. */
export function refusedTitle(c: AssetChange): string {
  const it = c.ids.length === 1 ? "it" : "them";
  switch (c.kind) {
    case "keep": return c.kept ? `Could not keep ${it}` : `Could not unkeep ${it}`;
    case "bin": return `Could not move ${it} to the bin`;
    case "restore": return `Could not put ${it} back`;
    case "move": return `Could not move ${it}`;
    case "rename": return `Could not rename ${it}`;
  }
}

/** A short shake of the items where they show again (motion wanted only): the change was refused, it is back. */
function shake(ids: string[]) {
  if (!moves()) return;
  // after React has drawn the items back in their place
  setTimeout(() => {
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)) {
        el.classList.remove("m-shake");
        void el.offsetWidth;
        el.classList.add("m-shake");
        el.addEventListener("animationend", () => el.classList.remove("m-shake"), { once: true });
      }
    }
  }, 30);
}

export interface ChangeOptions {
  /** No banner on success (an Undo itself, a keep: the star says it). */
  quiet?: boolean;
  /** Where the items sat before the change this one undoes: they go back there at once (assetCache.ts Seats). */
  back?: Seats;
}

/**
 * The change made on screen at once, then sent. Answers whether the server took it (the screen already shows it either
 * way: changed, or put back with the refusal said).
 */
export async function changeAssets(client: QueryClient, c: AssetChange, opts: ChangeOptions = {}): Promise<boolean> {
  if (!c.ids.length) return true;
  // the bin refuses an item a draft still uses: the drafts in the way are asked about first (an Undo's own bin is not)
  if (c.kind === "bin" && !opts.quiet && !(await clearDraftUse(client, c.ids))) return false;
  const say = useBanners.getState().push;
  for (const id of c.ids) {
    const old = refusedFor.get(id);
    if (old) useBanners.getState().dismiss(old);
    refusedFor.delete(id);
  }
  // where each item was, for the Undo of a move: known only before the change is made on screen
  const before = c.kind === "move" ? placesBefore(client, c.ids) : [];
  inFlight++;
  if (c.kind === "move" || c.kind === "bin" || c.kind === "restore") {
    for (const id of c.ids) leavingNow.add(id);
    setTimeout(() => c.ids.forEach((id) => leavingNow.delete(id)), 1000);
  }
  try {
    // a read on its way would land over the change with what was true before it
    await Promise.all([client.cancelQueries({ queryKey: queryKeys.assets.all() }), client.cancelQueries({ queryKey: queryKeys.folders() })]);
    const left: Seats = [];
    const snap = applyChange(client, c, undefined, { left, back: opts.back });
    // said at once with the change, not when the server answers: on a slow line the item left and nothing said so for
    // seconds; a refusal takes this banner back and says why instead
    const said = opts.quiet ? null : sayDone(client, c, before, left);
    try {
      const answer = (await send(c)) as { inUse?: number } | undefined;
      // several at once: what something else still uses (a timeline, the kit, a job to run) stayed where it was
      if (c.kind === "bin" && answer?.inUse) {
        say({ id: bannerId("spared"), tone: "bad", title: `${itemsWord(answer.inUse)} stayed out of the bin`, text: "Still in use by a timeline, the Prompt kit or a job still to run." });
      }
    } catch (err) {
      rollback(client, snap);
      if (said) useBanners.getState().dismiss(said);
      shake(c.ids);
      const refused = bannerId("refused");
      for (const id of c.ids) refusedFor.set(id, refused);
      // the failure's own banner (a 409 titled "Still in use"), with Retry
      say({ ...failedBanner({ id: refused, once: true, inUse: true }, refusedTitle(c), err), action: { label: "Retry", run: () => void changeAssets(client, c, opts) } });
      return false;
    }
    return true;
  } finally {
    inFlight--;
    done.push(asLibraryChange(c));
    if (!inFlight) {
      // only what the changes can touch, as their live events read it: a rename or a keep is already written on screen
      const reads = libraryReads(done);
      done = [];
      void client.invalidateQueries({ predicate: (q) => reads(q.queryKey) });
    }
  }
}

/**
 * A move, a bin or a put back said, with its Undo: the reverse change, each item back to where it was. Once undone, a
 * banner of its own offers Redo (Ctrl+Shift+Z or Ctrl+Y, as in the timeline editor): the change made again, said again
 * with its Undo, so that the two keys walk back and forth as a history of one step does.
 */
function sayDone(client: QueryClient, c: AssetChange, before: Array<{ folder: string | null; ids: string[] }>, left: Seats): string | null {
  const n = itemsWord(c.ids.length);
  const id = bannerId(c.kind === "move" ? "moved" : c.kind === "bin" ? "binned" : "restored");
  // the undone banner says what Redo does again in its text: the command bar's Redo row reads it there
  const undo = (said: string, run: () => Promise<unknown>) => ({
    label: "Undo", key: "Ctrl+Z", undo: true,
    run: () => void run().then((done) => {
      if (done === false) return;
      useBanners.getState().push({ id: bannerId("undone"), tone: "good", title: "Undone", text: said, action: { label: "Redo", key: "Ctrl+Shift+Z", redo: true, run: () => void changeAssets(client, c) } });
    }),
  });
  if (c.kind === "move") {
    const folders = client.getQueryData<{ items: Folder[] }>(queryKeys.folders())?.items;
    const projects = client.getQueryData<{ items: Project[] }>(queryKeys.projects.all())?.items;
    const back = before.filter((g) => g.folder !== c.folder);
    const title = `Moved to ${placeName(c.folder, folders, projects)} · ${n}`;
    useBanners.getState().push({
      id, tone: "good", title,
      ...(back.length ? { action: undo(title, async () => { for (const g of back) await changeAssets(client, { kind: "move", ids: g.ids, folder: g.folder }, { quiet: true, back: left }); }) } : {}),
    });
  } else if (c.kind === "bin") {
    useBanners.getState().push({ id, tone: "good", title: `Moved to the bin · ${n}`, action: undo(`Moved to the bin · ${n}`, () => changeAssets(client, { kind: "restore", ids: c.ids }, { quiet: true, back: left })) });
  } else if (c.kind === "restore") {
    useBanners.getState().push({ id, tone: "good", title: `Put back · ${n}`, action: undo(`Put back · ${n}`, () => changeAssets(client, { kind: "bin", ids: c.ids }, { quiet: true, back: left })) });
  } else return null;
  return id;
}

/** `changeAssets` bound to the app's query client: what the places call. */
export function useAssetChange() {
  const client = useQueryClient();
  return useCallback((c: AssetChange, opts?: ChangeOptions) => changeAssets(client, c, opts), [client]);
}
