/**
 * Library items taken out of a draft's forms, for deleting one a draft still uses: the server writes the drafts it keeps
 * without them, the web the one open on screen (else its next autosave would write them back).
 */

/**
 * A form's value without these items: a value that is one of them (a picture's id) goes, and so does an object that
 * names one in its own fields (a clip `{ asset, at }`, a reference `{ asset, role }`); in a list, only those entries go.
 * Undefined: the whole value went.
 */
function without(value: unknown, ids: ReadonlySet<string>): unknown {
  if (typeof value === "string") return ids.has(value) ? undefined : value;
  if (Array.isArray(value)) return value.map((v) => without(v, ids)).filter((v) => v !== undefined);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v === "string" && ids.has(v))) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, without(v, ids)] as const).filter(([, v]) => v !== undefined));
}

/**
 * A draft's forms (recipe → input → value) without these items: an input that held one is left out, so that it follows
 * its default again (no picture), as a field emptied by hand does.
 */
export function formsWithout<T extends Record<string, Record<string, unknown>>>(forms: T, ids: ReadonlySet<string>): T {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [recipe, form] of Object.entries(forms)) {
    out[recipe] = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, without(v, ids)] as const).filter(([, v]) => v !== undefined));
  }
  return out as T;
}
