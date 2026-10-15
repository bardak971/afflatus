/**
 * The reset code's one field (SignIn.tsx): 10 characters of Crockford's base32, shown "K7M2P-9XQ4R". What is typed or
 * pasted is upper-cased, read as the server reads it (I and L as 1, O as 0, dashes and spaces dropped), and grouped again.
 */

export const CODE_LENGTH = 10;
const ALPHABET = /[0-9A-HJKMNP-TV-Z]/;

/** The characters of a code in what was typed, as the server keeps them, at most ten. */
function plain(text: string): string {
  return [...text.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0")].filter((c) => ALPHABET.test(c)).join("").slice(0, CODE_LENGTH);
}

/** What the field shows for what was typed: the dash after the fifth character, once there is a sixth. */
export function codeShown(text: string): string {
  const p = plain(text);
  return p.length > 5 ? `${p.slice(0, 5)}-${p.slice(5)}` : p;
}

/** The code to send once all ten characters are there, else null. */
export function codeOf(text: string): string | null {
  const p = plain(text);
  return p.length === CODE_LENGTH ? p : null;
}
