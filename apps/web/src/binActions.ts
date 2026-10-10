import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { api, type Asset } from "./api";
import { itemsWord } from "./assetCache";
import { ask } from "./Confirm";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

/**
 * What the bin itself offers (its strip over the grid, its items' menu, Del on what is ticked in it): an item erased
 * now instead of after its week, everything put back, everything erased. An erase is asked first and cannot be undone,
 * so it is not made on screen before the server has done it; a put back of everything is said with its count.
 */

/** The lists read again after a change of the bin: the library, its folders' counts, the bin's size, the timelines. */
function readAgain(client: QueryClient) {
  for (const queryKey of [queryKeys.assets.all(), queryKeys.folders(), queryKeys.projects.all(), queryKeys.storage(), queryKeys.timelines.all()]) void client.invalidateQueries({ queryKey });
}

const say = (tone: "good" | "bad", title: string, text?: string) => useBanners.getState().push({ id: `bin:${Date.now()}`, tone, title, ...(text ? { text } : {}) });

/** The items of the bin erased now, files and all, once asked. Answers whether it was done. */
export async function eraseNow(client: QueryClient, ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  const what = ids.length === 1 ? "it" : `these ${ids.length} items`;
  if (!(await ask({ title: ids.length === 1 ? "Delete it now?" : `Delete ${ids.length} items now?`, text: `${what[0]!.toUpperCase()}${what.slice(1)} ${ids.length === 1 ? "is" : "are"} erased now, files and all, instead of after the week in the bin. This cannot be undone.`, yes: "Delete" }))) return false;
  try {
    let erased = 0;
    let used = 0;
    // in slices: the server takes up to 500 at a time
    for (let i = 0; i < ids.length; i += 500) {
      const r = await api.eraseBinned(ids.slice(i, i + 500));
      erased += r.erased;
      used += r.inUse ?? 0;
    }
    // gone from the bin's list at once, before it is read again
    const gone = new Set(ids);
    client.setQueriesData<InfiniteData<{ items: Asset[] }>>({ queryKey: queryKeys.assets.lists() }, (d) => (d?.pages ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((a) => !gone.has(a.id)) })) } : d));
    say("good", `Deleted for good · ${itemsWord(erased)}`, used ? `${itemsWord(used)} still in use stayed in the bin.` : undefined);
    return true;
  } catch (err) {
    say("bad", "Could not delete them", err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    readAgain(client);
  }
}

/** Everything in the bin back where it was. */
export async function restoreAll(client: QueryClient): Promise<void> {
  try {
    const r = await api.restoreBin();
    say("good", `Put back · ${itemsWord(r.restored)}`);
  } catch (err) {
    say("bad", "Could not put them back", err instanceof Error ? err.message : String(err));
  } finally {
    readAgain(client);
  }
}

/** Everything in the bin erased now, once asked. */
export async function emptyAll(client: QueryClient): Promise<void> {
  if (!(await ask({ title: "Empty the bin?", text: "Everything in the bin is erased now, files and all, instead of after its week. This cannot be undone.", yes: "Erase" }))) return;
  try {
    const r = await api.emptyBin();
    say("good", `Erased · ${itemsWord(r.erased)}`, r.inUse ? `${itemsWord(r.inUse)} still in use stayed in the bin.` : undefined);
  } catch (err) {
    say("bad", "Could not empty the bin", err instanceof Error ? err.message : String(err));
  } finally {
    readAgain(client);
  }
}
