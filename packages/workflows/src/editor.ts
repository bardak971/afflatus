import { z } from "zod";
import { isRef, takesAnyInput, type Graph, type GraphNode, type NodeCatalog, type NodeInfo, type Ref } from "@afflatus/core";
import { defaultOf, dynamicFields, hasKind, infoOf, isWidget, isWidgetType, optsOf, typeOf, UNSAFE_KEYS } from "./catalog";
import { splitCaptions, type Mode, type Target, type Toggle, type Wiring } from "./types";
import { modesFor } from "./wiring";

/**
 * Reads the file ComfyUI's editor saves (the one in its workflows folder) and turns it into what
 * Afflatus works with: every node with its typed-in values and links, in the flat form ComfyUI runs,
 * plus what only that file knows. Which nodes are switched off, the switches that turn parts on and
 * off, the names the author gave to settings, and the author's own control panel.
 *
 * ComfyUI has no service for this: its browser front end does the conversion when it queues or
 * exports. This follows that code (graphToPrompt, front end 1.53) for what it covers: group nodes
 * (subgraphs) are opened up, reroutes and other editor-only nodes are followed through, values are
 * matched to inputs by the node catalog. What it cannot read is said in `notes`, never guessed.
 *
 * The file is someone else's: its shape is checked first, what it names is never used as a key that
 * reaches an object's prototype, its texts are cut to a sane length, and its group nodes are opened
 * only so deep and so many.
 */
export interface EditorFindings {
  /** Every real node, switched off or not. Ids inside a group node are "<group node>:<node>". */
  graph: Graph;
  wiring: Wiring;
  /** Node to the title of the box it sits in. */
  groups: Record<string, string>;
  /** What could not be read as ComfyUI would, written for the person importing. */
  notes: string[];
}

/** A file that cannot be read at all, said in plain words: the server answers it as the request's fault, not its own. */
export class UnreadableWorkflow extends Error {}

/** Titles, labels and names are cut to this; the text of a note to NOTE_TEXT. */
const TEXT = 200;
const NOTE_TEXT = 10_000;
/** How deep group nodes are opened, and how many nodes opening them may make in all. */
export const MAX_DEPTH = 8;
export const MAX_OPENED = 20_000;
/** The links read from the author's notes. */
const MAX_LINKS = 80;

const clamp = (max: number) => (s: string) => (s.length > max ? s.slice(0, max) : s);
/** A text the file may carry or not: cut to `max`, and dropped when it is not a text. */
const text = (max = TEXT) => z.string().transform(clamp(max)).optional().catch(undefined);
/** A name used as a key: never one that reaches an object's prototype. */
const key = z.string().refine((s) => !UNSAFE_KEYS.has(s), { message: "is a name Afflatus does not take" });
const nodeId = z.union([z.number(), key]);
const eSocket = z.looseObject({
  name: key,
  type: z.unknown().optional(),
  link: z.number().nullable().optional().catch(null),
  widget: z.looseObject({ name: key.optional() }).nullable().optional().catch(undefined),
  label: text(),
});
const eNode = z.looseObject({
  id: nodeId,
  type: z.string(),
  title: text(),
  mode: z.number().optional().catch(undefined),
  pos: z.unknown().optional(),
  inputs: z.array(eSocket).nullable().optional().transform((x) => x ?? undefined),
  outputs: z.array(z.looseObject({ type: z.unknown().optional(), links: z.array(z.number()).nullable().optional().catch(null) })).nullable().optional().transform((x) => x ?? undefined),
  widgets_values: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional().catch(undefined),
});
const eGroup = z.looseObject({ title: text(), bounding: z.array(z.number()).optional().catch(undefined) });
const ueLink = z.looseObject({ upstream: nodeId.optional(), upstream_slot: z.number().optional(), downstream: nodeId.optional(), downstream_slot: z.number().optional() });
const eGraph = {
  nodes: z.array(eNode).optional(),
  links: z.array(z.unknown()).nullable().optional().transform((x) => x ?? undefined),
  groups: z.array(eGroup).optional().catch(undefined),
  extra: z.looseObject({ ue_links: z.array(ueLink).optional().catch(undefined) }).nullable().optional().catch(undefined),
};
const edge = z.looseObject({ name: key.optional().catch(undefined), type: z.unknown().optional(), linkIds: z.array(z.number()).optional().catch(undefined) });
const eSubgraph = z.looseObject({
  ...eGraph,
  id: z.string(),
  name: text(),
  inputNode: z.looseObject({ id: z.number() }).optional().catch(undefined),
  outputNode: z.looseObject({ id: z.number() }).optional().catch(undefined),
  inputs: z.array(edge).optional().catch(undefined),
  outputs: z.array(edge).optional().catch(undefined),
});
/** The editor's file, as loosely as it can be taken: what this reader relies on is checked, the rest passes as it is. */
export const editorFile = z.looseObject({ ...eGraph, nodes: z.array(eNode), definitions: z.looseObject({ subgraphs: z.array(eSubgraph).optional() }).optional().catch(undefined) });

type ESocket = z.infer<typeof eSocket>;
type ENode = z.infer<typeof eNode>;
interface ELink { id: number; origin_id: number | string; origin_slot: number; target_id: number | string; target_slot: number }
type ESubgraph = z.infer<typeof eSubgraph>;
type Group = z.infer<typeof eGroup>;
interface EGraph { nodes?: ENode[]; links?: unknown[]; groups?: Group[]; extra?: { ue_links?: Array<z.infer<typeof ueLink>> } | null }

/** The editor's save has a list of nodes with positions and a list of links; an exported workflow has nodes by id. */
export function isEditorFormat(json: unknown): boolean {
  const raw = json as { nodes?: unknown; links?: unknown } | null;
  return Boolean(raw && typeof raw === "object" && Array.isArray(raw.nodes) && "links" in raw);
}

const SWITCH = "DaSiWa_NodeStatusSwitch";
const POWER_LORAS = "Power Lora Loader (rgthree)";
const POWER_PRIMITIVE = "Power Primitive (rgthree)";
const NOTES = new Set(["Note", "MarkdownNote"]);
/** Nodes that only pass on what comes into their one input. */
const REROUTES = new Set(["Reroute", "Reroute (rgthree)"]);
const SETTERS = new Set(["SetNode", "easy setNode"]);
const GETTERS = new Set(["GetNode", "easy getNode"]);
/** Nodes that exist only in the editor and stand for a link or a value. */
const VIRTUAL = new Set([...REROUTES, ...SETTERS, ...GETTERS, "PrimitiveNode"]);
/** A switch that picks one of two inputs by a yes/no typed on it (Crystools): read as a link to the one picked. */
const CRYSTOOLS_SWITCH = /^Switch .*\[Crystools\]$/;
/** What the editor stores after a number that can change between runs. */
const AFTER_RUN = new Set(["fixed", "increment", "decrement", "randomize"]);

const modeOf = (node: ENode): Mode | undefined => (node.mode === 2 ? "mute" : node.mode === 4 ? "bypass" : undefined);
const typeName = (type: unknown) => (typeof type === "string" ? type : Array.isArray(type) ? "COMBO" : "*");
const parseLink = (raw: unknown): ELink | null => {
  if (Array.isArray(raw)) return typeof raw[0] === "number" ? { id: raw[0], origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4] } : null;
  return raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "number" ? (raw as ELink) : null;
};
const fits = (type: string, value: unknown) =>
  type === "INT" || type === "FLOAT" ? typeof value === "number"
  : type === "STRING" ? typeof value === "string"
  : type === "BOOLEAN" ? typeof value === "boolean"
  : type === "COMBO" ? ["string", "number", "boolean"].includes(typeof value)
  : true;
/** As `fits`, with a choice taking a name only: for telling whether values read by their place landed on the right fields. */
const fitsExactly = (type: string, value: unknown) => (type === "COMBO" ? typeof value === "string" : fits(type, value));
/** A text without the run of `chars` at its end (a loop, not a regex: a long run in the middle would make one backtrack). */
const trimEnd = (s: string, chars: string) => {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
};
/** A record that takes any key the file names as its own, never as its prototype's. */
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
/** The values after a number that only say what the editor does with it after a run ("randomize"; null after a linked seed). */
const afterRunCount = (saved: unknown[]) => saved.filter((v, i) => ((typeof v === "string" && AFTER_RUN.has(v)) || v === null) && typeof saved[i - 1] === "number").length;

/**
 * The typed-in values of a node, by input name. The file stores them as a bare list in the order the
 * editor shows them, so the names come from the node itself (newer files list them) or from the catalog.
 */
function literalsOf(node: ENode, info: NodeInfo | undefined, note: (text: string) => void): Record<string, unknown> {
  const saved = node.widgets_values;
  const all: Record<string, unknown> = Object.assign(record(), info?.input.required, info?.input.optional);
  // "group.member" is a setting that belongs to a choice of the node
  const known = (name: string) => !info || name in all || (name.includes(".") && name.split(".")[0]! in all) || takesAnyInput(node.type);
  const title = node.title ?? info?.display_name ?? node.type;

  if (node.type === POWER_LORAS) {
    // its list is one entry per LoRA, which it takes as inputs named lora_1, lora_2, …
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const v of Array.isArray(saved) ? saved : []) if (v && typeof v === "object" && "lora" in v) out[`lora_${++n}`] = v;
    return out;
  }
  if (node.type === POWER_PRIMITIVE && Array.isArray(saved)) {
    // rgthree's primitive saves its type and its value, and reads them by those names
    return { type: saved[0], value: saved[1] };
  }
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    // saved by name (VideoHelperSuite). Plain values only: previews and the like are the editor's own
    return Object.fromEntries(Object.entries(saved).filter(([name, v]) => !UNSAFE_KEYS.has(name) && known(name) && v !== null && typeof v !== "object"));
  }
  if (!Array.isArray(saved)) return {};

  const fromFile = (node.inputs ?? []).flatMap((s) => (s.widget?.name ? [s.widget.name] : []));
  // a kind this ComfyUI lacks, saved with more values than the file names fields for: the fields it does not name
  // are somewhere among the values. Read by their place only when every value then fits its field's type
  // (a trailing value of the editor's own, a preview, is the usual surplus); otherwise their places cannot be told
  const surplus = !info && fromFile.length > 0 && saved.length - afterRunCount(saved) > fromFile.length;
  // a field the file shows as one keeps its place, even when this ComfyUI's kind only takes it by a link
  const fromCatalog = Object.entries(all).filter(([name, spec]) => isWidget(spec) || fromFile.includes(name)).map(([name]) => name);
  // the editor adds a "what to do after a run" field after a seed, and after any number that asks for one
  const changes = (name: string) => Boolean(optsOf(all[name]).control_after_generate) || (/^(noise_)?seed$/.test(name) && typeOf(all[name]) === "INT");
  // newer files list every field; older ones (and trimmed ones) only the linked fields
  const complete = fromFile.length > 0 && fromFile.length + fromFile.filter(changes).length >= saved.length;
  let names = complete || !fromCatalog.length ? fromFile : fromCatalog;
  // a kind this ComfyUI lacks that lists its values without naming them (a literal of a small pack): named by their place
  if (!info && !names.length && saved.length) names = saved.map((_, i) => (saved.length === 1 ? "value" : `value_${i}`));

  const out: Record<string, unknown> = {};
  const gone: string[] = [];
  let i = 0;
  /** The fields a dynamic choice brings take the values after it, then theirs (unless the file names them itself). */
  const nested = (name: string, spec: unknown, picked: unknown) => {
    if (names.some((n) => n.startsWith(`${name}.`))) return;
    for (const [sub, subSpec] of dynamicFields(spec, picked)) {
      const key = `${name}.${sub}`;
      const value = i < saved.length ? saved[i++] : defaultOf(subSpec);
      if (value !== null && value !== undefined) out[key] = value;
      nested(key, subSpec, out[key]);
    }
  };
  for (const name of names) {
    if (i >= saved.length) break;
    const value = saved[i++];
    if (known(name)) {
      if (value !== null && value !== undefined) out[name] = value;
      nested(name, all[name], value);
    } else if (name !== "upload") gone.push(name);
    const next = saved[i];
    if (typeof next === "string" && AFTER_RUN.has(next) && (info ? changes(name) : typeof value === "number")) i++;
    // a seed fed by a link keeps its slot and its "after a run" slot, the latter saved as null
    else if (next === null && (info ? changes(name) : /^(noise_)?seed$/.test(name) && typeof value === "number")) i++;
    else if (names === fromCatalog && optsOf(all[name]).image_upload && next === "image") i++;
  }
  if (surplus) {
    const typeIn = (name: string) => typeName(node.inputs?.find((s) => s.widget?.name === name)?.type);
    if (!Object.entries(out).every(([name, v]) => fitsExactly(typeIn(name), v))) {
      note(`"${title}" is from a node pack this ComfyUI does not have, and holds ${saved.length} values for the ${fromFile.length} fields its file names: its settings are read once its pack is installed.`);
      return {};
    }
    // read, but by place alone: said, so that they are looked at once the pack is in
    note(`The values of "${title}" were read by position because its pack is missing: check them once the pack is installed.`);
  }
  // a field the node gained after the workflow was saved starts at its default, as in the editor
  for (const name of fromCatalog) {
    const preset = defaultOf(all[name]);
    if (!(name in out) && preset !== undefined && preset !== null) {
      out[name] = preset;
      nested(name, all[name], preset);
    }
  }
  // fields the catalog does not know are the editor's own (an upload button, a player) unless the node also
  // has fields the file does not know: then the node itself is not the one the workflow was saved with
  if (gone.length && fromCatalog.some((name) => !fromFile.includes(name))) note(`"${title}" was saved with settings its installed version does not have (${gone.join(", ")}): the node has changed since this workflow was made.`);
  const odd = Object.entries(out).find(([name, value]) => name in all && !fits(typeOf(all[name]), value));
  if (odd) note(`"${title}": its settings may have been read wrong ("${odd[0]}" got ${JSON.stringify(odd[1])}). Check them in the list of settings.`);
  return out;
}

interface Scope {
  /** The group nodes this level is inside of. */
  path: string[];
  /** The group node definitions this level is inside of: one already among them would open itself for ever. */
  defs: string[];
  nodes: Map<string, ENode>;
  links: Map<number, ELink>;
  groups: Group[];
  /** Inside a group node: the node that stands for it one level up. */
  host?: { scope: Scope; node: ENode; def: ESubgraph };
  /** Off because a group node around it is off. */
  off?: Mode;
}
/** A setting shown on the front of a group node: one field there, read by one or more inputs inside. */
interface Promoted { key: string; label?: string }
type Origin = { ref: Ref } | { literal: unknown; promoted?: Promoted } | undefined;

/** A newer editor lists what the front of a group node shows in `proxyWidgets`, one entry per value saved. */
function proxyOf(host: ENode): unknown[][] | null {
  const saved = host.widgets_values;
  const proxy = host.properties?.proxyWidgets;
  return Array.isArray(saved) && Array.isArray(proxy) && proxy.length === saved.length && proxy.every((e) => Array.isArray(e) && e.length >= 2) ? (proxy as unknown[][]) : null;
}

/**
 * The fields on the front of a group node, in the order the file lists their values: the group's own inputs,
 * in the group's order, that a widget inside reads (an input nothing inside reads counts when it is of a
 * widget's type). The node that stands for the group lists its sockets in another order, and only some.
 */
function frontFields(scope: Scope): string[] {
  const def = scope.host?.def;
  if (!def) return [];
  // the socket a link arrives at is the one that names the link (its target_slot is not always that socket's place)
  const socketOf = (l: ELink) => {
    const inputs = scope.nodes.get(String(l.target_id))?.inputs;
    const at = inputs?.[l.target_slot];
    return inputs?.find((s) => s.link === l.id) ?? (at?.link == null ? at : undefined);
  };
  return (def.inputs ?? []).flatMap((i) => {
    const targets = (i.linkIds ?? []).map((l) => scope.links.get(l)).filter((l): l is ELink => Boolean(l));
    const field = targets.length ? targets.some((l) => socketOf(l)?.widget?.name) : isWidgetType(typeName(i.type));
    return field ? [i.name ?? ""] : [];
  });
}
/** Field name → the value typed on the front of the group node this scope is inside of. */
function frontValues(scope: Scope): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const host = scope.host?.node;
  const saved = host?.widgets_values;
  if (!host || !saved) return out;
  const fields = frontFields(scope);
  if (!Array.isArray(saved)) {
    for (const f of fields) if (typeof saved === "object" && Object.hasOwn(saved, f)) out.set(f, (saved as Record<string, unknown>)[f]);
    return out;
  }
  // ["-1", input] is a field of the group's own, [node, widget] a widget of a node inside shown on the front (it keeps its own value)
  const proxy = proxyOf(host);
  if (proxy) {
    proxy.forEach((e, i) => { if (String(e[0]) === "-1") out.set(String(e[1]), saved[i]); });
    return out;
  }
  // after a number the editor may store what to do with it after a run ("randomize"): not a field
  let k = 0;
  for (const f of fields) {
    if (k >= saved.length) break;
    const value = saved[k++];
    out.set(f, value);
    if (typeof value === "number" && typeof saved[k] === "string" && AFTER_RUN.has(saved[k] as string)) k++;
  }
  return out;
}

/** The node a link comes from one level up, when it comes in at the edge of a group node: the socket on the node that stands for it. */
function edgeOf(scope: Scope, link: ELink | undefined) {
  if (!scope.host || !link || String(link.origin_id) !== String(scope.host.def.inputNode?.id)) return null;
  const { node: host, scope: outer, def } = scope.host;
  // the slot is the group's own input; the node that stands for the group lists its sockets in its own order
  // (a field the node has no socket for is read by its name alone; another socket must not stand in for it)
  const name = def.inputs?.[link.origin_slot]?.name;
  const socket = name !== undefined ? host.inputs?.find((s) => s.name === name) : host.inputs?.[link.origin_slot];
  return { host, outer, socket, key: name ?? socket?.name };
}

/** What every step of the reading shares. */
interface Reading {
  catalog: NodeCatalog;
  defs: Map<string, ESubgraph>;
  notes: string[];
  note(text: string): void;
  /** Group nodes opened, by the flat id of the node that stands for them. */
  opened: Map<string, Scope>;
  /** How many nodes opening them has made. */
  openedNodes: number;
  /** "Set" nodes by their name, per level. */
  setters: Map<Scope, Map<unknown, ENode>>;
  graph: Graph;
  wiring: Wiring;
  labels: Record<string, string>;
  groups: Record<string, string>;
  panel: Target[];
  switches: Array<{ scope: Scope; node: ENode }>;
  /** Field on the front of a group node → the inputs inside that read it, in the order they were met. */
  promoted: Map<string, Target[]>;
  frames: Wiring["frames"];
  frameIds: Map<Group, number>;
}

const flatId = (scope: Scope, node: ENode) => [...scope.path, String(node.id)].join(":");

// ---- the levels: the file itself, and what is inside each group node

function scopeOf(g: EGraph, path: string[], defs: string[], host?: Scope["host"], off?: Mode): Scope {
  const nodes = new Map((g.nodes ?? []).map((n) => [String(n.id), n]));
  const links = new Map((g.links ?? []).flatMap((raw) => { const l = parseLink(raw); return l ? [[l.id, l] as const] : []; }));
  // links the "Anything Everywhere" pack makes without drawing them: the file says what they resolved to, and the
  // socket they lead to has no link of its own. They get ids of their own, below every id the file uses.
  let next = -1000;
  for (const ue of g.extra?.ue_links ?? []) {
    if (ue.upstream === undefined || ue.downstream === undefined || typeof ue.upstream_slot !== "number" || typeof ue.downstream_slot !== "number") continue;
    const socket = nodes.get(String(ue.downstream))?.inputs?.[ue.downstream_slot];
    if (!socket || socket.link != null || !nodes.has(String(ue.upstream))) continue;
    const id = next--;
    links.set(id, { id, origin_id: ue.upstream, origin_slot: ue.upstream_slot, target_id: ue.downstream, target_slot: ue.downstream_slot });
    socket.link = id;
  }
  return { path, defs, host, off, nodes, links, groups: g.groups ?? [] };
}

/** What is inside a group node, when the node is one. Each use of a definition is opened on a copy of its own. */
function inside(r: Reading, scope: Scope, node: ENode): Scope | undefined {
  const def = r.defs.get(node.type);
  if (!def) return undefined;
  const id = flatId(scope, node);
  const known = r.opened.get(id);
  if (known) return known;
  const name = node.title ?? def.name ?? "A group node";
  if (scope.defs.includes(def.id)) throw new UnreadableWorkflow(`The group node "${name}" holds itself: this file cannot be opened.`);
  if (scope.path.length >= MAX_DEPTH) throw new UnreadableWorkflow(`This file has group nodes inside group nodes more than ${MAX_DEPTH} deep ("${name}"): Afflatus opens ${MAX_DEPTH} levels.`);
  r.openedNodes += def.nodes?.length ?? 0;
  if (r.openedNodes > MAX_OPENED) throw new UnreadableWorkflow(`Opening this file's group nodes makes more than ${MAX_OPENED} nodes: it is too large to read.`);
  const own = structuredClone(def);
  const opened = scopeOf(own, [...scope.path, String(node.id)], [...scope.defs, def.id], { scope, node, def: own }, scope.off ?? (modeOf(node) ? "mute" : undefined));
  r.opened.set(id, opened);
  return opened;
}

/** Every group node, opened before anything is read: a "Get" node can read a "Set" node at any level. */
function openScopes(r: Reading, scope: Scope): void {
  for (const node of scope.nodes.values()) {
    const within = inside(r, scope, node);
    if (within) openScopes(r, within);
  }
}

// ---- where a link really comes from

const linked = (node: ENode) => (node.inputs ?? []).some((s) => s.link != null) || (node.outputs ?? []).some((o) => o.links?.length);
function kindOf(r: Reading, node: ENode): "real" | "switch" | "skip" {
  if (node.type === SWITCH) return "switch";
  if (NOTES.has(node.type) || VIRTUAL.has(node.type)) return "skip";
  // a Crystools switch with its yes/no typed on it is read as a link (fromOutput): the node itself is not sent
  if (CRYSTOOLS_SWITCH.test(node.type) && typeof (Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined) === "boolean" && (node.inputs ?? []).find((i) => i.name === "boolean")?.link == null) return "skip";
  // labels, bookmarks and other things an extension draws on the canvas: unknown to ComfyUI and wired to nothing
  return hasKind(r.catalog, node.type) || linked(node) ? "real" : "skip";
}

/** The "Set" node of a name: at its own level first, then the levels around it, then inside any group node. */
function setterOf(r: Reading, scope: Scope, name: unknown): { scope: Scope; node: ENode } | undefined {
  const at = (s: Scope) => {
    let byName = r.setters.get(s);
    if (!byName) {
      byName = new Map();
      for (const n of s.nodes.values()) if (SETTERS.has(n.type) && Array.isArray(n.widgets_values) && !byName.has(n.widgets_values[0])) byName.set(n.widgets_values[0], n);
      r.setters.set(s, byName);
    }
    const node = byName.get(name);
    return node ? { scope: s, node } : undefined;
  };
  for (let s: Scope | undefined = scope; s; s = s.host?.scope) {
    const found = at(s);
    if (found) return found;
  }
  for (const s of r.opened.values()) {
    const found = at(s);
    if (found) return found;
  }
  return undefined;
}

/** Where a link really comes from: a real node's output, or a value held by an editor-only node. */
function fromLink(r: Reading, scope: Scope, linkId: number | null | undefined, seen: Set<string>): Origin {
  const link = linkId == null ? undefined : scope.links.get(linkId);
  if (!link) return undefined;
  // from the edge of a group node: what is plugged into that socket one level up
  const edge = edgeOf(scope, link);
  if (edge) {
    if (edge.socket?.link != null) return fromLink(r, edge.outer, edge.socket.link, seen);
    // nothing plugged in: the value typed on the front of the group node, when it has a field there
    const value = edge.key === undefined ? undefined : frontValues(scope).get(edge.key);
    return value === undefined ? undefined : { literal: value, promoted: { key: `${flatId(edge.outer, edge.host)}.${edge.key}`, label: edge.socket?.label } };
  }
  return fromOutput(r, scope, String(link.origin_id), link.origin_slot, seen);
}
function fromOutput(r: Reading, scope: Scope, id: string, slot: number, seen: Set<string>): Origin {
  const node = scope.nodes.get(id);
  const key = `${[...scope.path, id].join(":")}:${slot}`;
  if (!node || seen.has(key)) return undefined;
  seen.add(key);
  const within = inside(r, scope, node);
  if (within) {
    const def = within.host!.def;
    // a group node bypassed as a whole hands each output the input of its type (the same index first), as ComfyUI does
    if (modeOf(node) === "bypass") {
      const outType = typeName(def.outputs?.[slot]?.type);
      const ins = def.inputs ?? [];
      const at = typeName(ins[slot]?.type) === outType ? slot : ins.findIndex((i) => typeName(i.type) === outType);
      const name = at >= 0 ? ins[at]?.name : undefined;
      const socket = name !== undefined ? node.inputs?.find((s) => s.name === name) : undefined;
      if (socket?.link != null) return fromLink(r, scope, socket.link, seen);
      const value = name !== undefined ? frontValues(within).get(name) : undefined;
      return value === undefined ? undefined : { literal: value };
    }
    // the group node says which link feeds each of its outputs; a file can also hold links left over from deleted nodes
    const edge = String(def.outputNode?.id);
    const listed = (def.outputs?.[slot]?.linkIds ?? []).map((l) => within.links.get(l)).find((l) => (l && within.nodes.has(String(l.origin_id))) || String(l?.origin_id) === String(def.inputNode?.id));
    const link = listed ?? [...within.links.values()].find((l) => String(l.target_id) === edge && l.target_slot === slot && within.nodes.has(String(l.origin_id)));
    return fromLink(r, within, link?.id, seen);
  }
  if (REROUTES.has(node.type) || SETTERS.has(node.type)) return fromLink(r, scope, node.inputs?.[0]?.link, seen);
  const first = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
  if (node.type === "PrimitiveNode") return { literal: first };
  if (GETTERS.has(node.type)) {
    // reads what a "Set" node of the same name was given, wherever it is
    const setter = setterOf(r, scope, first);
    if (!setter) {
      r.note(`The "Get" node "${node.title ?? String(first)}" reads "${String(first)}", which no "Set" node of this file sets: what it would hand on is left out.`);
      return undefined;
    }
    return fromLink(r, setter.scope, setter.node.inputs?.[0]?.link, seen);
  }
  if (CRYSTOOLS_SWITCH.test(node.type)) {
    // the yes/no typed on it says which input it hands on; one wired from elsewhere cannot be read here
    const yes = (node.inputs ?? []).find((s) => s.name === "boolean");
    const typed = typeof first === "boolean" && yes?.link == null;
    if (typed) return fromLink(r, scope, (node.inputs ?? []).find((s) => s.name === (first ? "on_true" : "on_false"))?.link, seen);
  }
  return kindOf(r, node) === "real" ? { ref: [flatId(scope, node), slot] } : undefined;
}

// ---- what a node says about where it and its files come from, and the links written in notes

function readSources(r: Reading, node: ENode): void {
  const { wiring } = r;
  // only an id of ComfyUI's registry: anything else (a repository's address) is not the file's to choose
  const pack = node.properties?.cnr_id;
  if (typeof pack === "string" && /^[\w-]{1,100}$/.test(pack) && pack !== "comfy-core") wiring.packs[node.type] = pack;
  const models = node.properties?.models;
  for (const m of (Array.isArray(models) ? models : []) as Array<{ name?: unknown; url?: unknown } | null>) {
    if (typeof m?.name === "string" && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) wiring.downloads[m.name] = m.url;
  }
  if (!NOTES.has(node.type) || !Array.isArray(node.widgets_values) || wiring.links.length >= MAX_LINKS) return;
  const text = clamp(NOTE_TEXT)(String(node.widgets_values[0] ?? ""));
  const add = (label: string, url: string) => {
    if (wiring.links.length < MAX_LINKS && !wiring.links.some((l) => l.url === url)) wiring.links.push({ label: clamp(TEXT)(label.trim() || url.replace(/^https?:\/\//, "")), url });
  };
  for (const [, label, url] of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (wiring.links.length >= MAX_LINKS) return;
    add(label!, url!);
  }
  // bare addresses, as people paste them: what the line says before it, else the last line above with no address, is what it is for
  let above = "";
  for (const line of text.split(/\r?\n/)) {
    let any = false;
    for (const m of line.matchAll(/(?<!\()https?:\/\/[^\s)<>\]]+/g)) {
      if (wiring.links.length >= MAX_LINKS) return;
      any = true;
      const url = trimEnd(m[0], ".,;:!?");
      const before = trimEnd(line.slice(0, m.index), "-–:•* \t").trim();
      add(before || above, url);
    }
    if (!any && line.trim()) above = line.trim();
  }
}

// ---- the boxes the author drew: frames

const boxOf = (g: Group): [number, number, number, number] => [0, 1, 2, 3].map((i) => Number(g.bounding?.[i] ?? 0)) as [number, number, number, number];
const area = (g: Group) => boxOf(g)[2] * boxOf(g)[3];
const holds = (a: number[], b: number[]) => a[0]! <= b[0]! && a[1]! <= b[1]! && a[0]! + a[2]! >= b[0]! + b[2]! && a[1]! + a[3]! >= b[1]! + b[3]!;
/** The innermost box drawn around a node. */
function innermostAt(scope: Scope, node: ENode): Group | undefined {
  const pos = node.pos as Record<number, number> | undefined;
  if (!pos || typeof pos[0] !== "number" || typeof pos[1] !== "number") return undefined;
  const around = scope.groups.filter((g) => {
    const [x, y, w, h] = boxOf(g);
    return g.title && g.bounding && pos[0]! >= x && pos[0]! <= x + w && pos[1]! >= y && pos[1]! <= y + h;
  });
  return around.sort((a, b) => area(a) - area(b))[0];
}
const groupOf = (scope: Scope, node: ENode): string | undefined => innermostAt(scope, node)?.title;
/** The frame a node is in: its own, else the one around the group node it sits inside (and so on up). */
function frameOf(scope: Scope, node: ENode): { scope: Scope; group: Group } | undefined {
  for (let s: Scope | undefined = scope, n: ENode | undefined = node; s && n; n = s.host?.node, s = s.host?.scope) {
    const group = innermostAt(s, n);
    if (group) return { scope: s, group };
  }
  return undefined;
}
/** Each box drawn, as a frame: one per box (two boxes of the same title are two frames), with the box it is drawn inside. */
function frameFor(r: Reading, scope: Scope, g: Group): number {
  const known = r.frameIds.get(g);
  if (known !== undefined) return known;
  const box = boxOf(g);
  // drawn strictly inside: a box never holds one that holds it, so this does not loop
  const around = scope.groups
    .filter((o) => o !== g && o.title && o.bounding && holds(boxOf(o), box) && !holds(box, boxOf(o)))
    .sort((a, b) => area(a) - area(b))[0];
  const parent = around ? frameFor(r, scope, around) : undefined;
  const i = r.frames.length;
  r.frames.push({ title: g.title!, nodes: [], box, ...(parent !== undefined ? { parent } : {}) });
  r.frameIds.set(g, i);
  return i;
}

// ---- every node, level by level

function visitNodes(r: Reading, scope: Scope): void {
  const { graph, wiring, labels } = r;
  for (const node of scope.nodes.values()) {
    readSources(r, node);
    // what the author wrote in a note inside a frame: what that part is for
    if (NOTES.has(node.type) && Array.isArray(node.widgets_values)) {
      const at = frameOf(scope, node);
      const text = clamp(NOTE_TEXT)(String(node.widgets_values[0] ?? "")).trim();
      if (at && text) {
        const f = r.frames[frameFor(r, at.scope, at.group)]!;
        f.note = f.note ? clamp(NOTE_TEXT)(`${f.note}\n\n${text}`) : text;
      }
    }
    const within = inside(r, scope, node);
    if (within) {
      const name = node.title ?? within.host!.def.name ?? "A group node";
      if (modeOf(node) === "bypass") r.note(`"${name}" is bypassed as a whole: what is inside it does not run, and each of its outputs hands on its input of the same kind.`);
      const fields = frontFields(within).length;
      // no values on the front at all, or values the file names one by one (proxyWidgets): nothing was read by guesswork
      if (Array.isArray(node.widgets_values) && node.widgets_values.length && !proxyOf(node)) {
        const extras = node.widgets_values.filter((v) => typeof v === "string" && AFTER_RUN.has(v)).length;
        if (node.widgets_values.length !== fields && node.widgets_values.length !== fields + extras) r.note(`"${name}" holds ${node.widgets_values.length} values for ${fields} fields on its front: some of them may have been read wrong.`);
      }
      const proxy = node.properties?.proxyWidgets;
      for (const entry of Array.isArray(proxy) ? proxy : []) {
        if (Array.isArray(entry) && entry.length >= 2) r.panel.push({ node: `${flatId(scope, node)}:${entry[0]}`, input: String(entry[1]) });
      }
      visitNodes(r, within);
      continue;
    }
    const kind = kindOf(r, node);
    if (kind === "switch") r.switches.push({ scope, node });
    if (kind !== "real") continue;

    const id = flatId(scope, node);
    const info = infoOf(r.catalog, node.type);
    const typed = literalsOf(node, info, r.note);
    const inputs: Record<string, unknown> = { ...typed };
    for (const socket of node.inputs ?? []) {
      if (socket.label) labels[`${id}.${socket.name}`] = socket.label;
      const from = fromLink(r, scope, socket.link, new Set());
      // a link that leads nowhere leaves the typed-in value, if there is one
      if (!from) continue;
      if ("literal" in from) {
        // a field that only exists in the editor (an upload button) is not an input of the node
        const real = !info || Object.hasOwn(info.input.required ?? {}, socket.name) || Object.hasOwn(info.input.optional ?? {}, socket.name) || takesAnyInput(node.type);
        if (!real) continue;
        if (from.literal !== undefined) inputs[socket.name] = from.literal;
        if (from.promoted) {
          r.promoted.set(from.promoted.key, [...(r.promoted.get(from.promoted.key) ?? []), { node: id, input: socket.name }]);
          if (from.promoted.label) labels[`${id}.${socket.name}`] ??= from.promoted.label;
        }
        continue;
      }
      if (Object.hasOwn(typed, socket.name)) (wiring.fallback[id] ??= record())[socket.name] = typed[socket.name];
      inputs[socket.name] = from.ref;
    }
    graph[id] = { class_type: node.type, inputs, _meta: { title: node.title ?? info?.display_name ?? node.type } } as GraphNode;
    wiring.slots[id] = { in: (node.inputs ?? []).map((s) => [s.name, typeName(s.type)]), out: (node.outputs ?? []).map((o) => typeName(o.type)) };
    // a linked input the node's kind does not declare required is optional: declared so, or added on the fly (rgthree's Any Switch, its any_01…)
    const loose = info ? Object.keys(inputs).filter((name) => isRef(inputs[name]) && !Object.hasOwn(info.input.required ?? {}, name)) : [];
    if (loose.length) wiring.optional[id] = loose;
    const off = scope.off ?? modeOf(node);
    if (off) wiring.modes[id] = off;
    const at = frameOf(scope, node);
    if (at) {
      r.groups[id] = at.group.title!;
      r.frames[frameFor(r, at.scope, at.group)]!.nodes.push(id);
    }
  }
}

// ---- switches: a node that turns the nodes wired into it on or off, by a yes/no value

/** The node a link comes from, through reroutes, and out of a group node when it comes in at its edge. */
function sourceNode(scope: Scope, linkId: number | null | undefined): { scope: Scope; node: ENode } | undefined {
  let s = scope;
  let id = linkId;
  for (let hops = 0; hops < 50 && id != null; hops++) {
    const link = s.links.get(id);
    const edge = edgeOf(s, link);
    if (edge) {
      s = edge.outer;
      id = edge.socket?.link;
      continue;
    }
    const node = link ? s.nodes.get(String(link.origin_id)) : undefined;
    if (!node || !REROUTES.has(node.type)) return node ? { scope: s, node } : undefined;
    id = node.inputs?.[0]?.link;
  }
  return undefined;
}

interface Root { key: string; value: boolean; label: string; write?: Target }
/** What a switch is called where it stands: its "enabled" socket's label, its title, the box it is in. */
const switchLabel = (scope: Scope, node: ENode) => node.inputs?.find((s) => s.name === "enabled")?.label ?? node.title ?? groupOf(scope, node) ?? "Switch";
function rootOf(r: Reading, scope: Scope, node: ENode, seen = new Set<string>()): Root {
  const id = flatId(scope, node);
  const socket = node.inputs?.find((s) => s.name === "enabled");
  const own: Root = {
    key: id,
    value: !Array.isArray(node.widgets_values) || node.widgets_values[0] !== false,
    label: switchLabel(scope, node),
  };
  if (socket?.link == null || seen.has(id)) return own;
  seen.add(id);
  return follow(r, scope, socket.link, own, seen);
}
/** What a switch's yes/no value comes from, followed out of group nodes as far as it goes. */
function follow(r: Reading, scope: Scope, linkId: number, own: Root, seen: Set<string>): Root {
  const edge = edgeOf(scope, scope.links.get(linkId));
  if (edge) {
    const named = { ...own, label: edge.socket?.label ?? own.label };
    if (edge.socket?.link != null) return follow(r, edge.outer, edge.socket.link, named, seen);
    const value = edge.key === undefined ? undefined : frontValues(scope).get(edge.key);
    // a field on the front of the group node: that field is the switch
    if (typeof value === "boolean" && edge.key !== undefined) return { ...named, key: `${flatId(edge.outer, edge.host)}.${edge.key}`, value };
  }
  const from = sourceNode(scope, linkId);
  if (!from) {
    r.note(`The switch "${own.label}" follows something Afflatus could not trace. It is read as it was set in the file.`);
    return own;
  }
  // a chain of switches follows the first one
  if (from.node.type === SWITCH) return rootOf(r, from.scope, from.node, seen);
  const fromId = flatId(from.scope, from.node);
  const held = Object.entries(r.graph[fromId]?.inputs ?? {}).find(([, v]) => typeof v === "boolean");
  if (!held) {
    r.note(`The switch "${own.label}" follows a node whose yes/no value Afflatus cannot read ("${from.node.title ?? from.node.type}"). It is read as it was set in the file.`);
    return own;
  }
  return { key: `${fromId}.${held[0]}`, value: held[1] as boolean, label: r.labels[`${fromId}.${held[0]}`] ?? from.node.title ?? own.label, write: { node: fromId, input: held[0] } };
}

function readSwitches(r: Reading): Toggle[] {
  const toggles = new Map<string, Toggle>();
  for (const { scope, node } of r.switches) {
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    let lost = 0;
    const nodes = (node.inputs ?? [])
      .filter((s) => s.name.startsWith("target_") && s.link != null)
      .flatMap((s) => {
        const target = sourceNode(scope, s.link);
        const id = target ? flatId(target.scope, target.node) : "";
        // a group node as a target means everything inside it
        const found = !target ? [] : inside(r, target.scope, target.node) ? Object.keys(r.graph).filter((k) => k.startsWith(`${id}:`)) : r.graph[id] ? [id] : [];
        if (!found.length) lost++;
        return found;
      });
    if (lost) r.note(`The switch "${switchLabel(scope, node)}" is wired to ${lost === 1 ? "a part" : `${lost} parts`} Afflatus could not trace: ${nodes.length ? "it switches the rest" : "it is left out"}.`);
    if (!nodes.length) continue;
    const root = rootOf(r, scope, node);
    const id = `sw_${root.key}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const toggle = toggles.get(id) ?? { id, ...splitCaptions(root.label.replace(/^[\s↳]+/, "")), default: root.value, effects: [], writes: root.write ? [root.write] : [], front: true };
    toggle.effects.push({ nodes, activeWhen: !String(values[1] ?? "true").startsWith("false"), mode: values[2] === "mute" ? "mute" : "bypass" });
    toggles.set(id, toggle);
  }
  return [...toggles.values()];
}

export function fromEditor(json: unknown, catalog: NodeCatalog): EditorFindings {
  // a copy, checked: reading writes the Anything Everywhere links into the sockets, and the file may be read again
  const parsed = editorFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UnreadableWorkflow(`This file could not be read as a workflow of ComfyUI's editor${issue ? ` (${issue.path.join(".") || "the file"}: ${issue.message})` : ""}.`);
  }
  const root = parsed.data;
  const notes: string[] = [];
  const labels = record<string>();
  const r: Reading = {
    catalog,
    defs: new Map((root.definitions?.subgraphs ?? []).map((d) => [d.id, d])),
    notes,
    note: (text: string) => void (notes.includes(text) || notes.push(text)),
    opened: new Map(),
    openedNodes: 0,
    setters: new Map(),
    graph: record(),
    wiring: { modes: record(), slots: record(), fallback: record(), labels, panel: [], toggles: [], shared: record(), packs: record(), downloads: record(), links: [], optional: record(), frames: [] },
    labels,
    groups: record(),
    panel: [],
    switches: [],
    promoted: new Map(),
    frames: [],
    frameIds: new Map(),
  };
  const top = scopeOf(root, [], []);
  openScopes(r, top);
  visitNodes(r, top);
  const { graph, wiring } = r;
  // a field on the front of a group node is one setting, however many inputs read it: the first stands for it
  for (const [first, ...rest] of r.promoted.values()) {
    if (!first) continue;
    r.panel.push(first);
    if (rest.length) wiring.shared[`${first.node}.${first.input}`] = rest;
  }
  wiring.toggles = readSwitches(r);
  // only what is a setting of a node: the panel can also list fields that exist in the editor alone
  wiring.panel = r.panel.filter((t) => graph[t.node] && Object.hasOwn(graph[t.node]!.inputs, t.input));
  // the editor applies its switches when it queues: what they say wins over how the nodes were saved
  wiring.modes = Object.assign(record<Mode>(), modesFor(wiring, wiring.toggles, {}));
  // the frames, each with the nodes it holds itself (not those of the frames drawn inside it) in the order they were met
  wiring.frames = r.frames;
  return { graph, wiring, groups: r.groups, notes };
}
