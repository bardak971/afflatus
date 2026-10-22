import { Worker } from "node:worker_threads";
import { SqliteDriver, type CompiledQuery, type DatabaseConnection, type QueryResult, type SqliteDatabase } from "kysely";

/**
 * The most the WAL file keeps on the disk once a checkpoint has written it back (bytes). Left unset, it stayed as large as
 * the biggest burst of writes since the start (a fold, an import, a first tidy of old jobs) for as long as the app ran.
 * The commits stay synchronous = FULL, the default: NORMAL would save about a millisecond a commit but can lose the last
 * one on a power cut, which is the owner's call.
 */
export const JOURNAL_LIMIT = 16 * 1024 * 1024;

/**
 * SQLite in a worker thread. node:sqlite runs every statement synchronously: on the server's own thread, a route that reads
 * for 30 ms holds every other request, the SSE frames and the video Range reads for those 30 ms. Here one worker owns the
 * database and runs the statements one after the other, while the server's thread goes on with the rest.
 *
 * One worker is one connection, as the in-thread SQLite was: Kysely's SqliteAdapter says it has no second connection, so its
 * runtime lets one query or one transaction hold it at a time and queues the others. A transaction's statements, and only
 * them, run between its begin and its commit or rollback.
 *
 * The worker's code is a string run with `eval`, not a file of its own: the same source then works under tsx, under vitest
 * and in the release's single bundled file, none of which would load a TypeScript file in a worker the same way.
 */
const WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
// What an error carries across the thread: structured cloning keeps an Error's message but drops node:sqlite's code fields.
const pack = (err) => ({ name: err?.name ?? "Error", message: err?.message ?? String(err), code: err?.code, errcode: err?.errcode, errstr: err?.errstr });
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA journal_size_limit = ${JOURNAL_LIMIT}");
  db.exec("PRAGMA foreign_keys = ON");
  parentPort.postMessage({ id: 0 });
} catch (err) {
  parentPort.postMessage({ id: 0, error: pack(err) });
}
// Prepared statements are kept by their SQL: Kysely compiles the same handful of queries again and again, and preparing is a
// good part of a small query's cost. The least recently used ones go past the limit.
const cache = new Map();
const LIMIT = 300;
function prepared(sql) {
  let entry = cache.get(sql);
  if (entry) {
    cache.delete(sql);
  } else {
    const stmt = db.prepare(sql);
    // a statement "reads" when it returns rows (SELECT, or anything with RETURNING)
    entry = { stmt, reader: stmt.columns().length > 0 };
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value);
  }
  cache.set(sql, entry);
  return entry;
}
parentPort.on("message", (m) => {
  if (m.close) {
    cache.clear();
    try { db?.close(); } catch {}
    parentPort.postMessage({ id: m.id });
    return;
  }
  try {
    const { stmt, reader } = prepared(m.sql);
    if (reader) parentPort.postMessage({ id: m.id, rows: stmt.all(...m.params) });
    else {
      const { changes, lastInsertRowid } = stmt.run(...m.params);
      parentPort.postMessage({ id: m.id, changes, lastInsertRowid });
    }
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: pack(err) });
  }
});
`;

type Packed = { name: string; message: string; code?: string; errcode?: number; errstr?: string };
type Reply = { id: number; error?: Packed; rows?: unknown[]; changes?: number | bigint; lastInsertRowid?: number | bigint };
type Waiting = { resolve: (reply: Reply) => void; reject: (err: Error) => void; trace: { stack?: string } };

/** The thread side: sends each statement to the worker and gives back its answer, in the order they were sent. */
class SqliteWorker {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, Waiting>();
  private next = 1;
  private gone: Error | undefined;
  readonly ready: Promise<void>;

  constructor(file: string) {
    this.worker = new Worker(WORKER, { eval: true, workerData: { file } });
    // An idle worker does not keep the process alive (a test that never closes its database still ends); one with a statement
    // in flight does, so that the answer is not lost.
    this.worker.unref();
    this.worker.on("message", (reply: Reply) => this.answer(reply));
    this.worker.on("error", (err) => this.fail(err));
    this.worker.on("exit", (code) => this.fail(new Error(`The database worker stopped (exit code ${code}).`)));
    this.ready = this.send({ id: 0 }, true).then(() => undefined);
  }

  async run(sql: string, params: readonly unknown[]): Promise<Reply> {
    return this.send({ sql, params });
  }

  async close(): Promise<void> {
    if (this.gone) return;
    await this.send({ close: true }).catch(() => undefined);
    this.gone = new Error("The database is closed.");
    await this.worker.terminate();
  }

  private send(message: Record<string, unknown>, opening = false): Promise<Reply> {
    if (this.gone) return Promise.reject(this.gone);
    // Where the statement was asked from, kept for its error: one built when the answer comes back has no caller in its stack.
    const trace: { stack?: string } = {};
    Error.captureStackTrace(trace, this.send);
    const id = opening ? 0 : this.next++;
    return new Promise<Reply>((resolve, reject) => {
      if (this.waiting.size === 0) this.worker.ref();
      this.waiting.set(id, { resolve, reject, trace });
      if (!opening) this.worker.postMessage({ ...message, id });
    });
  }

  private answer(reply: Reply): void {
    const waiting = this.waiting.get(reply.id);
    if (!waiting) return;
    this.waiting.delete(reply.id);
    if (this.waiting.size === 0) this.worker.unref();
    if (reply.error) waiting.reject(rebuild(reply.error, waiting.trace));
    else waiting.resolve(reply);
  }

  private fail(err: Error): void {
    this.gone ??= err;
    for (const waiting of this.waiting.values()) waiting.reject(err);
    this.waiting.clear();
  }
}

/** node:sqlite's error as the thread would have thrown it: the same message and code fields, with the caller's stack. */
function rebuild(packed: Packed, trace: { stack?: string }): Error {
  const err: Error & Omit<Partial<Packed>, "name" | "message"> = new Error(packed.message);
  if (packed.name !== "Error") err.name = packed.name;
  if (packed.code !== undefined) err.code = packed.code;
  if (packed.errcode !== undefined) err.errcode = packed.errcode;
  if (packed.errstr !== undefined) err.errstr = packed.errstr;
  const frames = trace.stack?.split("\n").slice(1).join("\n");
  if (frames) err.stack = `${err.name}: ${err.message}\n${frames}`;
  return err;
}

class WorkerConnection implements DatabaseConnection {
  constructor(private readonly sqlite: SqliteWorker) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const reply = await this.sqlite.run(compiled.sql, compiled.parameters);
    if (reply.rows) return { rows: reply.rows as R[] };
    return {
      insertId: reply.lastInsertRowid != null ? BigInt(reply.lastInsertRowid) : undefined,
      numAffectedRows: reply.changes != null ? BigInt(reply.changes) : undefined,
      rows: [],
    };
  }

  /** Nothing here streams; the rows come across at once and are handed out one by one, as Kysely's SQLite driver does. */
  async *streamQuery<R>(compiled: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const { rows } = await this.executeQuery<R>(compiled);
    for (const row of rows) yield { rows: [row] };
  }
}

/**
 * Kysely's SQLite driver with the worker in place of a database on this thread. Its begin, commit, rollback and savepoints
 * are statements sent through the connection like any other, so they are kept as they are.
 */
export class WorkerSqliteDriver extends SqliteDriver {
  private sqlite: SqliteWorker | undefined;
  private connection: WorkerConnection | undefined;

  constructor(private readonly file: string) {
    // The database given to the base class is never opened: init below replaces it.
    super({ database: {} as SqliteDatabase });
  }

  override async init(): Promise<void> {
    this.sqlite = new SqliteWorker(this.file);
    this.connection = new WorkerConnection(this.sqlite);
    try {
      await this.sqlite.ready;
    } catch (err) {
      await this.sqlite.close();
      throw err;
    }
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection!;
  }

  override async destroy(): Promise<void> {
    await this.sqlite?.close();
  }
}
