import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./db";

/**
 * Work done one at a time per key, in the order asked. A read, then a write that depends on it, is only safe when nothing
 * else writes the same thing in between: with the database in its worker thread (or a disk or ComfyUI call between the
 * two), another request runs at every await. Work asked for from inside a turn of the same key runs in that turn: waiting
 * for the turn it is part of would wait forever. Never wait for a turn from inside a transaction: the work that has the
 * turn may be waiting for the database the transaction holds.
 */
export class KeyedLock {
  /** What runs one at a time, by key: the work waiting last for each. */
  private readonly turns = new Map<string, Promise<unknown>>();
  /** The keys whose turn the work running now holds: work it calls for under the same key runs inside that turn. */
  private readonly holding = new AsyncLocalStorage<ReadonlySet<string>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const held = this.holding.getStore();
    if (held?.has(key)) return work();
    const inTurn = () => this.holding.run(new Set([...(held ?? []), key]), work);
    const mine = (this.turns.get(key) ?? Promise.resolve()).then(inTurn);
    const settled = mine.then(() => {}, () => {});
    this.turns.set(key, settled);
    void settled.then(() => {
      if (this.turns.get(key) === settled) this.turns.delete(key);
    });
    return mine;
  }
}

/** The turns of one database's rows (tests run several databases at once, each with its own). */
const locks = new WeakMap<Db, KeyedLock>();

/** `work` in the turn of `key` ("draft:<id>", "settings") on this database. */
export function oneAtATime<T>(db: Db, key: string, work: () => Promise<T>): Promise<T> {
  let lock = locks.get(db);
  if (!lock) locks.set(db, (lock = new KeyedLock()));
  return lock.run(key, work);
}
