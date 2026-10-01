import { takesAnyInput, type Graph, type GraphNode, type NodeCatalog, type NodeInfo, type Ref } from "@studai/core";
import { isWidget, optsOf, typeOf } from "./catalog";
import { splitCaptions, type Mode, type Target, type Toggle, type Wiring } from "./types";
import { modesFor } from "./wiring";

/**
 * Reads the file ComfyUI's editor saves (the one in its workflows folder) and turns it into what
 * studai works with: every node with its typed-in values and links, in the flat form ComfyUI runs,
 * plus what only that file knows. Which nodes are switched off, the switches that turn parts on and
 * off, the names the author gave to settings, and the author's own control panel.
 *
 * ComfyUI has no service for this: its browser front end does the conversion when it queues or
 * exports. This follows that code (graphToPrompt, front end 1.53) for what it covers: group nodes
 * (subgraphs) are opened up, reroutes and other editor-only nodes are followed through, values are
 * matched to inputs by the node catalog. What it cannot read is said in `notes`, never guessed.
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

interface ESocket { name: string; type?: unknown; link?: number | null; widget?: { name?: string }; label?: string }
interface ENode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  pos?: unknown;
  inputs?: ESocket[];
  outputs?: Array<{ type?: unknown; links?: number[] | null }>;
  widgets_values?: unknown;
  properties?: Record<string, unknown>;
}
interface ELink { id: number; origin_id: number | string; origin_slot: number; target_id: number | string; target_slot: number }
interface EGraph { nodes?: ENode[]; links?: unknown[]; groups?: Array<{ title?: string; bounding?: number[] }> }
interface ESubgraph extends EGraph { id: string; inputNode?: { id: number }; outputNode?: { id: number }; outputs?: Array<{ linkIds?: number[] }> }

/** The editor's save has a list of nodes with positions and a list of links; an exported workflow has nodes by id. */
export function isEditorFormat(json: unknown): boolean {
  const raw = json as { nodes?: unknown; links?: unknown } | null;
  return Boolean(raw && typeof raw === "object" && Array.isArray(raw.nodes) && "links" in raw);
}

const SWITCH = "DaSiWa_NodeStatusSwitch";
const POWER_LORAS = "Power Lora Loader (rgthree)";
const NOTES = new Set(["Note", "MarkdownNote"]);
/** Nodes that exist only in the editor and stand for a link or a value. */
const VIRTUAL = new Set(["Reroute", "PrimitiveNode", "GetNode", "SetNode"]);
/** What the editor stores after a number that can change between runs. */
const AFTER_RUN = new Set(["fixed", "increment", "decrement", "randomize"]);

const modeOf = (node: ENode): Mode | undefined => (node.mode === 2 ? "mute" : node.mode === 4 ? "bypass" : undefined);
const typeName = (type: unknown) => (typeof type === "string" ? type : Array.isArray(type) ? "COMBO" : "*");
const parseLink = (raw: unknown): ELink | null => {
  if (Array.isArray(raw)) return { id: raw[0], origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4] };
  return raw && typeof raw === "object" && "id" in raw ? (raw as ELink) : null;
};
const fits = (type: string, value: unknown) =>
  type === "INT" || type === "FLOAT" ? typeof value === "number"
  : type === "STRING" ? typeof value === "string"
  : type === "BOOLEAN" ? typeof value === "boolean"
  : type === "COMBO" ? ["string", "number", "boolean"].includes(typeof value)
  : true;

/**
 * The typed-in values of a node, by input name. The file stores them as a bare list in the order the
 * editor shows them, so the names come from the node itself (newer files list them) or from the catalog.
 */
function literalsOf(node: ENode, info: NodeInfo | undefined, note: (text: string) => void): Record<string, unknown> {
  const saved = node.widgets_values;
  const all: Record<string, unknown> = { ...info?.input.required, ...info?.input.optional };
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
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    // saved by name (VideoHelperSuite). Plain values only: previews and the like are the editor's own
    return Object.fromEntries(Object.entries(saved).filter(([name, v]) => known(name) && v !== null && typeof v !== "object"));
  }
  if (!Array.isArray(saved)) return {};

  const fromFile = (node.inputs ?? []).flatMap((s) => (s.widget?.name ? [s.widget.name] : []));
  const fromCatalog = Object.entries(all).filter(([, spec]) => isWidget(spec)).map(([name]) => name);
  // the editor adds a "what to do after a run" field after a seed, and after any number that asks for one
  const changes = (name: string) => Boolean(optsOf(all[name]).control_after_generate) || (/^(noise_)?seed$/.test(name) && typeOf(all[name]) === "INT");
  // newer files list every field; older ones (and trimmed ones) only the linked fields
  const complete = fromFile.length > 0 && fromFile.length + fromFile.filter(changes).length >= saved.length;
  const names = complete || !fromCatalog.length ? fromFile : fromCatalog;

  const out: Record<string, unknown> = {};
  const gone: string[] = [];
  let i = 0;
  for (const name of names) {
    if (i >= saved.length) break;
    const value = saved[i++];
    if (known(name)) {
      if (value !== null && value !== undefined) out[name] = value;
    } else if (name !== "upload") gone.push(name);
    const next = saved[i];
    if (typeof next === "string" && AFTER_RUN.has(next) && (info ? changes(name) : typeof value === "number")) i++;
    else if (names === fromCatalog && optsOf(all[name]).image_upload && next === "image") i++;
  }
  // a field the node gained after the workflow was saved starts at its default, as in the editor
  for (const name of fromCatalog) {
    const preset = optsOf(all[name]).default;
    if (!(name in out) && preset !== undefined && preset !== null) out[name] = preset;
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
  nodes: Map<string, ENode>;
  links: Map<number, ELink>;
  groups: NonNullable<EGraph["groups"]>;
  /** Inside a group node: the node that stands for it one level up. */
  host?: { scope: Scope; node: ENode; def: ESubgraph };
  /** Off because a group node around it is off. */
  off?: Mode;
}
/** A setting shown on the front of a group node: one field there, read by one or more inputs inside. */
interface Promoted { key: string; label?: string }
type Origin = { ref: Ref } | { literal: unknown; promoted?: Promoted } | undefined;

/** The value typed into a field on the front of a group node (the file lists them in the order of its fields). */
function hostValue(host: ENode, slot: number): unknown {
  const socket = host.inputs?.[slot];
  const name = socket?.widget?.name;
  const saved = host.widgets_values;
  if (!socket || !name || !saved) return undefined;
  if (!Array.isArray(saved)) return (saved as Record<string, unknown>)[name];
  return saved[(host.inputs ?? []).filter((s) => s.widget?.name).indexOf(socket)];
}

export function fromEditor(json: unknown, catalog: NodeCatalog): EditorFindings {
  const root = json as EGraph & { definitions?: { subgraphs?: ESubgraph[] } };
  const defs = new Map((root.definitions?.subgraphs ?? []).map((d) => [d.id, d]));
  const notes: string[] = [];
  const note = (text: string) => void (notes.includes(text) || notes.push(text));

  const scopeOf = (g: EGraph, path: string[], host?: Scope["host"], off?: Mode): Scope => ({
    path, host, off,
    nodes: new Map((g.nodes ?? []).map((n) => [String(n.id), n])),
    links: new Map((g.links ?? []).flatMap((raw) => { const l = parseLink(raw); return l ? [[l.id, l] as const] : []; })),
    groups: g.groups ?? [],
  });
  const flatId = (scope: Scope, node: ENode) => [...scope.path, String(node.id)].join(":");
  const opened = new Map<string, Scope>();
  /** What is inside a group node, when the node is one. */
  const inside = (scope: Scope, node: ENode): Scope | undefined => {
    const def = defs.get(node.type);
    if (!def) return undefined;
    const id = flatId(scope, node);
    if (!opened.has(id)) opened.set(id, scopeOf(def, [...scope.path, String(node.id)], { scope, node, def }, scope.off ?? (modeOf(node) ? "mute" : undefined)));
    return opened.get(id);
  };
  const linked = (node: ENode) => (node.inputs ?? []).some((s) => s.link != null) || (node.outputs ?? []).some((o) => o.links?.length);
  const kindOf = (node: ENode): "real" | "switch" | "skip" => {
    if (node.type === SWITCH) return "switch";
    if (NOTES.has(node.type) || VIRTUAL.has(node.type)) return "skip";
    // labels, bookmarks and other things an extension draws on the canvas: unknown to ComfyUI and wired to nothing
    return catalog[node.type] || linked(node) ? "real" : "skip";
  };

  /** Where a link really comes from: a real node's output, or a value held by an editor-only node. */
  const fromLink = (scope: Scope, linkId: number | null | undefined, seen: Set<string>): Origin => {
    const link = linkId == null ? undefined : scope.links.get(linkId);
    if (!link) return undefined;
    // from the edge of a group node: what is plugged into that socket one level up
    if (scope.host && String(link.origin_id) === String(scope.host.def.inputNode?.id)) {
      const { node: host, scope: outer } = scope.host;
      const socket = host.inputs?.[link.origin_slot];
      if (socket?.link != null) return fromLink(outer, socket.link, seen);
      // nothing plugged in: the value typed on the front of the group node, when it has a field there
      const value = hostValue(host, link.origin_slot);
      return value === undefined || !socket ? undefined : { literal: value, promoted: { key: `${flatId(outer, host)}.${socket.name}`, label: socket.label } };
    }
    return fromOutput(scope, String(link.origin_id), link.origin_slot, seen);
  };
  const fromOutput = (scope: Scope, id: string, slot: number, seen: Set<string>): Origin => {
    const node = scope.nodes.get(id);
    const key = `${[...scope.path, id].join(":")}:${slot}`;
    if (!node || seen.has(key)) return undefined;
    seen.add(key);
    const within = inside(scope, node);
    if (within) {
      // the group node says which link feeds each of its outputs; a file can also hold links left over from deleted nodes
      const def = within.host!.def;
      const edge = String(def.outputNode?.id);
      const listed = (def.outputs?.[slot]?.linkIds ?? []).map((id) => within.links.get(id)).find((l) => l && within.nodes.has(String(l.origin_id)) || String(l?.origin_id) === String(def.inputNode?.id));
      const link = listed ?? [...within.links.values()].find((l) => String(l.target_id) === edge && l.target_slot === slot && within.nodes.has(String(l.origin_id)));
      return fromLink(within, link?.id, seen);
    }
    if (node.type === "Reroute" || node.type === "SetNode") return fromLink(scope, node.inputs?.[0]?.link, seen);
    const first = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
    if (node.type === "PrimitiveNode") return { literal: first };
    if (node.type === "GetNode") {
      // reads what a "Set" node of the same name was given
      const setter = [...scope.nodes.values()].find((n) => n.type === "SetNode" && Array.isArray(n.widgets_values) && n.widgets_values[0] === first);
      return fromLink(scope, setter?.inputs?.[0]?.link, seen);
    }
    return kindOf(node) === "real" ? { ref: [flatId(scope, node), slot] } : undefined;
  };

  const graph: Graph = {};
  const labels: Record<string, string> = {};
  const wiring: Wiring = { modes: {}, slots: {}, fallback: {}, labels, panel: [], toggles: [], shared: {}, packs: {}, downloads: {}, links: [] };
  /** What a node says about where it and its files come from, and the links written in notes. */
  const sources = (node: ENode) => {
    const pack = node.properties?.cnr_id;
    if (typeof pack === "string" && pack && pack !== "comfy-core") wiring.packs[node.type] = pack;
    for (const m of (node.properties?.models as Array<{ name?: unknown; url?: unknown }> | undefined) ?? []) {
      if (typeof m?.name === "string" && typeof m.url === "string" && /^https?:\/\//.test(m.url)) wiring.downloads[m.name] = m.url;
    }
    if (!NOTES.has(node.type) || !Array.isArray(node.widgets_values)) return;
    for (const [, label, url] of String(node.widgets_values[0] ?? "").matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      if (wiring.links.length < 80 && !wiring.links.some((l) => l.url === url)) wiring.links.push({ label: label!.trim(), url: url! });
    }
  };
  const groups: Record<string, string> = {};
  const panel: Target[] = [];
  const switches: Array<{ scope: Scope; node: ENode }> = [];
  /** Field on the front of a group node → the inputs inside that read it, in the order they were met. */
  const promoted = new Map<string, Target[]>();

  /** The innermost box drawn around a node. */
  const groupOf = (scope: Scope, node: ENode): string | undefined => {
    const pos = node.pos as Record<number, number> | undefined;
    if (!pos || typeof pos[0] !== "number" || typeof pos[1] !== "number") return undefined;
    const around = scope.groups.filter((g) => {
      const [x = 0, y = 0, w = 0, h = 0] = g.bounding ?? [];
      return g.title && pos[0]! >= x && pos[0]! <= x + w && pos[1]! >= y && pos[1]! <= y + h;
    });
    return around.sort((a, b) => a.bounding![2]! * a.bounding![3]! - b.bounding![2]! * b.bounding![3]!)[0]?.title;
  };

  const visit = (scope: Scope) => {
    for (const node of scope.nodes.values()) {
      sources(node);
      const within = inside(scope, node);
      if (within) {
        if (modeOf(node) === "bypass") note(`"${node.title ?? "A group node"}" is bypassed as a whole. studai treats everything inside it as switched off.`);
        const fields = (node.inputs ?? []).filter((s) => s.widget?.name).length;
        if (Array.isArray(node.widgets_values) && node.widgets_values.length !== fields) note(`"${node.title ?? "A group node"}" holds ${node.widgets_values.length} values for ${fields} fields on its front: some of them may have been read wrong.`);
        for (const entry of (node.properties?.proxyWidgets as unknown[] | undefined) ?? []) {
          if (Array.isArray(entry) && entry.length >= 2) panel.push({ node: `${flatId(scope, node)}:${entry[0]}`, input: String(entry[1]) });
        }
        visit(within);
        continue;
      }
      const kind = kindOf(node);
      if (kind === "switch") switches.push({ scope, node });
      if (kind !== "real") continue;

      const id = flatId(scope, node);
      const info = catalog[node.type];
      const typed = literalsOf(node, info, note);
      const inputs: Record<string, unknown> = { ...typed };
      for (const socket of node.inputs ?? []) {
        if (socket.label) labels[`${id}.${socket.name}`] = socket.label;
        const from = fromLink(scope, socket.link, new Set());
        // a link that leads nowhere leaves the typed-in value, if there is one
        if (!from) continue;
        if ("literal" in from) {
          // a field that only exists in the editor (an upload button) is not an input of the node
          const real = !info || socket.name in { ...info.input.required, ...info.input.optional } || takesAnyInput(node.type);
          if (!real) continue;
          if (from.literal !== undefined) inputs[socket.name] = from.literal;
          if (from.promoted) {
            promoted.set(from.promoted.key, [...(promoted.get(from.promoted.key) ?? []), { node: id, input: socket.name }]);
            if (from.promoted.label) labels[`${id}.${socket.name}`] ??= from.promoted.label;
          }
          continue;
        }
        if (socket.name in typed) (wiring.fallback[id] ??= {})[socket.name] = typed[socket.name];
        inputs[socket.name] = from.ref;
      }
      graph[id] = { class_type: node.type, inputs, _meta: { title: node.title ?? info?.display_name ?? node.type } } as GraphNode;
      wiring.slots[id] = { in: (node.inputs ?? []).map((s) => [s.name, typeName(s.type)]), out: (node.outputs ?? []).map((o) => typeName(o.type)) };
      const off = scope.off ?? modeOf(node);
      if (off) wiring.modes[id] = off;
      const group = groupOf(scope, node);
      if (group) groups[id] = group;
    }
  };
  visit(scopeOf(root, []));
  // a field on the front of a group node is one setting, however many inputs read it: the first stands for it
  for (const [first, ...rest] of promoted.values()) {
    if (!first) continue;
    panel.push(first);
    if (rest.length) wiring.shared[`${first.node}.${first.input}`] = rest;
  }

  // ---- switches: a node that turns the nodes wired into it on or off, by a yes/no value
  /** The node a link comes from, through reroutes, within one level. */
  const sourceNode = (scope: Scope, linkId: number | null | undefined): ENode | undefined => {
    let node = scope.nodes.get(String(scope.links.get(linkId ?? -1)?.origin_id));
    for (let hops = 0; node?.type === "Reroute" && hops < 50; hops++) node = scope.nodes.get(String(scope.links.get(node.inputs?.[0]?.link ?? -1)?.origin_id));
    return node;
  };
  interface Root { key: string; value: boolean; label: string; write?: Target }
  const rootOf = (scope: Scope, node: ENode, seen = new Set<string>()): Root => {
    const id = flatId(scope, node);
    const socket = node.inputs?.find((s) => s.name === "enabled");
    const own: Root = {
      key: id,
      value: !Array.isArray(node.widgets_values) || node.widgets_values[0] !== false,
      label: socket?.label ?? node.title ?? groupOf(scope, node) ?? "Switch",
    };
    if (socket?.link == null || seen.has(id)) return own;
    seen.add(id);
    return follow(scope, socket.link, own, seen);
  };
  /** What a switch's yes/no value comes from, followed out of group nodes as far as it goes. */
  const follow = (scope: Scope, linkId: number, own: Root, seen: Set<string>): Root => {
    const link = scope.links.get(linkId);
    if (scope.host && link && String(link.origin_id) === String(scope.host.def.inputNode?.id)) {
      const { node: host, scope: outer } = scope.host;
      const socket = host.inputs?.[link.origin_slot];
      const named = { ...own, label: socket?.label ?? own.label };
      if (socket?.link != null) return follow(outer, socket.link, named, seen);
      const value = hostValue(host, link.origin_slot);
      // a field on the front of the group node: that field is the switch
      if (typeof value === "boolean" && socket) return { ...named, key: `${flatId(outer, host)}.${socket.name}`, value };
    }
    const from = sourceNode(scope, linkId);
    if (!from) {
      note(`The switch "${own.label}" follows something studai could not trace. It is read as it was set in the file.`);
      return own;
    }
    // a chain of switches follows the first one
    if (from.type === SWITCH) return rootOf(scope, from, seen);
    const fromId = flatId(scope, from);
    const held = Object.entries(graph[fromId]?.inputs ?? {}).find(([, v]) => typeof v === "boolean");
    if (!held) {
      note(`The switch "${own.label}" follows a node whose yes/no value studai cannot read ("${from.title ?? from.type}"). It is read as it was set in the file.`);
      return own;
    }
    return { key: `${fromId}.${held[0]}`, value: held[1] as boolean, label: labels[`${fromId}.${held[0]}`] ?? from.title ?? own.label, write: { node: fromId, input: held[0] } };
  };

  const toggles = new Map<string, Toggle>();
  for (const { scope, node } of switches) {
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const nodes = (node.inputs ?? [])
      .filter((s) => s.name.startsWith("target_") && s.link != null)
      .flatMap((s) => {
        const target = sourceNode(scope, s.link);
        if (!target) return [];
        const id = flatId(scope, target);
        // a group node as a target means everything inside it
        return inside(scope, target) ? Object.keys(graph).filter((k) => k.startsWith(`${id}:`)) : graph[id] ? [id] : [];
      });
    if (!nodes.length) continue;
    const root = rootOf(scope, node);
    const id = `sw_${root.key}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const toggle = toggles.get(id) ?? { id, ...splitCaptions(root.label.replace(/^[\s↳]+/, "")), default: root.value, effects: [], writes: root.write ? [root.write] : [], front: true };
    toggle.effects.push({ nodes, activeWhen: !String(values[1] ?? "true").startsWith("false"), mode: values[2] === "mute" ? "mute" : "bypass" });
    toggles.set(id, toggle);
  }
  wiring.toggles = [...toggles.values()];
  // only what is a setting of a node: the panel can also list fields that exist in the editor alone
  wiring.panel = panel.filter((t) => t.input in (graph[t.node]?.inputs ?? {}));
  // the editor applies its switches when it queues: what they say wins over how the nodes were saved
  wiring.modes = modesFor(wiring, wiring.toggles, {});

  return { graph, wiring, groups, notes };
}
