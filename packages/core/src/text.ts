/**
 * A text made a slug for a file name, an id or a typed word: lower case, its accents folded ("Crème brûlée" →
 * "creme-brulee"), every run of other signs one dash, no dash at either end, at most `max` characters. A text with
 * nothing left (only signs, or another script: "夜の街") gives "": the caller says what stands in for it.
 */
export const slug = (text: string, max = Infinity) =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** A count with its word: "1 take", "3 settings", "2 people" (`many` for a word that does not just take an s). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
