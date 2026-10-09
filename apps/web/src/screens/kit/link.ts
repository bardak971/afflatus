import type { Tab } from "./KitHeader";

/**
 * The Prompt kit's address: the tab and the item open in it, after the # ("/kit#people/<id>", "/kit#snippets"), so
 * that a place in the kit can be linked to from elsewhere (a form's cast, the command bar) and pasted.
 */

/** The word of each tab in the address. */
const WORD: Record<Tab, string> = { person: "people", place: "places", style: "styles", snippet: "snippets", preset: "presets" };

/** The hash of a tab and an item open in it ("#people/<id>"; the snippets have no item open: "#snippets"). */
export const kitHash = (tab: Tab, id?: string | null): string => `#${WORD[tab]}${id && tab !== "snippet" ? `/${encodeURIComponent(id)}` : ""}`;

/** Where a kind of the kit, or one of its items, is: for a Link or `go`. */
export const kitHref = (kind: Tab, id?: string | null): string => `/kit${kitHash(kind, id)}`;

/** The tab and the item a hash names; null when it names no tab. */
export function readKitHash(hash: string): { tab: Tab; id: string | null } | null {
  const [word, id] = hash.replace(/^#/, "").split("/");
  const tab = (Object.keys(WORD) as Tab[]).find((t) => WORD[t] === word?.toLowerCase());
  if (!tab) return null;
  return { tab, id: id && tab !== "snippet" ? decodeURIComponent(id) : null };
}
