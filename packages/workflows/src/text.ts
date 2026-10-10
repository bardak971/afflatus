// Text helpers of the workflows, apart from the schemas in types.ts: what imports only these does not load zod (the web's
// Workflows screen; the package says it has no side effects, so the schemas are left out of a bundle that does not use them).

/**
 * Workflow authors name such a switch "X: True = A | False = B". That reads badly on a form: the name
 * and the two captions are taken apart.
 */
export function splitCaptions(label: string): { label: string; captions?: { on: string; off: string } } {
  // found piece by piece, not by one pattern: a long run of spaces or dashes would make that one backtrack
  const yes = /\btrue\s*=/i.exec(label);
  const rest = yes ? label.slice(yes.index + yes[0].length) : "";
  const no = /\|\s*false\s*=/i.exec(rest);
  const on = no ? rest.slice(0, no.index).trim() : "";
  const off = no ? rest.slice(no.index + no[0].length).trim() : "";
  if (!yes || !on || !off || /[\r\n]/.test(off)) return { label };
  let end = yes.index;
  while (end > 0 && /[\s:–-]/.test(label[end - 1]!)) end--;
  return { label: label.slice(0, end).trim() || "Mode", captions: { on, off } };
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workflow";
