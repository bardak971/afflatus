/** The reset code's six boxes (SignIn.tsx): what typing, pasting and backspace do to them, apart from the page. */

export const CODE_LENGTH = 6;

export const emptyCode = (): string[] => Array.from({ length: CODE_LENGTH }, () => "");

/**
 * What box `at` now holds, as the browser says it (its old digit and what was typed after it, or a whole paste): the
 * digits spread over the boxes from there, a whole code from the first box whichever box it was pasted in. `focus`: the
 * box to go to next.
 */
export function typedInto(digits: string[], at: number, value: string): { digits: string[]; focus: number } {
  const old = digits[at] ?? "";
  // a box that held a digit and was typed into holds both: the new one is what follows the old
  const typed = old && value.length > 1 && value.startsWith(old) ? value.slice(old.length) : value;
  const got = typed.replace(/\D/g, "");
  if (!got) return { digits, focus: at };
  const from = got.length >= CODE_LENGTH ? 0 : at;
  const next = [...digits];
  for (let i = 0; i < got.length && from + i < CODE_LENGTH; i++) next[from + i] = got[i]!;
  return { digits: next, focus: Math.min(from + got.length, CODE_LENGTH - 1) };
}

/** Backspace in box `at`: its digit goes; an empty box takes the one before it, and the focus goes back there. */
export function backspaceAt(digits: string[], at: number): { digits: string[]; focus: number } {
  const next = [...digits];
  if (next[at]) {
    next[at] = "";
    return { digits: next, focus: at };
  }
  if (at === 0) return { digits, focus: 0 };
  next[at - 1] = "";
  return { digits: next, focus: at - 1 };
}

/** The code once every box holds a digit, else null. */
export const codeOf = (digits: string[]): string | null => (digits.length === CODE_LENGTH && digits.every((d) => /^\d$/.test(d)) ? digits.join("") : null);
