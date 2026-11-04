/**
 * A person of the cast typed by name in a region's prompt: `@` and the start of their name, as `;` does a snippet. Pure,
 * for the tests; RegionsField lists the people it starts and puts the one picked on the region.
 */

/**
 * The `@name` the cursor is at the end of: where it starts and what is typed after the `@` (empty for a bare `@`). A name may
 * hold spaces ("@Mira Lund"): what follows the `@` up to the cursor is read whole, and the list says whether it still starts
 * someone's name (peopleFor), so words typed on after a name close it.
 */
export function typedPerson(text: string, caret: number): { word: string; start: number } | null {
  // the `@` starts the text or follows a space, a line break, a comma or a bracket: an e-mail address stays as it is
  const m = /(^|[\s,(])@((?:[^\s@,()][^@\n,()]{0,39})?)$/u.exec(text.slice(0, caret));
  return m ? { word: m[2]!.toLowerCase(), start: caret - m[2]!.length - 1 } : null;
}

/** The people whose name starts with what is typed (or holds it as a word), the exact name first. */
export function peopleFor<T extends { name: string }>(word: string, people: readonly T[]): T[] {
  const w = word.toLowerCase();
  const name = (p: T) => p.name.toLowerCase();
  return people
    .filter((p) => name(p).startsWith(w) || name(p).split(/\s+/).some((part) => part.startsWith(w)))
    .sort((a, b) => Number(name(b) === w) - Number(name(a) === w) || Number(name(b).startsWith(w)) - Number(name(a).startsWith(w)) || a.name.localeCompare(b.name));
}

/** The text with the `@word` taken out (the person goes on the region, not into its words), and where the cursor goes. */
export function withoutTyped(text: string, start: number, caret: number): { text: string; caret: number } {
  const before = text.slice(0, start);
  // one space left between what was on either side, none at the start
  const after = text.slice(caret).replace(/^\s+/, before && !/\s$/.test(before) ? " " : "");
  return { text: before + after, caret: start };
}
