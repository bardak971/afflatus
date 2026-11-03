/**
 * What the server keeps of a read so that it is made once: a promise per key, shared by whoever asks while it runs and
 * after. Written by hand about ten times (the 2026-11-02 review), each with its own mix of a time limit, a size limit
 * evicting first in first out, and whether a failure is kept: one here, the least recently used going first.
 */

/** A Map that holds its `max` most recently used entries: one read goes to the end, the least recently used goes first. */
export class Recent<K, V> extends Map<K, V> {
  constructor(public max: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

export interface KeptOptions<T> {
  /** How long a value is kept (ms); for as long as it is in the room without one. */
  ttlMs?: number;
  /** The most keys kept, the least recently used dropped first; no limit without one. */
  max?: number;
  /** Keep a read that failed (one that would fail the same way again); by default it is dropped and the next ask reads anew. */
  keepFailures?: boolean;
  /** Keep a value only while this says so (a read that came back empty, null for "could not be read", asked again). */
  keepIf?: (value: T) => boolean;
  /** Keep a read only while it runs: what is asked again before it is done waits for the same run, and the next starts anew. */
  whileRunning?: boolean;
  now?: () => number;
}

/** A read kept under its key (see the module's comment). */
export class Kept<T> {
  private readonly entries: Map<string, { at: number; value: Promise<T> }>;

  constructor(private readonly o: KeptOptions<T> = {}) {
    this.entries = o.max ? new Recent(o.max) : new Map();
  }

  /** The value kept under `key`, else `read()`'s, kept. */
  get(key: string, read: () => Promise<T>): Promise<T> {
    const now = this.o.now?.() ?? Date.now();
    const had = this.entries.get(key);
    if (had && (this.o.ttlMs === undefined || now - had.at < this.o.ttlMs)) return had.value;
    const entry = { at: now, value: read() };
    this.entries.set(key, entry);
    const drop = () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
    entry.value.then(
      (value) => {
        if (this.o.whileRunning || (this.o.keepIf && !this.o.keepIf(value))) drop();
      },
      () => {
        if (this.o.whileRunning || !this.o.keepFailures) drop();
      },
    );
    return entry.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** What is kept under `key` now, without reading it: undefined when nothing is (or it is out of time). */
  peek(key: string): Promise<T> | undefined {
    const had = this.entries.get(key);
    return had && (this.o.ttlMs === undefined || (this.o.now?.() ?? Date.now()) - had.at < this.o.ttlMs) ? had.value : undefined;
  }

  /** Drop the keys `test` picks (a file's every source, whatever else its key holds). */
  deleteWhere(test: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (test(key)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
