/**
 * What ComfyUI offers each recipe's inputs (the setup's `options`), sent with each list once. Every recipe that takes a
 * LoRA offers the same few hundred files: sent in each of them, the setup was about 800 kB to write, hash and compress on
 * every read. The server sends `lists`, each list once, and each recipe names the ones it offers by their place there; the
 * page puts them back as they were.
 */
export interface ListedOptions<R> {
  lists: string[][];
  recipes: Array<Omit<R, "options"> & { options: Record<string, number> }>;
}

/** The setup with each recipe's options sent as places in `lists`, the same list once. */
export function listOptions<R extends { options: Record<string, string[]> }, S extends { recipes: R[] }>(scan: S): Omit<S, "recipes"> & ListedOptions<R> {
  const lists: string[][] = [];
  const at = new Map<string, number>();
  const place = (list: string[]) => {
    const key = JSON.stringify(list);
    let i = at.get(key);
    if (i === undefined) {
      i = lists.push(list) - 1;
      at.set(key, i);
    }
    return i;
  };
  const recipes = scan.recipes.map((r) => ({ ...r, options: Object.fromEntries(Object.entries(r.options).map(([k, list]) => [k, place(list)])) }));
  return { ...scan, lists, recipes };
}

/** A setup as unlistOptions gives it back: each recipe's options its lists. One read untyped (a test's JSON) stays untyped. */
export type Unlisted<S extends { recipes: unknown[] }> = 0 extends 1 & S ? S : Omit<S, "lists" | "recipes"> & { recipes: Array<Omit<S["recipes"][number], "options"> & { options: Record<string, string[]> }> };

/** The setup as listOptions sent it, each recipe's options its lists again (one array shared by the recipes that offer it). */
export function unlistOptions<S extends ListedOptions<{ options: Record<string, string[]> }>>(sent: S): Unlisted<S> {
  const { lists, recipes, ...rest } = sent;
  return { ...rest, recipes: recipes.map((r) => ({ ...r, options: Object.fromEntries(Object.entries(r.options).map(([k, i]) => [k, lists[i] ?? []])) })) } as Unlisted<S>;
}
