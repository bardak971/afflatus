/**
 * The bar's matching: pure, over labels lower-cased once when the index arrives. A keystroke scores every
 * entry with `score` (a string search, no allocation), keeps the best few, and only those few are worked out
 * again with `highlight` for what is drawn. Ten thousand entries take a few milliseconds.
 */

/** A label made ready for matching: lower-cased, and where each of its words starts. */
export interface Prepared {
  lower: string;
  /** The first letter of each word, in order: "harbor walk" → "hw". */
  initials: string;
  /** Where each word starts in `lower`. */
  starts: number[];
}

/** What starts a new word: a space, or a sign between words ("Harbor walk · c2 · t3", "night_market-04"). */
const SEPARATOR = /[\s·\-_/.,:;()[\]{}|+'"]/;

export function prepare(label: string): Prepared {
  const lower = label.toLowerCase();
  const starts: number[] = [];
  let initials = "";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    if (SEPARATOR.test(c)) continue;
    if (i === 0 || SEPARATOR.test(lower[i - 1]!)) {
      starts.push(i);
      initials += c;
    }
  }
  return { lower, initials, starts };
}

/** How the query matched, best first: the label holds it (from its start, from a word's), its words' initials, or its letters in order. */
export const QUALITY = { start: 1000, word: 800, inside: 600, words: 550, initials: 500, initialsInside: 420, letters: 200 } as const;

/**
 * How well `q` (lower-cased and trimmed) matches: 0 for not at all. Within a kind of match, a shorter label
 * and an earlier hit come first: "Harbor walk" before "Harbor walk · c2 · t3".
 */
export function score(p: Prepared, q: string): number {
  if (!q) return 1;
  const { lower } = p;
  const short = Math.min(lower.length, 80) * 0.5;
  const at = lower.indexOf(q);
  if (at === 0) return QUALITY.start + (lower.length === q.length ? 100 : 0) - short;
  if (at > 0) {
    // a word of the label starts with it: nearly as good as the label itself
    if (SEPARATOR.test(lower[at - 1]!)) return QUALITY.word - Math.min(at, 100) - short;
    return QUALITY.inside - Math.min(at, 100) - short;
  }
  // several words typed: each is somewhere in the label ("har wa")
  if (q.includes(" ")) {
    const parts = q.split(" ").filter(Boolean);
    if (parts.length > 1 && parts.every((w) => lower.includes(w))) return QUALITY.words - short;
  }
  if (q.length >= 2) {
    if (p.initials.startsWith(q)) return QUALITY.initials - short;
    if (p.initials.includes(q)) return QUALITY.initialsInside - short;
  }
  // the letters in order, the first one at the start of a word; the farther apart, the lower
  let gaps = 0;
  let from = -1;
  for (let k = 0; k < q.length; k++) {
    const c = q[k]!;
    if (c === " ") continue;
    const i = lower.indexOf(c, from + 1);
    if (i < 0) return 0;
    if (from >= 0) gaps += i - from - 1;
    else if (i > 0 && !SEPARATOR.test(lower[i - 1]!)) return 0;
    from = i;
  }
  // letters scattered across a long label are no match: "harbor" is not in "Prompt history in the bar"
  if (gaps > q.length * 3 + 8) return 0;
  return QUALITY.letters - Math.min(gaps, 150) - short;
}

/** The parts of the label `q` matched, as [start, end) ranges, for the accent. The same rules as `score`. */
export function highlight(p: Prepared, q: string): Array<[number, number]> {
  if (!q) return [];
  const { lower } = p;
  const at = lower.indexOf(q);
  if (at >= 0) return [[at, at + q.length]];
  if (q.includes(" ")) {
    const parts = q.split(" ").filter(Boolean);
    if (parts.length > 1 && parts.every((w) => lower.includes(w))) return merge(parts.map((w) => { const i = lower.indexOf(w); return [i, i + w.length] as [number, number]; }));
  }
  if (q.length >= 2) {
    const i = p.initials.indexOf(q);
    if (i >= 0) return p.starts.slice(i, i + q.length).map((s) => [s, s + 1] as [number, number]);
  }
  const out: Array<[number, number]> = [];
  let from = -1;
  for (const c of q) {
    if (c === " ") continue;
    const i = lower.indexOf(c, from + 1);
    if (i < 0) return [];
    out.push([i, i + 1]);
    from = i;
  }
  return merge(out);
}

/** Ranges in order, the ones that touch made one. */
function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** A label cut into its plain and matched parts, in order. */
export function pieces(label: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: label.slice(at, s), hit: false });
    out.push({ text: label.slice(s, e), hit: true });
    at = e;
  }
  if (at < label.length) out.push({ text: label.slice(at), hit: false });
  return out;
}

/**
 * The best `limit` of `items` for `q`: each scored, plus what `bonus` adds (what was used often and lately);
 * the ones that do not match are left out. Kept in a small sorted array: no sort of the whole list.
 */
export function search<T extends { p: Prepared }>(items: readonly T[], q: string, limit: number, bonus?: (item: T) => number): Array<{ item: T; score: number }> {
  const best: Array<{ item: T; score: number }> = [];
  const query = q.trim().toLowerCase();
  for (const item of items) {
    const s = score(item.p, query);
    if (s <= 0) continue;
    const total = s + (bonus ? bonus(item) : 0);
    if (best.length === limit && total <= best[best.length - 1]!.score) continue;
    // where it goes, from the end (most land near the end, or nowhere)
    let i = best.length;
    while (i > 0 && best[i - 1]!.score < total) i--;
    best.splice(i, 0, { item, score: total });
    if (best.length > limit) best.pop();
  }
  return best;
}
