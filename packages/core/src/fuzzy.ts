/**
 * Forgiving search for every search bar: what is typed does not have to be exact. Each word typed has
 * to be found, either as it is or as its letters in order ("ilxl" finds "Illustrious XL"); words can
 * come in any order; case and accents do not count. Better matches come first.
 */

const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isBreak = (c: string | undefined) => c === undefined || /[\s_\-./\\()[\]:·,]/.test(c);

/** How well one typed word matches: higher is better, null is no match. */
function wordScore(word: string, text: string): number | null {
  const at = text.indexOf(word);
  if (at >= 0) {
    // the word as typed: best at the very start, then at the start of a word, then anywhere
    return 100 + (at === 0 ? 30 : isBreak(text[at - 1]) ? 20 : 0) - Math.min(at, 20) * 0.1;
  }
  // its letters in order, the fewer and shorter the gaps the better
  let score = 40;
  let from = 0;
  let last = -1;
  let gaps = 0;
  for (const letter of word) {
    const i = text.indexOf(letter, from);
    if (i < 0) return null;
    if (last >= 0) gaps += i - last - 1;
    if (isBreak(text[i - 1])) score += 3;
    last = i;
    from = i + 1;
  }
  // letters scattered over a long text are a coincidence, not a match
  if (gaps > word.length * 4) return null;
  return Math.max(1, score - gaps * 2);
}

/** How well `text` matches what was typed: null when it does not; an empty query matches everything equally. */
export function fuzzyScore(query: string, text: string): number | null {
  const words = plain(query).split(/\s+/).filter(Boolean);
  const hay = plain(text);
  let total = 0;
  for (const word of words) {
    const s = wordScore(word, hay);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** The items that match, best first; with nothing typed, all of them in their own order. */
export function fuzzyFilter<T>(items: T[], query: string, textOf: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, textOf(item)) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
