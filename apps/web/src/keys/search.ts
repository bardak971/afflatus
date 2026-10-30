import { keyQuery, matchKeys, type KeyHit } from "./grammar";
import { hereNow } from "./here";
import { PLACES, type KeyGroup, type KeyPlace, type KeyRow, type PlaceId } from "./table";

/**
 * The search of the key table, shared by the sheet ("?") and the command bar's `?` mode, so that both list the same
 * rows in the same order for the same words: a key first (across every place, the open ones first), then words.
 */

/** The places first in "Here now", by how much they sit on top of the rest (Trim before the viewer it is in). */
const ON_TOP: PlaceId[] = ["mask", "trim", "viewer", "projects", "media", "editor", "timelines", "grid", "form", "queue", "kit"];

export interface Opened {
  /** The places open now, the topmost first; Everywhere last. */
  here: PlaceId[];
  /** The viewer's item, when the viewer is open: its image or video keys first. */
  kind?: "image" | "video" | "audio";
}

/**
 * What is open now, as the screens say it (`useKeysHere`), and the screens known by their address. A place drawn over
 * the screen (the viewer opened large, the mask painter) leaves out the screen's own places under it: their keys are off.
 */
export function opened(): Opened {
  const all = hereNow();
  const over = all.some((h) => h.over);
  const shown = all.filter((h) => !over || h.over || h.place === "projects");
  const ids = new Set<PlaceId>(shown.map((h) => h.place));
  const path = location.pathname;
  if (!over && path.startsWith("/queue")) ids.add("queue");
  if (!over && (path.startsWith("/kit") || path.startsWith("/workflows"))) ids.add("kit");
  const here = ON_TOP.filter((p) => ids.has(p));
  here.push("everywhere");
  return { here, kind: shown.find((h) => h.place === "viewer")?.kind };
}

/** A row with where it is: a search's result. */
export interface Found {
  /** The row's id in the sheet ("editor:Clips:1"): what the sheet lights when asked to open on it. */
  id: string;
  place: KeyPlace;
  group: KeyGroup;
  row: KeyRow;
  /** Its place is open now (Everywhere never counts: it is always open). */
  here: boolean;
  /** The caps a key search lit. */
  hits?: KeyHit[];
}

export interface Searched {
  kq: ReturnType<typeof keyQuery>;
  keys: Found[];
  said: Found[];
  all: Found[];
}

export const rowId = (place: KeyPlace, group: KeyGroup, i: number) => `${place.id}:${group.name}:${i}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The words of a search, matched at the start of a word ("split" in "Split at the playhead", not in "unsplit"). */
export const wordsRe = (q: string) => new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(q)})`, "iu");
/** A row's keys as drawn: the command bar's own row shows the shortcut set in Settings › Interface › Command bar. */
export const keysOfRow = (row: KeyRow, barKey: string) => (row.bar ? barKey : row.keys);

/** The places in the order they are listed: the open ones first, the rest as the table has them. */
const orderOf = (here: readonly PlaceId[]): PlaceId[] => [...here, ...PLACES.map((p) => p.id).filter((id) => !here.includes(id))];

const foundOf = (p: KeyPlace, g: KeyGroup, row: KeyRow, i: number, here: readonly PlaceId[]): Found =>
  ({ id: rowId(p, g, i), place: p, group: g, row, here: here.includes(p.id) && p.id !== "everywhere" });

/** Every row, the open places first: what the bar's `?` lists with nothing typed after it. Mouse moves last in each group, as the sheet draws them. */
export function allRows(here: readonly PlaceId[]): Found[] {
  const out: Found[] = [];
  for (const id of orderOf(here)) {
    const p = PLACES.find((x) => x.id === id)!;
    for (const g of p.groups) {
      const rows = g.rows.map((row, i) => foundOf(p, g, row, i, here));
      out.push(...rows.filter((f) => !f.row.mouse), ...rows.filter((f) => f.row.mouse));
    }
  }
  return out;
}

/** A search of the table: the rows whose keys answer it (when it reads as keys), then those whose words do. Null for an empty search. */
export function searchKeys(query: string, here: readonly PlaceId[], barKey: string): Searched | null {
  const q = query.trim();
  if (!q) return null;
  const kq = keyQuery(q);
  const words = wordsRe(q);
  const order = orderOf(here);
  const keys: Array<Found & { rank: number }> = [];
  const said: Found[] = [];
  for (const p of PLACES) {
    for (const g of p.groups) {
      g.rows.forEach((row, i) => {
        const f = foundOf(p, g, row, i, here);
        const m = kq && !row.mouse ? matchKeys(keysOfRow(row, barKey), kq) : null;
        if (m) keys.push({ ...f, hits: m.hits, rank: m.rank });
        else if (words.test(row.does) || (row.note && words.test(row.note))) said.push(f);
      });
    }
  }
  const at = (p: KeyPlace) => order.indexOf(p.id);
  // the key itself before keys that only start like it (S before Shift and Space); in each, the open places first
  const exact = (f: { rank: number }) => (f.rank < 2 ? 0 : 1);
  keys.sort((a, b) => exact(a) - exact(b) || Number(b.here) - Number(a.here) || a.rank - b.rank || at(a.place) - at(b.place));
  said.sort((a, b) => Number(b.here) - Number(a.here) || at(a.place) - at(b.place));
  return { kq, keys, said, all: [...keys, ...said] };
}

/** What `afflatus:keys` may carry: the sheet opens on this place, with this row lit (the bar's `?` mode, Enter on a row). */
export interface KeysAsk {
  place: PlaceId;
  row: string;
}

/** Opens the keyboard shortcuts sheet, on a row when one is given. */
export const openKeys = (at?: KeysAsk) => window.dispatchEvent(new CustomEvent<KeysAsk | undefined>("afflatus:keys", { detail: at }));
