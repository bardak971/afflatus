import type { Download } from "./api";

/**
 * The downloads' line, read from the server's list (downloads.ts): per ComfyUI, what is under way, what waits its turn in
 * order, what was done today and what failed, with what is left and when it ends. One reading for the status bar's popover,
 * the Downloads card in Settings › Models and each file's own state (FileState), so that they never say two things.
 */

/** Still coming: waiting its turn, under way, or whole and being listed by ComfyUI. */
export const coming = (d: Download) => d.status === "starting" || d.status === "downloading" || d.status === "saving";

/**
 * Waiting its turn: asked for, not begun (the server says what it waits behind). One begun that waits on its node pack (its
 * line full) is under way, not in the line: the server does not move it, and dragging it said "Not moved".
 */
export const inLine = (d: Download) => d.status === "starting" && Boolean(d.waiting) && !d.begun;

/** What is left of a file to fetch, in bytes; 0 when its size is not known. */
const leftOf = (d: Download) => (d.total > 0 ? Math.max(0, d.total - d.bytes) : 0);

export interface Line {
  /** The ComfyUI's id; the first one's for a download asked without one. */
  machine: string | undefined;
  under: Download[];
  /** Waiting their turn, in the order they start. */
  next: Download[];
  /** Done today, the last first. */
  done: Download[];
  /** Failed, the last first (stopped ones are not said: the user stopped them). */
  failed: Download[];
  /** Bytes left of what is under way and waiting (sizes not known count nothing). */
  left: number;
  /** Some size is not known: what is left is at least `left`. */
  unsized: boolean;
  /** Bytes a second of what is under way, together. */
  rate: number;
}

/** The time a number of bytes takes at a rate, in ms; null with nothing measured. */
export const msFor = (bytes: number, rate: number) => (rate > 0 ? (bytes / rate) * 1000 : null);

/**
 * The downloads by ComfyUI, in the order the list names them first (the first ComfyUI first). `first` is the first
 * ComfyUI's id: a download asked without a machine went there. `now` decides "today".
 */
export function linesOf(items: Download[], first: string | undefined, now = Date.now()): Line[] {
  const today = new Date(now).toDateString();
  const by = new Map<string | undefined, Download[]>();
  for (const d of items) {
    const key = d.machine ?? first;
    by.set(key, [...(by.get(key) ?? []), d]);
  }
  const keys = [...by.keys()].sort((a, b) => Number(b === first) - Number(a === first));
  return keys.map((machine) => {
    const all = by.get(machine)!;
    const under = all.filter((d) => coming(d) && !inLine(d)).sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
    // the server's own line first, by place; ComfyUI-Manager's waiting ones (no place) after them
    const next = all.filter(inLine).sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity));
    const ended = (d: Download) => -(d.at ?? 0);
    const done = all.filter((d) => d.status === "done" && (!d.at || new Date(d.at).toDateString() === today)).sort((a, b) => ended(a) - ended(b));
    const failed = all.filter((d) => d.status === "error").sort((a, b) => ended(a) - ended(b));
    const busy = [...under, ...next];
    return {
      machine, under, next, done, failed,
      left: busy.reduce((n, d) => n + leftOf(d), 0),
      unsized: busy.some((d) => d.status !== "saving" && !d.total),
      rate: under.reduce((n, d) => n + (d.rate ?? 0), 0),
    };
  });
}

/**
 * About how long before a waiting file starts, in ms: what is left ahead of it (those under way and those before it in
 * line) at the rate of what comes now, less the file that keeps coming beside it (two run at a time: it starts once all
 * but one of those ahead are done). Null with nothing measured, or a size ahead not known.
 */
export function startsIn(line: Line, d: Download): number | null {
  const at = line.next.indexOf(d);
  if (at < 0 || line.rate <= 0) return null;
  const ahead = [...line.under, ...line.next.slice(0, at)];
  if (ahead.some((o) => o.status !== "saving" && !o.total)) return null;
  const lefts = ahead.map(leftOf).sort((a, b) => a - b);
  // the biggest of those ahead is still coming when a place frees up for it
  return msFor(lefts.slice(0, -1).reduce((n, b) => n + b, 0), line.rate);
}

/** One file's download in the line it is in: its line, found by its id. */
export const lineOfFile = (lines: Line[], d: Download) => lines.find((l) => [...l.under, ...l.next].includes(d)) ?? null;
