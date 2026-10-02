/**
 * Choices written in a prompt: `{red|black|white} dress` becomes one of the three, picked afresh for
 * every picture, so "Make 4" gives four different ones. A choice can hold choices, and one can be
 * empty (`{|, smiling}`: sometimes nothing). Braces without a bar are left as they are.
 */

const CHOICE = /\{([^{}]*\|[^{}]*)\}/;

export const hasWildcards = (text: string): boolean => CHOICE.test(text);

export function expandWildcards(text: string, random: () => number = Math.random): string {
  let out = text;
  // the innermost first, so that a choice inside a choice is settled before the one around it
  for (let i = 0; i < 500; i++) {
    const m = CHOICE.exec(out);
    if (!m) break;
    const options = m[1]!.split("|");
    const pick = options[Math.min(options.length - 1, Math.floor(random() * options.length))]!;
    out = out.slice(0, m.index) + pick + out.slice(m.index + m[0].length);
  }
  return out;
}
