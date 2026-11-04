/**
 * Choices written in a prompt: `{red|black|white} dress` becomes one of the three, picked afresh for
 * every picture, so "Make 4" gives four different ones. A choice can hold choices, and one can be
 * empty (`{|, smiling}`: sometimes nothing). Braces without a bar are left as they are.
 *
 * `__colors__` is a wildcard file (the packs shared on Civitai, as ComfyUI's Impact and Dynamic Prompts packs read them):
 * one line of `colors.txt` is picked, `__clothes/hats__` reads `clothes/hats.txt`. A line can hold choices and names of
 * other files. The server finds the files (wildcardFiles.ts); here they are only read.
 */

/**
 * One choice with no choice inside it. The part before the first bar takes no bar: with one, a long run
 * of bars made every try go back over all of them, and a prompt can be megabytes long.
 */
export const CHOICE = /\{([^{}|]*\|[^{}]*)\}/;

/**
 * A wildcard file's name between double underscores, as the Impact pack takes it (letters, digits, `_ - . + /`), not
 * starting with an underscore: a run of underscores in a tag ("^___^") is no name.
 */
export const FILE_CHOICE = /__([\p{L}\p{N}][\p{L}\p{N}_.+/-]*?)__/u;

export const hasWildcards = (text: string): boolean => CHOICE.test(text) || FILE_CHOICE.test(text);

/** The lines of a wildcard file by its name as written (`clothes/hats`); undefined when there is no such file. */
export type WildcardFiles = (name: string) => readonly string[] | undefined;

/** A prompt names a wildcard file there is none of. */
export class MissingWildcard extends Error {
  constructor(readonly file: string) {
    super(`there is no wildcard file "${file}.txt"`);
  }
}

/** Choices settled this many times at most: a file that names itself would never end. */
const MOST = 500;

/**
 * A text with its choices settled. `files`: the wildcard files, without which `__name__` is left as written. Throws
 * MissingWildcard for a name with no file, and an Error when files name each other round in a circle.
 */
export function expandWildcards(text: string, random: () => number = Math.random, files?: WildcardFiles): string {
  const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
  let out = text;
  // the innermost first, so that a choice inside a choice is settled before the one around it; a file's line is put in
  // as it is, and its own choices settled on the next turns
  for (let i = 0; i < MOST; i++) {
    const m = CHOICE.exec(out);
    if (m) {
      out = out.slice(0, m.index) + pick(m[1]!.split("|")) + out.slice(m.index + m[0].length);
      continue;
    }
    const f = files ? FILE_CHOICE.exec(out) : null;
    if (!f) return out;
    const lines = files!(f[1]!);
    if (!lines) throw new MissingWildcard(f[1]!);
    // an empty file puts nothing in, as an empty choice does
    out = out.slice(0, f.index) + (lines.length ? pick(lines) : "") + out.slice(f.index + f[0].length);
  }
  if (files && FILE_CHOICE.test(out)) throw new Error("the wildcard files name each other round in a circle");
  return out;
}

/**
 * The same picks for the same seed (mulberry32): a typed seed renders the same prompt again. `salt` sets apart the texts
 * of one form (the prompt and the negative), which would otherwise pick from the same draws.
 */
export function seededRandom(seed: number, salt = ""): () => number {
  let h = seed >>> 0;
  for (const c of salt) h = Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
