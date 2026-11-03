import type { KyselyPlugin, OperationNode, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from "kysely";
import { Kept } from "./kept";

/**
 * How many writes each table has had since the server started, counted by a Kysely plugin on every query (openDb): a view
 * built from some tables (Settings › Model files' list, card #244) is kept until one of them is written to, with no write
 * site to remember. A write is counted once it has run, so that a view built after the count reads it. A statement written
 * by hand (`sql`) that writes is counted for every table, its table not being read from it.
 */
const counts = new Map<string, number>();
let everyTable = 0;
// by query, until it has run (a query that failed is never counted, and its entry goes with it)
const pending = new WeakMap<object, string>();

/** The table an insert, update or delete writes to; "*" for a raw statement that writes; null for anything else. */
function writes(node: RootOperationNode): string | null {
  const nameOf = (n: OperationNode | undefined): string | null => {
    if (!n) return null;
    if (n.kind === "TableNode") return (n as unknown as { table: { identifier: { name: string } } }).table.identifier.name;
    if (n.kind === "AliasNode") return nameOf((n as unknown as { node: OperationNode }).node);
    return null;
  };
  if (node.kind === "InsertQueryNode") return nameOf(node.into);
  if (node.kind === "UpdateQueryNode") return nameOf(node.table);
  if (node.kind === "DeleteQueryNode") return nameOf(node.from.froms[0]);
  if (node.kind === "RawNode") return /^\s*(insert|update|delete|replace)\b/i.test(node.sqlFragments.join("?")) ? "*" : null;
  return null;
}

export const writeCounter: KyselyPlugin = {
  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    const table = writes(node);
    if (table) pending.set(queryId, table);
    return node;
  },
  async transformResult({ queryId, result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const table = pending.get(queryId);
    if (table) {
      pending.delete(queryId);
      if (table === "*") everyTable++;
      else counts.set(table, (counts.get(table) ?? 0) + 1);
    }
    return result;
  },
};

/** The writes to these tables (or to tables starting with one ending in "*") so far: unchanged, nothing was written to them. */
export function writesTo(tables: readonly string[]): number {
  let n = everyTable;
  for (const [table, k] of counts) if (tables.some((t) => (t.endsWith("*") ? table.startsWith(t.slice(0, -1)) : table === t))) n += k;
  return n;
}

/** How long a kept read stands at most: a write on another connection (Postgres's pool) may land after its count. */
const KEPT_MS = 60_000;

/**
 * A read kept, by database, until one of its tables is written to (kept under the count of their writes: a write while it
 * was read makes the next ask a read of its own), the same answer for every caller meanwhile, never to be changed by them.
 */
export function keptRead<D extends object, T>(tables: readonly string[], read: (db: D) => Promise<T>): (db: D) => Promise<T> {
  const kept = new WeakMap<D, Kept<T>>();
  return (db) => {
    let k = kept.get(db);
    if (!k) kept.set(db, (k = new Kept<T>({ ttlMs: KEPT_MS, max: 1 })));
    return k.get(String(writesTo(tables)), () => read(db));
  };
}
