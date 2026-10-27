import { create } from "zustand";
import type { Draft, Entity, Look } from "./api";

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
  /** When the draft was saved with it: a save of the page's answered with a later time was written over it (draft.ts saves it again). */
  saved?: string;
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft put back as it was before an edit: each field it changed as it was (or taken out when it held nothing), its
 * form, cast and batch; each only while it still holds what the edit left. One changed since (typed over, set by another
 * edit) is newer than the edit: it stays, counted in `kept`, so that Undo never writes an old value over newer work.
 */
export function undone(d: Draft, e: DraftEdit): { draft: Draft; kept: number } {
  let forms = d.forms;
  let kept = 0;
  const still = (holds: boolean) => holds || (kept++, false);
  for (const f of e.fields) {
    const form = d.forms[f.form] ?? {};
    if (!still(f.gone ? !(f.input in form) : f.input in form && same(form[f.input], f.now))) continue;
    forms = withField(forms, f.form, f.input, f.had ? { set: true, to: f.was } : { set: false });
  }
  const draft = {
    ...d, forms,
    ...(e.recipe && still(d.recipe === e.recipe.now) ? { recipe: e.recipe.was } : {}),
    ...(e.look && still(same(d.look, e.look.now)) ? { look: e.look.was } : {}),
    ...(e.count && still(d.count === e.count.now) ? { count: e.count.was } : {}),
  };
  return { draft, kept };
}

/** What an Undo that left newer changes as they were says of them, in a toast (null: it took everything back). */
export const keptSaid = (kept: number): string | null =>
  !kept ? null : kept === 1 ? "One field was changed again since: it stays as it is now." : `${kept} fields were changed again since: they stay as they are now.`;

/**
 * The fields the user changed and has not saved yet: where what the page holds (`unsaved`) differs from the draft as last
 * saved (`saved`, the server's copy), by field key, with "recipe", "look" and "count".
 */
export function unsavedFields(unsaved: Draft | null, saved: Draft | undefined): Set<string> {
  const out = new Set<string>();
  if (!unsaved || !saved || unsaved.id !== saved.id) return out;
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

/** How many of the last edits heard are kept, for a save that was out while they came (draft.ts). */
const KEPT_EDITS = 20;

/**
 * The edits heard, and the rings they leave: by draft, each ringed field's key and the token's name. `seq` moves with each
 * edit heard (the open draft follows it); `last` is that edit, `recent` the last few.
 */
export const useAgentEdits = create<{
  seq: number;
  last: DraftEdit | null;
  recent: DraftEdit[];
  rings: Record<string, Record<string, string>>;
  heard(e: DraftEdit): void;
  /** The edits heard after `seq` was read, the oldest first. */
  since(seq: number): DraftEdit[];
  /** These fields edited by the user: their rings go. */
  clear(draft: string, keys: readonly string[]): void;
  /** An edit undone: the rings it left go. */
  forget(e: DraftEdit): void;
}>()((set, get) => ({
  seq: 0,
  last: null,
  recent: [],
  rings: {},
  heard: (e) => set((s) => {
    const rings = { ...s.rings[e.id] };
    for (const f of e.fields) rings[fieldKey(f.form, f.input)] = e.by;
    return { seq: s.seq + 1, last: e, recent: [...s.recent, e].slice(-KEPT_EDITS), rings: e.fields.length ? { ...s.rings, [e.id]: rings } : s.rings };
  }),
  since: (seq) => {
    const { seq: now, recent } = get();
    return now > seq ? recent.slice(-Math.min(now - seq, recent.length)) : [];
  },
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

/**
 * An item of the Prompt kit changed from outside, by an MCP token (the server's mcpKit.ts KitEdit, a "kit" live event): the
 * parts of its def it changed with their values before and after, and its name when that changed. The kit open on it
 * shows it at once (useEntityDraft), rings those parts with the token's name until the user edits them, and says it in a
 * toast with Undo, as a draft's edit does.
 */
export interface KitEdit {
  id: string;
  kind: Entity["kind"];
  by: string;
  token: string;
  at: string;
  fields: Array<{ key: string; had: boolean; was?: unknown; now: unknown }>;
  name?: { was: string; now: string };
  /** An item just made: the lists read again, nothing to show. */
  made?: true;
  /** When the item was saved with it: a save of the page's answered with a later time was written over it (saved again). */
  saved?: string;
}

/** How many things the toast says the token changed: the parts and the name. */
export const kitEditCount = (e: KitEdit) => e.fields.length + (e.name ? 1 : 0);

const defOf = (e: Entity) => e.def as unknown as Record<string, unknown>;
const withDef = (e: Entity, def: Record<string, unknown>, name = e.name): Entity => ({ ...e, name, def }) as unknown as Entity;

/** A kit edit laid over what the page holds of the item. `keep`: the parts (and "name") the user changed and has not saved yet: theirs stay. */
export function kitLaidOver(e: Entity, edit: KitEdit, keep: ReadonlySet<string> = new Set()): Entity {
  const def = { ...defOf(e) };
  for (const f of edit.fields) if (!keep.has(f.key)) def[f.key] = f.now;
  return withDef(e, def, edit.name && !keep.has("name") ? edit.name.now : e.name);
}

/**
 * The item put back as it was before an edit: each part it changed as it was (taken out when it held nothing), its name;
 * each only while it still holds what the edit left. One changed since is newer: it stays, counted in `kept`.
 */
export function kitUndone(e: Entity, edit: KitEdit): { item: Entity; kept: number } {
  const def = { ...defOf(e) };
  let kept = 0;
  for (const f of edit.fields) {
    if (!same(def[f.key], f.now)) kept++;
    else if (f.had) def[f.key] = f.was;
    else delete def[f.key];
  }
  const back = edit.name && e.name === edit.name.now;
  if (edit.name && !back) kept++;
  return { item: withDef(e, def, back ? edit.name!.was : e.name), kept };
}

/** The parts (and "name") where what the page holds of an item differs from the item as last saved. */
export function kitUnsaved(unsaved: Entity | null | undefined, saved: Entity | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!unsaved || !saved || unsaved.id !== saved.id) return out;
  const a = defOf(unsaved);
  const b = defOf(saved);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.add(k);
  if (unsaved.name !== saved.name) out.add("name");
  return out;
}

/** The kit edits heard and the rings they leave: by item, each ringed part (or "name") and the token's name. `seq` moves with each edit heard. */
export const useKitEdits = create<{
  seq: number;
  last: KitEdit | null;
  rings: Record<string, Record<string, string>>;
  heard(e: KitEdit): void;
  /** These parts edited by the user: their rings go. */
  clear(item: string, keys: readonly string[]): void;
  /** An edit undone: the rings it left go. */
  forget(e: KitEdit): void;
}>()((set) => ({
  seq: 0,
  last: null,
  rings: {},
  heard: (e) => set((s) => {
    const rings = { ...s.rings[e.id] };
    for (const f of e.fields) rings[f.key] = e.by;
    if (e.name) rings.name = e.by;
    return { seq: s.seq + 1, last: e, rings: kitEditCount(e) ? { ...s.rings, [e.id]: rings } : s.rings };
  }),
  clear: (item, keys) => set((s) => {
    const was = s.rings[item];
    if (!was || !keys.some((k) => k in was)) return s;
    return { rings: { ...s.rings, [item]: Object.fromEntries(Object.entries(was).filter(([k]) => !keys.includes(k))) } };
  }),
  forget: (e) => set((s) => {
    const was = s.rings[e.id];
    if (!was) return s;
    const gone = new Set([...e.fields.map((f) => f.key), ...(e.name ? ["name"] : [])]);
    return { rings: { ...s.rings, [e.id]: Object.fromEntries(Object.entries(was).filter(([k]) => !gone.has(k) || was[k] !== e.by)) } };
  }),
}));

/** Who changed one of these parts of a kit item and left its ring (the first ringed), for a card that shows them together. */
export const ringBy = (rings: Readonly<Record<string, string>> | undefined, ...keys: string[]): string | undefined => keys.map((k) => rings?.[k]).find(Boolean);

/**
 * A timeline changed from outside, by an MCP token (the server's mcpTimelines.ts TimelineEdit, a "timelineEdit" live event):
 * what it did in a few words, the clips it touched, and the steps it kept. The editor open on it reads the timeline again
 * as on any change ("timeline"), lays the forms it changed over what is typed there, says it in a toast whose Undo takes
 * those steps back (refused once the timeline changed after them), and rings the clips until the user selects them.
 */
export interface TimelineEdit {
  id: string;
  by: string;
  token: string;
  at: string;
  said: string;
  clips: string[];
  /** The last of `steps`. */
  step: string | null;
  /** The steps of the timeline's Undo it kept, in the order they were made: the toast's Undo takes them all back. */
  steps?: string[];
  /** The forms of the clips it changed, before and after: laid over what the editor holds typed over them (useClipEdits). */
  inputs?: Record<string, { was: Record<string, unknown>; now: Record<string, unknown> }>;
  /** Sent before the change is made: a token is changing the timeline now (nothing to say yet; the zoom is left alone). */
  going?: true;
}

/** How long after a token's change was heard the clips it adds are taken for its own (useTrackZoom leaves the zoom then). */
export const AGENT_MS = 15_000;

/**
 * The timeline edits heard and the rings they leave: by timeline, each ringed clip and the token's name. `seq` moves with
 * each edit heard; `going`, by timeline, when a token was last heard changing it.
 */
export const useTimelineEdits = create<{
  seq: number;
  last: TimelineEdit | null;
  rings: Record<string, Record<string, string>>;
  going: Record<string, number>;
  heard(e: TimelineEdit): void;
  /** These clips touched by the user (selected): their rings go. */
  clear(timeline: string, clips: readonly string[]): void;
  /** An edit undone: the rings it left go. */
  forget(e: TimelineEdit): void;
}>()((set) => ({
  seq: 0,
  last: null,
  rings: {},
  going: {},
  heard: (e) => set((s) => {
    const going = { ...s.going, [e.id]: Date.now() };
    if (e.going) return { going };
    return { seq: s.seq + 1, last: e, going, rings: e.clips.length ? { ...s.rings, [e.id]: { ...s.rings[e.id], ...Object.fromEntries(e.clips.map((c) => [c, e.by])) } } : s.rings };
  }),
  clear: (timeline, clips) => set((s) => {
    const was = s.rings[timeline];
    if (!was || !clips.some((c) => c in was)) return s;
    return { rings: { ...s.rings, [timeline]: Object.fromEntries(Object.entries(was).filter(([c]) => !clips.includes(c))) } };
  }),
  forget: (e) => set((s) => {
    const was = s.rings[e.id];
    if (!was) return s;
    return { rings: { ...s.rings, [e.id]: Object.fromEntries(Object.entries(was).filter(([c, by]) => !e.clips.includes(c) || by !== e.by)) } };
  }),
}));
