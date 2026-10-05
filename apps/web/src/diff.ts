/** A run of a text as it stands against an earlier one: kept, new, or gone. */
interface Piece {
  text: string;
  kind: "same" | "added" | "removed";
}

const tokens = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
/** Two runs of white space are the same thing, whatever they are made of: a line break that became a space is no change. */
const key = (t: string) => (/^\s/.test(t) ? " " : t);
/** Past this many words on a side, the comparison is not made: it would hold the page. */
const MOST = 1400;

/**
 * What changed between two texts, word by word: the new text in order, with what was added marked and
 * what was taken out left in place, struck. Null when the texts are too long to compare.
 */
export function wordDiff(before: string, after: string): Piece[] | null {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MOST || b.length > MOST) return null;
  const n = a.length;
  const m = b.length;
  // the longest run of words the two share, in order: what is in neither's share was taken out or added
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = key(a[i]!) === key(b[j]!) ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const out: Piece[] = [];
  const push = (text: string, kind: Piece["kind"]) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]!) === key(b[j]!)) {
      push(b[j]!, "same");
      i++;
      j++;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) push(a[i++]!, "removed");
    else push(b[j++]!, "added");
  }
  while (i < n) push(a[i++]!, "removed");
  while (j < m) push(b[j++]!, "added");
  // white space alone is never shown as a change
  return out.map((p) => (p.kind !== "same" && !p.text.trim() ? { text: p.kind === "removed" ? "" : p.text, kind: "same" as const } : p)).filter((p) => p.text);
}

/** How much of the new text is new, 0 to 1: a text that was rewritten from end to end is better read plain. */
export function changedShare(pieces: Piece[]): number {
  const count = (kind: Piece["kind"]) => pieces.filter((p) => p.kind === kind).reduce((sum, p) => sum + p.text.length, 0);
  const all = count("same") + count("added");
  return all ? count("added") / all : 0;
}
