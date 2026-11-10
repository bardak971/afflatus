import { totalmem } from "node:os";

/**
 * What the server's process says about itself for the bundle's log (scripts/release/launch.mjs keeps it in
 * DATA_DIR/logs/afflatus-<day>.log): a crash with its error and stack before it exits, and the memory it holds as it grows.
 * Up to 0.10.0 a server that stopped mid-work on a Mac gave the prompt back with no word (2026-11-10); a kill by the system
 * (SIGKILL, mostly for lack of memory) leaves nothing a handler could say, so the memory lines before it are the clue.
 */

/** The line a crash is said with: when, how it came (an exception or a promise nobody waited for), and the stack. */
export function crashLine(err: unknown, origin: string, at = new Date()): string {
  const said = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `[crash] ${at.toISOString()} Afflatus's server stopped on ${origin === "unhandledRejection" ? "a promise rejected with no one to catch it" : "an uncaught exception"}:\n${said}`;
}

/** The whole gigabytes held from which the memory is said, and then at each new one. */
const SAID_FROM_GB = 2;

/**
 * The memory line for `rss` bytes held, when it passes a whole gigabyte not passed before (2 GB and up): null otherwise.
 * `said` is the highest gigabyte said already, which the caller keeps.
 */
export function memoryLine(rss: number, said: number, total = totalmem()): { line: string; said: number } | null {
  const gb = Math.floor(rss / 2 ** 30);
  if (gb < SAID_FROM_GB || gb <= said) return null;
  return { line: `[memory] the server holds ${(rss / 2 ** 30).toFixed(1)} GB, the most this run (of the ${Math.round(total / 2 ** 30)} GB this computer has)`, said: gb };
}

/** How often the memory held is read. */
const MEMORY_EVERY_MS = 30_000;

/** Installed once, by index.ts (never in the tests, whose process is not the server's). */
export function watchProcess(): void {
  // the bundle's launcher reads these through pipes, which are written asynchronously on macOS and Linux: a line written
  // just before process.exit (a crash, a port taken) could be lost. Blocking, it reaches the launcher, and the log, first
  for (const stream of [process.stdout, process.stderr]) (stream as unknown as { _handle?: { setBlocking?: (on: boolean) => void } })._handle?.setBlocking?.(true);
  // Node prints an uncaught error's stack by itself, but with no time and no word that the server stops on it: said here,
  // then the process ends as it would have (the launcher then says "exit code 1" and where the log is)
  process.on("uncaughtException", (err, origin) => {
    try {
      console.error(crashLine(err, origin));
    } finally {
      process.exit(1);
    }
  });
  let said = 0;
  setInterval(() => {
    const next = memoryLine(process.memoryUsage.rss(), said);
    if (!next) return;
    said = next.said;
    console.log(next.line);
  }, MEMORY_EVERY_MS).unref();
}
