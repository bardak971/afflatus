/** What is done to the text of a prompt as it is written: weights, and one tag swapped for another. */

/**
 * The weight of a part of a prompt, one step up or down, the way A1111 and ComfyUI write it:
 * `(red dress:1.1)`. The part is what is selected; with nothing selected (`wholeTag`), the tag the
 * cursor is in, between two commas. Back at 1 the brackets come off. Returns the new text and what
 * to select in it (the part, weight and all), or null when there is nothing to weigh.
 */
export function nudgeWeight(text: string, start: number, end: number, delta: number, wholeTag = true): { text: string; start: number; end: number } | null {
  let s = start;
  let e = end;
  if (s === e) {
    if (!wholeTag) return null;
    s = Math.max(text.lastIndexOf(",", s - 1), text.lastIndexOf("\n", s - 1)) + 1;
    const stops = [text.indexOf(",", e), text.indexOf("\n", e)].filter((i) => i >= 0);
    e = stops.length ? Math.min(...stops) : text.length;
  }
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (s >= e) return null;
  let body = text.slice(s, e);
  let weight = 1;
  const own = /^\((.+):(-?\d+(?:\.\d+)?)\)$/s.exec(body);
  if (own) {
    body = own[1]!;
    weight = Number(own[2]);
  } else {
    // the part sits inside a weight already: "(red dress:1.2)" with only "red dress" selected
    const after = /^:(-?\d+(?:\.\d+)?)\)/.exec(text.slice(e));
    if (text[s - 1] === "(" && after) {
      s -= 1;
      e += after[0].length;
      weight = Number(after[1]);
    } else body = body.replace(/^\((.*)\)$/s, "$1");
  }
  const next = Math.round((weight + delta) * 100) / 100;
  const written = Math.abs(next - 1) < 0.001 ? body : `(${body}:${Number.isInteger(next * 10) ? next.toFixed(1) : next.toFixed(2)})`;
  return { text: text.slice(0, s) + written + text.slice(e), start: s, end: s + written.length };
}

const OPEN = "([{";
const CLOSE = ")]}";
/** The tag inside its weight: "(red eyes:1.2)" is "red eyes". */
function inner(raw: string): string {
  let s = raw.trim();
  for (;;) {
    const i = OPEN.indexOf(s[0] ?? " ");
    if (i < 0 || s[s.length - 1] !== CLOSE[i]) break;
    s = s.slice(1, -1).trim();
  }
  return s.replace(/:\s*-?\d+(?:\.\d+)?$/, "").trim();
}

/** One tag of a prompt swapped for another, wherever it stands (between commas, or as a choice in braces): its weight and the layout stay. */
export function replaceTag(prompt: string, from: string, to: string): string {
  return prompt
    .split(/([,\n{}|])/)
    .map((part) => (part.trim() === from ? part.replace(inner(from), to) : part))
    .join("");
}

/** A tag as it is compared: without its weight, lower case, one space between words. */
const keyOf = (tag: string) => inner(tag).toLowerCase().replace(/\s+/g, " ");
const tagsOf = (text: string) => text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

/**
 * Which of some words a prompt already holds. In tags, each word between commas is looked for on its
 * own (with or without a weight); in sentences the words are one phrase.
 */
export function wordsIn(prompt: string, words: string, style: "tags" | "sentences"): { any: boolean; all: boolean } {
  const add = words.trim();
  if (!add) return { any: false, all: false };
  if (style === "sentences") {
    const there = prompt.toLowerCase().includes(add.toLowerCase());
    return { any: there, all: there };
  }
  const have = new Set(tagsOf(prompt).map(keyOf));
  const wanted = tagsOf(add).map(keyOf);
  return { any: wanted.some((w) => have.has(w)), all: wanted.every((w) => have.has(w)) };
}

/** Text added at the end of a prompt: after a comma for tags, after a space for sentences. Nothing is added twice. */
export function appendTo(prompt: string, more: string, style: "tags" | "sentences"): string {
  const now = prompt.trim();
  let add = more.trim();
  if (style === "tags") {
    // only the tags that are not there yet
    const have = new Set(tagsOf(prompt).map(keyOf));
    add = tagsOf(add).filter((t) => !have.has(keyOf(t))).join(", ");
  } else if (now.toLowerCase().includes(add.toLowerCase())) add = "";
  if (!add) return prompt;
  if (!now) return add;
  return style === "tags" ? `${now.replace(/,\s*$/, "")}, ${add}` : `${now} ${add}`;
}

/** Words taken out of a prompt, wherever they stand: the tags one by one (weighted or not), or the phrase. The rest keeps its layout. */
export function removeFrom(prompt: string, words: string, style: "tags" | "sentences"): string {
  const gone = words.trim();
  if (!gone) return prompt;
  if (style === "sentences") {
    const phrase = new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
    return prompt.replace(phrase, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/^[\s,]+/, "").trimEnd();
  }
  const drop = new Set(tagsOf(gone).map(keyOf));
  return prompt
    .split("\n")
    .map((line) => {
      const kept = line.split(",").filter((part) => !part.trim() || !drop.has(keyOf(part)));
      // what a removed tag leaves behind: a comma with nothing after it, a space at the start
      return kept.filter((part, i) => part.trim() || i === kept.length - 1).join(",").replace(/^\s*,?\s*/, "").replace(/,\s*$/, "");
    })
    .join("\n");
}
