import { slug } from "@afflatus/core";

/**
 * Prompt snippets typed by name (Settings › Command bar): the Prompt kit's snippets, each reached as `;` and
 * its name made a slug ("Cine look" → `;cine-look`), expand in a prompt box on a space or Tab. Pure: the box
 * hands in its text and where the cursor is, and gets both back.
 */

export interface Snippet {
  /** The kit's name of it ("Cine look"). */
  name: string;
  text: string;
}

/** A snippet's name as it is typed after `;`: lower case, every run of other signs a dash ("Cine look" → "cine-look"). */
export const slugOf = (name: string) => slug(name);

/** The `;word` being typed right before `caret`, and where its `;` is; null when the cursor is not at the end of one. */
export function typedTrigger(text: string, caret: number): { word: string; start: number } | null {
  // the `;` starts the text or follows a space, a line break, a comma or a bracket: "a;b" written on purpose stays
  const m = /(^|[\s,(]);([a-z0-9-]{0,60})$/i.exec(text.slice(0, caret));
  return m ? { word: m[2]!.toLowerCase(), start: caret - m[2]!.length - 1 } : null;
}

/** The snippets whose slug starts with what is typed after `;` (all of them for a bare `;`), the exact one first. */
export function snippetsFor<T extends Snippet>(word: string, snippets: readonly T[]): T[] {
  const w = word.toLowerCase();
  return snippets
    .map((s) => ({ s, slug: slugOf(s.name) }))
    .filter((x) => x.slug && x.slug.startsWith(w))
    .sort((a, b) => (a.slug === w ? -1 : b.slug === w ? 1 : a.slug.localeCompare(b.slug)))
    .map((x) => x.s);
}

/** The text with the `;word` from `start` to `caret` replaced by `with`, and where the cursor goes (after it). */
export function insertSnippet(text: string, start: number, caret: number, with_: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + with_ + text.slice(caret), caret: start + with_.length };
}

/**
 * The text with the `;name` that ends right before `caret` replaced by its snippet. Null when nothing there is
 * a snippet's name: the key then does what it always does.
 */
export function expandSnippet(text: string, caret: number, snippets: readonly Snippet[]): { text: string; caret: number } | null {
  const t = typedTrigger(text, caret);
  if (!t || !t.word) return null;
  const found = snippets.find((s) => slugOf(s.name) === t.word);
  return found ? insertSnippet(text, t.start, caret, found.text) : null;
}
