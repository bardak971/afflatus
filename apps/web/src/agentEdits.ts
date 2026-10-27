import { create } from "zustand";
import type { Draft, Look } from "./api";

/**
 * A draft changed from outside, by an MCP token (the server's mcpDrafts.ts DraftEdit, a "draft" live event): the fields it
 * changed with their values before and after, and the form, cast or batch when those changed. The open form shows it at
 * once (draft.ts), rings the fields with the token's name until the user edits them (RecipeForm), and says it in a toast
 * with Undo, which puts the draft back as it was before those changes.
 */
export interface DraftEdit {
  id: string;
  by: string;
  token: string;
  at: string;
  fields: Array<{ form: string; input: string; had: boolean; was?: unknown; now?: unknown; gone?: true }>;
  recipe?: { was: string; now: string };
  look?: { was: Look | null; now: Look | null };
  count?: { was: number; now: number };
  name?: { was: string | null; now: string | null };
  /** A draft just made: the lists read again, nothing to show in a form. */
  made?: true;
}

/** A field's key in the rings: its form and its input. */
export const fieldKey = (form: string, input: string) => `${form}:${input}`;

/** How many things the toast says the token changed: the fields, the form, the cast, the batch (a rename is said by the header). */
export const editCount = (e: DraftEdit) => e.fields.length + (e.recipe ? 1 : 0) + (e.look ? 1 : 0) + (e.count ? 1 : 0);

/** A form's values with one field set, or taken out (it follows the form's start again). */
function withField(forms: Draft["forms"], form: string, input: string, value: { set: true; to: unknown } | { set: false }): Draft["forms"] {
  const rest = Object.fromEntries(Object.entries(forms[form] ?? {}).filter(([k]) => k !== input));
  return { ...forms, [form]: value.set ? { ...rest, [input]: value.to } : rest };
}

/**
 * An edit laid over what the page holds of the draft. `keep`: fields the user changed since the last save, not saved yet:
 * theirs stay (their save goes after the agent's, and wins on the server as on screen), so that typing is never undone
 * under the user's fingers.
 */
export function laidOver(d: Draft, e: DraftEdit, keep: ReadonlySet<string> = new Set()): Draft {
  let forms = d.forms;
  for (const f of e.fields) {
    if (keep.has(fieldKey(f.form, f.input))) continue;
    forms = withField(forms, f.form, f.input, f.gone ? { set: false } : { set: true, to: f.now });
  }
  return {
    ...d, forms,
    ...(e.recipe && !keep.has("recipe") ? { recipe: e.recipe.now } : {}),
    ...(e.look && !keep.has("look") ? { look: e.look.now } : {}),
    ...(e.count && !keep.has("count") ? { count: e.count.now } : {}),
    ...(e.name ? { name: e.name.now } : {}),
  };
}

/** The draft put back as it was before an edit: each field it changed as it was (or taken out when it held nothing), its form, cast and batch. */
export function undone(d: Draft, e: DraftEdit): Draft {
  let forms = d.forms;
  for (const f of e.fields) forms = withField(forms, f.form, f.input, f.had ? { set: true, to: f.was } : { set: false });
  return { ...d, forms, ...(e.recipe ? { recipe: e.recipe.was } : {}), ...(e.look ? { look: e.look.was } : {}), ...(e.count ? { count: e.count.was } : {}) };
}

/**
 * The fields the user changed and has not saved yet: where what the page holds (`unsaved`) differs from the draft as last
 * saved (`saved`, the server's copy), by field key, with "recipe", "look" and "count".
 */
export function unsavedFields(unsaved: Draft | null, saved: Draft | undefined): Set<string> {
  const out = new Set<string>();
  if (!unsaved || !saved || unsaved.id !== saved.id) return out;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const form of new Set([...Object.keys(unsaved.forms), ...Object.keys(saved.forms)])) {
    const a = unsaved.forms[form] ?? {};
    const b = saved.forms[form] ?? {};
    for (const input of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[input], b[input])) out.add(fieldKey(form, input));
  }
  if (unsaved.recipe !== saved.recipe) out.add("recipe");
  if (!same(unsaved.look, saved.look)) out.add("look");
  if (unsaved.count !== saved.count) out.add("count");
  return out;
}

/**
 * The edits heard, and the rings they leave: by draft, each ringed field's key and the token's name. `seq` moves with each
 * edit heard (the open draft follows it); `last` is that edit.
 */
export const useAgentEdits = create<{
  seq: number;
  last: DraftEdit | null;
  rings: Record<string, Record<string, string>>;
  heard(e: DraftEdit): void;
  /** These fields edited by the user: their rings go. */
  clear(draft: string, keys: readonly string[]): void;
  /** An edit undone: the rings it left go. */
  forget(e: DraftEdit): void;
}>()((set) => ({
  seq: 0,
  last: null,
  rings: {},
  heard: (e) => set((s) => {
    const rings = { ...s.rings[e.id] };
    for (const f of e.fields) rings[fieldKey(f.form, f.input)] = e.by;
    return { seq: s.seq + 1, last: e, rings: e.fields.length ? { ...s.rings, [e.id]: rings } : s.rings };
  }),
  clear: (draft, keys) => set((s) => {
    const was = s.rings[draft];
    if (!was || !keys.some((k) => k in was)) return s;
    return { rings: { ...s.rings, [draft]: Object.fromEntries(Object.entries(was).filter(([k]) => !keys.includes(k))) } };
  }),
  forget: (e) => set((s) => {
    const was = s.rings[e.id];
    if (!was) return s;
    const gone = new Set(e.fields.map((f) => fieldKey(f.form, f.input)));
    return { rings: { ...s.rings, [e.id]: Object.fromEntries(Object.entries(was).filter(([k]) => !gone.has(k) || was[k] !== e.by)) } };
  }),
}));

/** The rings of one form of a draft: its input ids and who changed each. */
export function ringsOf(rings: Record<string, string> | undefined, form: string): Record<string, string> {
  if (!rings) return {};
  const prefix = `${form}:`;
  return Object.fromEntries(Object.entries(rings).flatMap(([k, by]) => (k.startsWith(prefix) ? [[k.slice(prefix.length), by]] : [])));
}
