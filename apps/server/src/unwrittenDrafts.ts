import type { Db, Tables } from "./db";
import type { Look } from "./entities";

/**
 * Drafts that hold nothing yet (a blank form, "New draft") are kept in memory, never written: so never listed,
 * counted, searched or left behind. The first thing worth keeping put in one (see holdsSomething in drafts.ts), or a render sent
 * from it, writes it under the same id. Per database (tests run several at once); a restart forgets them, with
 * nothing in them to lose.
 */
const unwritten = new WeakMap<Db, Map<string, Tables["drafts"]>>();
export const unwrittenOf = (db: Db) => {
  let m = unwritten.get(db);
  if (!m) unwritten.set(db, (m = new Map()));
  return m;
};

/**
 * Someone or something of the kit deleted: gone from the looks of the drafts not written yet too (the written ones are
 * cleaned with the timelines, see dropFromLooks).
 */
export function dropFromUnwritten(db: Db, id: string): void {
  for (const d of unwrittenOf(db).values()) {
    if (!d.look) continue;
    const l = JSON.parse(d.look) as Look;
    d.look = JSON.stringify({ ...l, cast: l.cast.filter((c) => c.id !== id), style: l.style === id ? null : l.style, snippets: (l.snippets ?? []).filter((x) => x !== id) });
  }
}
